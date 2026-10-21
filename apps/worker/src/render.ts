import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BUILTIN_MUSIC_SHA256, builtinMusicWav } from "@incubrix/media";
import { Timeline } from "@incubrix/contracts";
import { timelineHash } from "@incubrix/engine";
import { ApiError, errorBody, type ErrorCode } from "@incubrix/errors";
import {
  RenderError, childCpuSeconds, decideProxy, ffmpegVersion, makeProxy, probeStreams, renderTimeline, sha256File, type RenderResult,
} from "@incubrix/render";
import { getToFile, presignGet, putFile, putText, sha256OfObject } from "@incubrix/storage";
import {
  buildManifest, contextOf, failJob, getSession, getTranscript, getVideo, mergeProbe, setProgress, succeedJob,
  type JobRow, type VideoRow,
} from "@incubrix/store";
import type { Atom } from "@incubrix/contracts";
import type { WorkerDeps } from "./intake.ts";
import { deliverCallback } from "./intake.ts";

/** Where a render's files live in storage. */
export const renderKeys = (jobId: string) => ({ video: `renders/${jobId}/output.mp4`, manifest: `renders/${jobId}/render_manifest.json` });

const FONT_NOTE = "DejaVu Sans / DejaVu Sans Bold (Bitstream Vera + public-domain changes licence; commercial use allowed), see SOURCES.md";

interface ProxyInfo {
  storage_key: string;
  sha256: string;
  reasons: string[];
  colour: string;
  fps: string;
  created_by: string;
  warnings: string[];
}

function failureOf(e: unknown): { code: ErrorCode; body: ReturnType<typeof errorBody> } {
  if (e instanceof ApiError) return { code: e.code, body: e.body() };
  if (e instanceof RenderError) return { code: e.code, body: errorBody(e.code, e.message, e.details) };
  return { code: "RENDER_FAILED", body: errorBody("RENDER_FAILED", (e as Error).message ?? "render failed") };
}

/**
 * Render job. The request holds a SNAPSHOT of the timeline taken when the render was asked for (and its hash), so edits
 * made later do not change what this job produces.
 * Order: check the stored original (sha256) -> proxy if the source needs one -> ONE ffmpeg run -> verify the file against
 * the timeline -> check the stored original again -> upload video + manifest.
 */
export async function runRender(d: WorkerDeps, job: JobRow): Promise<void> {
  const log = d.log.child({ job_id: job.id });
  const t0 = performance.now();
  const cpu0 = process.cpuUsage();
  const childCpu0 = childCpuSeconds();
  const timings: Record<string, number | null> = {};
  const lap = (name: string, since: number): number => ((timings[name] = Math.round(((performance.now() - since) / 1000) * 1000) / 1000), performance.now());
  const dir = await mkdtemp(join(d.cfg.RENDER_TMP_DIR, "incubrix-render-"));
  const bucket = d.cfg.S3_BUCKET;
  try {
    const req = job.request as { session_id: string; timeline: unknown; timeline_hash: string } | null;
    if (!req) throw new RenderError("RENDER_FAILED", "the render job has no request");
    const tl = Timeline.parse(req.timeline);
    if (timelineHash(tl) !== req.timeline_hash) throw new RenderError("RENDER_FAILED", "the stored timeline does not match its hash");
    const session = await getSession(d.pool, req.session_id);
    if (!session) throw new RenderError("RENDER_FAILED", `session ${req.session_id} no longer exists`);
    const video = (await getVideo(d.pool, session.video_id)) as VideoRow;
    if (!video.storage_key || !video.sha256 || !video.probe) throw new RenderError("RENDER_FAILED", "the video has no stored original");
    const transcript = video.transcript_key ? await getTranscript(d.pool, video.transcript_key) : null;
    if (!transcript) throw new RenderError("RENDER_FAILED", "the video has no transcript");
    const ctx = contextOf(video, transcript.atoms as Atom[], d.cfg.MAX_SPEED);
    if (tl.sourceSha256 !== video.sha256) throw new RenderError("SOURCE_CHANGED", "the timeline belongs to a different source file");
    const warnings: string[] = [...video.warnings];

    // 1. fetch the original and check it against the hash recorded at intake
    let mark = performance.now();
    const original = join(dir, "original" + (video.storage_key.endsWith(".mov") ? ".mov" : ".mp4"));
    await getToFile(d.s3, bucket, video.storage_key, original);
    const shaBefore = await sha256File(original);
    if (shaBefore !== video.sha256) throw new RenderError("SOURCE_CHANGED", "the stored original does not match the sha256 recorded at intake", { expected: video.sha256, actual: shaBefore });
    mark = lap("fetch_original_s", mark);
    await setProgress(d.pool, job.id, 5);

    // 2. does this source need a constant-frame-rate H.264 proxy (VFR, 10-bit/HDR, HEVC...)?
    const facts = await probeStreams(original);
    const fps = ctx.fps;
    if (!fps) throw new RenderError("RENDER_FAILED", "the source has no frame rate");
    const vfr = ctx.source.variableFrameRate;
    const decision = decideProxy(facts, vfr);
    const startGapUs = facts.videoStartUs - facts.audioStartUs;
    const frameUs = (1_000_000 * fps.den) / fps.num;
    if (Math.abs(startGapUs) > frameUs / 2) warnings.push(`video starts ${(startGapUs / 1000).toFixed(0)} ms after the audio in the original; the render keeps that offset${decision.needed ? "" : " (single-group mode, slower for many cuts)"}.`);
    let proxyInfo: ProxyInfo | null = null;
    let videoFile = original;
    // Aligned = the video starts within half a frame of the audio: both are cut from their own container times (seeks).
    // Not aligned = single-group mode with the video clock shifted by the gap (no seeking); a proxy removes the gap.
    const aligned = Math.abs(startGapUs) <= frameUs / 2;
    let videoOffsetUs = aligned ? 0 : startGapUs;
    let videoBaseUs = facts.videoStartUs;
    if (decision.needed) {
      const cached = (video.probe as { proxy?: ProxyInfo }).proxy;
      const proxyPath = join(dir, "proxy_cfr.mp4");
      if (cached) {
        await getToFile(d.s3, bucket, cached.storage_key, proxyPath);
        if ((await sha256File(proxyPath)) !== cached.sha256) throw new RenderError("RENDER_FAILED", "the stored CFR proxy does not match its recorded sha256");
        proxyInfo = cached;
        log.info({ video_id: video.id }, "using the stored CFR proxy");
      } else {
        const made = await makeProxy({
          original, out: proxyPath, facts, vfr, fps, offsetUs: aligned ? 0 : startGapUs,
          onProgress: (us) => void setProgress(d.pool, job.id, 5 + Math.min(1, us / ctx.source.durationUs) * 30).catch(() => undefined),
        });
        const key = `videos/${video.id}/proxy_cfr.mp4`;
        await putFile(d.s3, bucket, key, proxyPath, "video/mp4");
        proxyInfo = {
          storage_key: key, sha256: made.sha256, reasons: made.decision.reasons, colour: made.decision.colour, fps: `${fps.num}/${fps.den}`,
          created_by: await ffmpegVersion(), warnings: made.warnings,
        };
        await mergeProbe(d.pool, video.id, { proxy: proxyInfo });
        log.info({ video_id: video.id, reasons: made.decision.reasons }, "CFR proxy created");
      }
      warnings.push(...proxyInfo.warnings);
      videoFile = proxyPath;
      videoOffsetUs = 0; // the proxy is already on the atom clock
      videoBaseUs = 0;
      mark = lap("proxy_s", mark);
    }
    await setProgress(d.pool, job.id, 35);

    // 3. music file, if the timeline has music
    let musicFile: string | null = null;
    if (tl.music) {
      musicFile = join(dir, "music.wav");
      if (tl.music.assetSha256 === BUILTIN_MUSIC_SHA256) await writeFile(musicFile, builtinMusicWav());
      else {
        try {
          await getToFile(d.s3, bucket, `assets/music/${tl.music.assetSha256}`, musicFile);
        } catch {
          throw new RenderError("RENDER_FAILED", `the music asset ${tl.music.assetSha256} is not in storage`);
        }
        if ((await sha256File(musicFile)) !== tl.music.assetSha256) throw new RenderError("RENDER_FAILED", "the stored music asset does not match its sha256");
      }
    }

    // 4. ONE ffmpeg run, then ffprobe on the result
    const out = join(dir, "output.mp4");
    const rendered: RenderResult = await renderTimeline({
      ctx, tl, videoFile, audioFile: original, musicFile, width: facts.width, height: facts.height, audioChannels: facts.audioChannels,
      videoBaseUs, audioBaseUs: facts.audioStartUs, videoOffsetUs, groupPieces: d.cfg.RENDER_GROUP_PIECES, maxGroups: d.cfg.RENDER_MAX_GROUPS, out, workDir: join(dir, "work"),
      settings: { preset: d.cfg.RENDER_PRESET, crf: d.cfg.RENDER_CRF, maxHeight: d.cfg.RENDER_MAX_HEIGHT },
      onProgress: (pct) => void setProgress(d.pool, job.id, 35 + (pct / 100) * 55).catch(() => undefined),
    });
    mark = lap("render_s", mark);
    if (!rendered.verification.ok) throw new RenderError("RENDER_VERIFY_FAILED", `the rendered file does not match the timeline: ${rendered.verification.problems.join("; ")}`, { verification: rendered.verification });
    warnings.push(...rendered.graph.warnings);

    // 5. the original must be byte-identical afterwards: the local copy ffmpeg read, AND the stored object
    const localAfter = await sha256File(original);
    const storedAfter = await sha256OfObject(d.s3, bucket, video.storage_key);
    if (localAfter !== video.sha256 || storedAfter !== video.sha256) throw new RenderError("SOURCE_CHANGED", "the original's sha256 changed during the render", { before: video.sha256, local_after: localAfter, stored_after: storedAfter });
    mark = lap("verify_s", mark);
    await setProgress(d.pool, job.id, 93);

    // 6. upload
    const keys = renderKeys(job.id);
    const outSize = (await stat(out)).size;
    await putFile(d.s3, bucket, keys.video, out, "video/mp4");
    mark = lap("upload_s", mark);
    timings.total_s = Math.round(((performance.now() - t0) / 1000) * 1000) / 1000;
    const outSeconds = tl.durationUs / 1e6;
    const cpu = process.cpuUsage(cpu0);
    const cpuSeconds = (cpu.user + cpu.system) / 1e6 + (childCpuSeconds() - childCpu0);
    const manifest = {
      ...buildManifest({
        providers: {
          media: { ffmpeg: rendered.ffmpeg },
          video_codec: { name: "libx264", note: "H.264 (GPL libx264 inside the ffmpeg build; used as an external program, not linked)" },
          audio_codec: { name: "aac (ffmpeg native encoder)" },
          font: FONT_NOTE,
          music: tl.music ? { asset_sha256: tl.music.assetSha256, builtin: tl.music.assetSha256 === BUILTIN_MUSIC_SHA256, note: "programmatic sine-wave pad, not an AI model" } : null,
        },
        settings: {
          preset: d.cfg.RENDER_PRESET, crf: d.cfg.RENDER_CRF, max_height: d.cfg.RENDER_MAX_HEIGHT, pix_fmt: "yuv420p", movflags: "+faststart",
          fps: `${fps.num}/${fps.den}`, audio: "aac 192k 48 kHz stereo", bleep: "1 kHz sine, level 0.25", caption_size: "sizePt relative to a 720-line frame",
        },
        timings,
        cpuSeconds,
        warnings,
        rights: video.rights,
        aiGeneratedInput: video.ai_generated,
        aiFlags: { transcript_words: true, captions_text_is_user_text: false, music: false },
      }),
      render: {
        job_id: job.id, session_id: session.id, timeline_hash: req.timeline_hash,
        source: { video_id: video.id, sha256_before: shaBefore, sha256_after_local: localAfter, sha256_after_stored: storedAfter, unchanged: true },
        proxy: proxyInfo,
        pieces: rendered.graph.pieces, filter_script_sha256: rendered.graphScriptSha256,
        timeline_frames: rendered.verification.timelineFrames, rendered_frames: rendered.verification.renderedFrames,
        frame_difference: rendered.verification.frameDifference, audio_minus_video_frames: Number(rendered.verification.audioVsVideoFrames.toFixed(3)),
        output: { ...rendered.output, size_bytes: outSize, seconds: outSeconds },
        ffmpeg_peak_rss_mb: rendered.peakRssMb,
        render_seconds_per_output_minute: outSeconds > 0 ? Math.round((rendered.elapsedMs / 1000 / (outSeconds / 60)) * 10) / 10 : null,
      },
    };
    await putText(d.s3, bucket, keys.manifest, JSON.stringify(manifest, null, 2));
    const s3Public = d.s3Public ?? d.s3;
    await succeedJob(d.pool, job.id, {
      session_id: session.id, timeline_hash: req.timeline_hash, duration_s: outSeconds, frames: rendered.verification.renderedFrames, size_bytes: outSize,
      outputs: keys,
      links: { video: await presignGet(s3Public , bucket, keys.video, 3600), manifest: await presignGet(s3Public , bucket, keys.manifest, 3600) },
      warnings, manifest,
    });
    log.info({ session_id: session.id, frames: rendered.verification.renderedFrames, timings }, "render succeeded");
  } catch (e) {
    const f = failureOf(e);
    log.error({ code: f.code, err: (e as Error).message }, "render failed");
    await failJob(d.pool, job.id, f.body);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  await deliverCallback(d, job.id);
}

