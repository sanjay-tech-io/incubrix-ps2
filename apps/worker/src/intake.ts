import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Config } from "@incubrix/config";
import type { Atom, Source } from "@incubrix/contracts";
import { ApiError, errorBody, type ErrorCode } from "@incubrix/errors";
import { detectSilence, probe } from "@incubrix/media";
import { getToFile, putFile } from "@incubrix/storage";
import {
  buildManifest, failJob, getJob, getTranscript, getVideo, jobView, putTranscript, setProgress, succeedJob, transcriptCacheKey, updateVideo,
  type JobRow, type Logger, type TranscriptSettings,
} from "@incubrix/store";
import type pg from "pg";
import type { AsrClient } from "./asr.ts";
import { atomsFromAsr } from "./atoms.ts";
import { sendCallback } from "./callback.ts";
import { downloadUrl } from "./download.ts";

const run = promisify(execFile);

export interface WorkerDeps {
  pool: pg.Pool;
  s3: S3Client;
  cfg: Config;
  asr: AsrClient;
  log: Logger;
}

// Versions pinned in services/asr/requirements.txt; reported in the manifest.
const PINNED = { "faster-whisper": "1.2.1", ctranslate2: "4.8.3", "sherpa-onnx": "1.13.8" } as const;
// ASR + diarization real-time factors measured in the B2 pass (docs/REVIEW_INFRA.md): 0.20 + 0.41. Used ONLY to pace the
// progress bar inside the ASR stage (the service gives no progress); the bar never claims more than 95% of that stage.
const EXPECTED_ASR_RTF = 0.7;

/** MP4 and MOV both start with a box whose type at bytes 4-8 is "ftyp". */
export function looksLikeMp4OrMov(head: Uint8Array): boolean {
  return head.length >= 12 && String.fromCharCode(head[4]!, head[5]!, head[6]!, head[7]!) === "ftyp";
}

async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const c of createReadStream(path)) h.update(c as Buffer);
  return h.digest("hex");
}

async function readHead(path: string): Promise<Uint8Array> {
  const f = await open(path, "r");
  try {
    const b = Buffer.alloc(16);
    const { bytesRead } = await f.read(b, 0, 16, 0);
    return b.subarray(0, bytesRead);
  } finally {
    await f.close();
  }
}

let ffmpegVersion: string | null = null;
async function getFfmpegVersion(): Promise<string> {
  if (!ffmpegVersion) ffmpegVersion = (await run("ffmpeg", ["-version"])).stdout.split("\n")[0] ?? "unknown";
  return ffmpegVersion;
}

function failureOf(e: unknown): { code: ErrorCode; body: ReturnType<typeof errorBody> } {
  if (e instanceof ApiError) return { code: e.code, body: e.body() };
  return { code: "INTERNAL_ERROR", body: errorBody("INTERNAL_ERROR", (e as Error).message ?? "unexpected error") };
}

/** Run one intake job: store original -> probe -> audio -> ASR + diarization (or cache) -> silence -> clamp -> atoms. */
export async function runIntake(d: WorkerDeps, job: JobRow): Promise<void> {
  const log = d.log.child({ job_id: job.id });
  const t0 = performance.now();
  const cpu0 = process.cpuUsage();
  const timings: Record<string, number | null> = {};
  const lap = (name: string, since: number): number => ((timings[name] = Math.round(((performance.now() - since) / 1000) * 1000) / 1000), performance.now());
  const dir = await mkdtemp(join(tmpdir(), "incubrix-intake-"));
  const videoId = job.video_id!;
  try {
    const video = await getVideo(d.pool, videoId);
    if (!video) throw new ApiError("VIDEO_NOT_FOUND", `video ${videoId} does not exist`);
    const original = join(dir, "original");
    let mark = performance.now();

    // 1. the original: from S3 (upload) or from the URL (stored to S3 here). It is never modified.
    let sha256: string;
    if (video.storage_key) {
      await getToFile(d.s3, d.cfg.S3_BUCKET, video.storage_key, original);
      sha256 = await sha256File(original);
      if (video.sha256 && video.sha256 !== sha256) throw new Error("the stored original does not match its recorded sha256");
    } else {
      const got = await downloadUrl(video.source_url!, original, { maxBytes: d.cfg.MAX_UPLOAD_MB * 1024 * 1024, allowPrivate: d.cfg.URL_ALLOW_PRIVATE });
      if (!looksLikeMp4OrMov(await readHead(original))) throw new ApiError("UNSUPPORTED_MEDIA_TYPE", "The downloaded file is not an MP4 or MOV video.");
      sha256 = got.sha256;
      const ext = /\.mov(\?|$)/i.test(video.source_url!) ? ".mov" : ".mp4";
      const key = `videos/${video.id}/original${ext}`;
      await putFile(d.s3, d.cfg.S3_BUCKET, key, original, ext === ".mov" ? "video/quicktime" : "video/mp4");
      await updateVideo(d.pool, video.id, { sha256, storageKey: key, sizeBytes: got.size, mimeType: got.contentType ?? "video/mp4" });
    }
    mark = lap("fetch_original_s", mark);
    await setProgress(d.pool, job.id, 15);

    // 2. probe
    const p = await probe(original);
    mark = lap("probe_s", mark);
    if (!p.hasAudio) throw new ApiError("NO_AUDIO_TRACK", "This video has no audio track, so there is nothing to transcribe.");
    const warnings: string[] = [];
    if (!p.hasVideo) warnings.push("The file has no video stream; only audio will be edited.");
    const fps = p.video ? { num: p.video.fps.num, den: p.video.fps.den } : null;
    if (p.video?.isVfr) {
      warnings.push(
        `Variable frame rate detected. Times are exact for the original's timestamps, but frame-accurate cuts need a constant-frame-rate proxy at ${fps!.num}/${fps!.den} fps, which the renderer builds from the original (M3, not built yet).`,
      );
    }
    const source: Source = { sha256, durationUs: p.durationUs, fps, hasAudio: true, hasVideo: p.hasVideo, variableFrameRate: p.video?.isVfr ?? false };
    await setProgress(d.pool, job.id, 25);

    // 3. transcript: cache hit or ASR
    const settings: TranscriptSettings = {
      asrProvider: d.asr.provider, asrModel: d.asr.model, diarizationProvider: d.asr.diarizationProvider, numSpeakers: video.num_speakers_hint,
      silenceNoiseDb: d.cfg.SILENCE_NOISE_DB, silenceMinUs: d.cfg.SILENCE_MIN_MS * 1000, clampMinWordUs: d.cfg.CLAMP_MIN_WORD_MS * 1000, lowConfidencePermille: d.cfg.LOW_CONFIDENCE_PERMILLE,
    };
    const cacheKey = transcriptCacheKey(sha256, settings);
    let atoms: Atom[];
    let cache: "hit" | "miss" = "miss";
    let asrManifest: Record<string, unknown> = {};
    let asrSeconds = 0;
    const cached = await getTranscript(d.pool, cacheKey);
    if (cached) {
      cache = "hit";
      atoms = cached.atoms;
      asrManifest = (cached.manifest.asr as Record<string, unknown> | undefined) ?? {};
      warnings.push(...(((cached.manifest.warnings as string[] | undefined) ?? []).filter((w) => !warnings.includes(w))));
      await setProgress(d.pool, job.id, 90);
    } else {
      const wav = join(dir, "audio.wav");
      await run("ffmpeg", ["-v", "error", "-y", "-i", original, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], { maxBuffer: 16 * 1024 * 1024 });
      await setProgress(d.pool, job.id, 35);
      mark = performance.now();
      const expectedMs = Math.max(5000, (p.durationUs / 1000) * EXPECTED_ASR_RTF);
      const started = performance.now();
      const timer = setInterval(() => {
        const frac = Math.min(0.95, (performance.now() - started) / expectedMs);
        void setProgress(d.pool, job.id, 35 + 45 * frac).catch(() => undefined);
      }, 1000);
      let asr;
      try {
        asr = await d.asr.transcribe(await readFile(wav), { numSpeakers: video.num_speakers_hint });
      } finally {
        clearInterval(timer);
      }
      mark = lap("asr_s", mark);
      asrSeconds = asr.serviceSeconds;
      await setProgress(d.pool, job.id, 80);
      if (asr.words.length === 0) throw new ApiError("TRANSCRIPTION_FAILED", "No speech was found in the audio.");

      const silences = await detectSilence(original, { noiseDb: settings.silenceNoiseDb, minDurationUs: settings.silenceMinUs });
      mark = lap("silence_s", mark);
      const built = atomsFromAsr(sha256, p.durationUs, asr.words, silences, { clampMinWordUs: settings.clampMinWordUs, lowConfidencePermille: settings.lowConfidencePermille });
      atoms = built.atoms;
      warnings.push(...built.warnings);
      const speakers = new Set(atoms.map((a) => a.speaker).filter((s) => s !== null));
      asrManifest = { provider: asr.provider, model: asr.model, speakers_found: asr.speakersFound ?? speakers.size, silences_found: silences.length, stats: built.stats, service_timings: asr.timings };
      await putTranscript(d.pool, {
        cache_key: cacheKey, source_sha256: sha256, settings,
        atoms, manifest: { asr: asrManifest, warnings: built.warnings, created_with: { pinned: PINNED } },
      });
    }
    const speakersFound = new Set(atoms.map((a) => a.speaker).filter((s) => s !== null)).size;
    if (speakersFound > 1 && video.num_speakers_hint === null) warnings.push(`${speakersFound} speakers were detected; if that is wrong, upload again with the num_speakers hint.`);
    if (atoms.some((a) => a.overlapsSpeech)) warnings.push("Some words overlap another speaker; edits touching them will warn.");

    // 4. done
    await updateVideo(d.pool, video.id, {
      status: "ready", transcriptKey: cacheKey, warnings,
      probe: { duration_us: p.durationUs, duration_s: p.durationUs / 1e6, fps, has_audio: true, has_video: p.hasVideo, variable_frame_rate: source.variableFrameRate, width: p.video?.width ?? null, height: p.video?.height ?? null, sha256 },
    });
    timings.total_s = Math.round(((performance.now() - t0) / 1000) * 1000) / 1000;
    const cpu = process.cpuUsage(cpu0);
    const manifest = buildManifest({
      providers: {
        asr: { provider: d.asr.provider, model: d.asr.model, version: d.asr.provider === "faster-whisper" ? `faster-whisper ${PINNED["faster-whisper"]} / ctranslate2 ${PINNED.ctranslate2}` : "fixture", cache },
        diarization: { provider: d.asr.diarizationProvider, version: d.asr.diarizationProvider === "sherpa" ? `sherpa-onnx ${PINNED["sherpa-onnx"]} + pyannote-segmentation-3.0 + wespeaker_en_voxceleb_resnet34` : "fixture" },
        media: { ffmpeg: await getFfmpegVersion() },
      },
      settings: { ...settings, transcript_cache_key: cacheKey, asr_details: asrManifest },
      timings,
      cpuSeconds: (cpu.user + cpu.system) / 1e6 + asrSeconds,
      warnings,
      rights: video.rights,
      aiGeneratedInput: video.ai_generated,
      aiFlags: { transcript_words: true, speaker_labels: d.asr.diarizationProvider !== "none" },
    });
    await succeedJob(d.pool, job.id, {
      video_id: video.id, duration_s: p.durationUs / 1e6, atoms: atoms.length, words: atoms.filter((a) => a.kind === "word").length,
      speakers_found: speakersFound, transcript_cache: cache, warnings,
      links: { video: `/api/v1/videos/${video.id}`, create_session: "/api/v1/sessions" },
      manifest,
    });
    log.info({ video_id: video.id, cache, timings }, "intake succeeded");
  } catch (e) {
    const f = failureOf(e);
    log.error({ code: f.code, err: (e as Error).message }, "intake failed");
    await updateVideo(d.pool, videoId, { status: "failed", warnings: [f.body.error.message] }).catch(() => undefined);
    await failJob(d.pool, job.id, f.body);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  await deliverCallback(d, job.id);
}

async function deliverCallback(d: WorkerDeps, jobId: string): Promise<void> {
  const row = await getJob(d.pool, jobId);
  if (!row?.callback_url) return;
  const r = await sendCallback(row.callback_url, jobView(row), d.cfg.CALLBACK_HMAC_SECRET);
  d.log.info({ job_id: jobId, callback: r }, "callback sent");
  await d.pool.query("update jobs set result = coalesce(result, '{}'::jsonb) || jsonb_build_object('callback', $2::jsonb) where id=$1 and status='succeeded'", [jobId, JSON.stringify(r)]);
}
