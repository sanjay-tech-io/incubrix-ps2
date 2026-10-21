import {
  autoCaptionCues, duckingEnvelope, effectDisplay, timelinePieces,
  type EngineContext, type Piece, type Rate, type Timeline,
} from "@incubrix/engine";

/**
 * Timeline -> ffmpeg filter graph. PURE: it builds text and a list of small text files, it never runs anything.
 * The engine decides what the output is (pieces, effect windows, music envelope); this file only spells it in ffmpeg.
 * See docs/RENDER_DESIGN.md for the reasoning.
 */

export const AUDIO_RATE = 48000;
/** Linear level of the generated 1 kHz bleep (about -12 dBFS). Fixed and documented, not a setting. */
export const BLEEP_LEVEL = 0.25;
export const BLEEP_HZ = 1000;
/** Time expressions are shifted by this much earlier so a frame that starts exactly on a boundary is inside the window. */
const EDGE_US = 500;

export interface RenderGraphInput {
  ctx: EngineContext;
  tl: Timeline;
  /** Container time (in the video / audio FILE) that corresponds to atom time 0. 0 for a CFR proxy (it is on the atom clock). */
  videoBaseUs: number;
  audioBaseUs: number;
  /**
   * Single-group mode only (groupPieces = 0): seconds to add to the video clock so frame 0 of the video sits at atom
   * time 0 (video start - audio start), for an original whose video starts more than half a frame after its audio.
   */
  videoOffsetUs: number;
  /**
   * How many pieces share one pair of seeked inputs. 0 = one group over the whole file (no seeking).
   * Why groups: with ONE split per stream every piece branch receives EVERY frame, so the work grows with
   * pieces x length (measured: docs/raw/m3_bench_*). A group only sees its own stretch of the source.
   */
  groupPieces: number;
  /** A group is closed early when its source stretch would be longer than this (a reorder can make pieces far apart). */
  groupMaxSpanUs: number;
  /** Channels of the original's audio: a mono voice is copied to both channels (ffmpeg's default upmix would lower it by 3 dB). */
  audioChannels: number;
  /** Size of the video input; used for caption size and the optional scale-down. */
  width: number;
  height: number;
  /** 0 = keep. */
  maxHeight: number;
  /** Whether a music input will be supplied (it becomes the last input). */
  hasMusic: boolean;
  /** Directory where the text files returned in `files` will be written; drawtext reads them from there. */
  workDir: string;
  fonts: { regular: string; bold: string };
}

/** One ffmpeg input, in order: the renderer turns it into `[-ss t] [-t d] -i file`. */
export interface InputSpec {
  role: "video" | "audio" | "music";
  /** Container time to seek to (before the input), null = read from the start. */
  seekUs: number | null;
  /** How much to read after the seek, null = all. */
  durationUs: number | null;
}

export interface GraphFile {
  name: string;
  content: string;
}

export interface RenderGraph {
  script: string;
  inputs: InputSpec[];
  groups: number;
  /** Files to write into workDir before running ffmpeg (one per caption). */
  files: GraphFile[];
  /** Exact number of output frames and audio samples the graph produces. */
  frames: number;
  samples: number;
  pieces: number;
  outWidth: number;
  outHeight: number;
  warnings: string[];
  /** The ffmpeg video/audio output labels. */
  labels: { video: string; audio: string };
}

const sec = (us: number): string => (us / 1_000_000).toFixed(6);

/** t in seconds for a window start/end, moved EDGE_US earlier (see above). */
const edge = (us: number): string => sec(Math.max(0, us - EDGE_US));

/**
 * atempo only accepts 0.5..2.0 per instance (and we want the same quality at every factor), so a factor outside
 * that range is a chain: 4x = 2 * 2, 0.25x = 0.5 * 0.5, 3x = 2 * 1.5. Pitch is preserved by atempo itself.
 */
export function atempoChain(rate: Rate): string[] {
  let f = rate.num / rate.den;
  const out: number[] = [];
  while (f > 2) {
    out.push(2);
    f /= 2;
  }
  while (f < 0.5) {
    out.push(0.5);
    f *= 2;
  }
  if (Math.abs(f - 1) > 1e-12 || out.length === 0) out.push(f);
  return out.filter((x) => Math.abs(x - 1) > 1e-12).map((x) => `atempo=${x.toFixed(10)}`);
}

/** Frame number of a source time: the same rule as the engine's frameStartUs inverse (nearest frame). */
function frameOf(us: number, fps: { num: number; den: number }): number {
  return Math.round((us * fps.num) / (fps.den * 1_000_000));
}

/** Wrap on spaces so a long caption stays inside ~88% of the frame width. Pure and deterministic. */
export function wrapCaption(text: string, px: number, width: number): string {
  const maxChars = Math.max(8, Math.floor((0.88 * width) / (px * 0.6)));
  const lines: string[] = [];
  let line = "";
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (line && (line + " " + w).length > maxChars) {
      lines.push(line);
      line = w;
    } else line = line ? line + " " + w : w;
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

interface CaptionDraw {
  text: string;
  startUs: number;
  endUs: number;
  color: string;
  sizePt: number;
  bold: boolean;
  position: "top" | "center" | "bottom";
}

export function buildRenderGraph(inp: RenderGraphInput): RenderGraph {
  const { ctx, tl } = inp;
  const fps = ctx.fps;
  if (!fps) throw new Error("cannot render a source without a frame rate");
  const warnings: string[] = [];
  const pieces: Piece[] = timelinePieces(ctx, tl);
  if (pieces.length === 0) throw new Error("the timeline is empty: nothing to render");

  const lines: string[] = [];
  const files: GraphFile[] = [];
  const n = pieces.length;
  const fpsText = `${fps.num}/${fps.den}`;

  // ---- video + audio: pieces are cut by FRAME NUMBER / SAMPLE from seeked inputs, one input pair per group of pieces ----
  let outWidth = inp.width;
  let outHeight = inp.height;
  let scale = "";
  if (inp.maxHeight > 0 && inp.height > inp.maxHeight) {
    outHeight = inp.maxHeight - (inp.maxHeight % 2);
    outWidth = Math.round((inp.width * outHeight) / inp.height / 2) * 2;
    scale = `,scale=${outWidth}:${outHeight}:flags=lanczos`;
  }
  const shift = inp.videoOffsetUs === 0 ? "" : `${inp.videoOffsetUs < 0 ? "-" : "+"}${sec(Math.abs(inp.videoOffsetUs))}/TB`;
  const frameHalfUs = Math.floor((1_000_000 * fps.den) / fps.num / 2);
  const AUDIO_PREROLL_US = 500_000; // the AAC decoder needs a little run-up before the first sample we keep
  const inputs: InputSpec[] = [];

  // piece -> group (consecutive pieces in OUTPUT order; closed by count or by source span)
  const groups: { first: number; last: number; lo: number; hi: number }[] = [];
  if (inp.groupPieces <= 0) groups.push({ first: 0, last: n - 1, lo: 0, hi: ctx.source.durationUs });
  else {
    let g = { first: 0, last: 0, lo: pieces[0]!.srcS, hi: pieces[0]!.srcE };
    for (let i = 1; i < n; i++) {
      const p = pieces[i]!;
      const lo = Math.min(g.lo, p.srcS);
      const hi = Math.max(g.hi, p.srcE);
      if (i - g.first >= inp.groupPieces || hi - lo > inp.groupMaxSpanUs) {
        groups.push(g);
        g = { first: i, last: i, lo: p.srcS, hi: p.srcE };
      } else g = { first: g.first, last: i, lo, hi };
    }
    groups.push(g);
  }

  const vlabels: string[] = new Array<string>(n);
  const alabels: string[] = new Array<string>(n);
  const afterSamples = (frames: number): number => Math.round((frames * fps.den * AUDIO_RATE) / fps.num);
  // cumulative output counts per piece (exact integers, the same for every strategy)
  const cumFramesAt: number[] = [];
  const cumSamplesAt: number[] = [];
  {
    let cf = 0;
    let cs = 0;
    for (const p of pieces) {
      if (p.outFrames === null) throw new Error("piece without a frame count");
      cf += p.outFrames;
      const cs2 = afterSamples(cf);
      cumFramesAt.push(cf);
      cumSamplesAt.push(cs2 - cs);
      cs = cs2;
    }
  }
  const cumFrames = cumFramesAt[n - 1]!;
  const cumSamples = pieces.reduce((t, _p, i) => t + cumSamplesAt[i]!, 0);

  groups.forEach((g, gi) => {
    const count = g.last - g.first + 1;
    let a0 = 0; // source frame number of the first decoded video frame
    let vSeek: number | null = null;
    let vDur: number | null = null;
    let aSeekAtom = 0; // atom time at which the audio input starts (audio timestamps are re-based to 0 there)
    let aSeek: number | null = null;
    let aDur: number | null = null;
    if (inp.groupPieces > 0) {
      a0 = frameOf(g.lo, fps);
      const vAtom = Math.max(0, Math.round((a0 * fps.den * 1_000_000) / fps.num) - frameHalfUs);
      vSeek = vAtom + inp.videoBaseUs;
      vDur = g.hi - vAtom + 3 * frameHalfUs * 2;
      aSeekAtom = Math.max(0, g.lo - AUDIO_PREROLL_US);
      aSeek = aSeekAtom + inp.audioBaseUs;
      aDur = g.hi - aSeekAtom + 200_000;
    }
    const vIdx = inputs.length;
    inputs.push({ role: "video", seekUs: vSeek, durationUs: vDur });
    const aIdx = inputs.length;
    inputs.push({ role: "audio", seekUs: aSeek, durationUs: aDur });
    // a group's video is decoded once and split only among ITS pieces
    lines.push(`[${vIdx}:v]setpts=PTS-STARTPTS${inp.groupPieces <= 0 ? shift : ""},fps=fps=${fpsText}:start_time=0${scale},setsar=1,${count > 1 ? `split=${count}` : "null"}${branches(`vs${gi}_`, count)}`);
    lines.push(`[${aIdx}:a]aresample=${AUDIO_RATE},${inp.audioChannels === 1 ? "pan=stereo|c0=c0|c1=c0," : ""}aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,${count > 1 ? `asplit=${count}` : "anull"}${branches(`as${gi}_`, count)}`);
    for (let i = g.first; i <= g.last; i++) {
      const p = pieces[i]!;
      const k = i - g.first;
      const a = frameOf(p.srcS, fps);
      const b = Math.max(a + 1, frameOf(p.srcE, fps));
      const retime = p.rate.num === p.rate.den ? "" : `,setpts=PTS*${p.rate.den}/${p.rate.num},fps=fps=${fpsText}`;
      // tpad clones the last frame if the retimed piece came out one frame short, then trim cuts to EXACTLY outFrames.
      lines.push(`[vs${gi}_${k}]trim=start_frame=${a - a0}:end_frame=${b - a0},setpts=PTS-STARTPTS${retime},tpad=stop_mode=clone:stop=3,trim=end_frame=${p.outFrames},setpts=PTS-STARTPTS[v${i}]`);
      vlabels[i] = `[v${i}]`;
      const samples = cumSamplesAt[i]!;
      const tempo = atempoChain(p.rate);
      lines.push(
        `[as${gi}_${k}]atrim=start=${sec(p.srcS - aSeekAtom)}:end=${sec(p.srcE - aSeekAtom)},asetpts=PTS-STARTPTS${tempo.length ? "," + tempo.join(",") : ""},apad=whole_len=${samples},atrim=end_sample=${samples},asetpts=PTS-STARTPTS[a${i}]`,
      );
      alabels[i] = `[a${i}]`;
    }
  });
  const interleaved = pieces.map((_, i) => `${vlabels[i]}${alabels[i]}`).join("");
  lines.push(`${interleaved}concat=n=${n}:v=1:a=1[vcat][acat]`);

  // ---- captions, auto-captions, text overlays: drawtext on the final video ----
  const draws: CaptionDraw[] = [];
  for (const e of tl.effects) {
    if (e.state !== "active") continue;
    if (e.params.kind !== "caption" && e.params.kind !== "text_overlay") continue;
    const d = effectDisplay(ctx, tl, e);
    if (!d) continue;
    draws.push({ text: e.params.text, startUs: d.startUs, endUs: d.endUs, color: e.params.style.color, sizePt: e.params.style.sizePt, bold: e.params.style.bold, position: e.params.position });
  }
  if (tl.autoCaption) {
    for (const c of autoCaptionCues(ctx, tl)) {
      draws.push({ text: c.text, startUs: c.startUs, endUs: c.endUs, color: tl.autoCaption.color, sizePt: tl.autoCaption.sizePt, bold: tl.autoCaption.bold, position: "bottom" });
    }
  }
  let vlast = "vcat";
  draws.forEach((d, i) => {
    // sizePt is relative to a 720-line frame, so the same caption looks the same at any resolution.
    const px = Math.max(8, Math.round((d.sizePt * outHeight) / 720));
    const name = `cap_${i}.txt`;
    files.push({ name, content: wrapCaption(d.text, px, outWidth) });
    const y = d.position === "top" ? "h*0.07" : d.position === "center" ? "(h-text_h)/2" : "h-text_h-h*0.07";
    const font = d.bold ? inp.fonts.bold : inp.fonts.regular;
    const border = Math.max(2, Math.round(px / 14));
    const next = `vc${i}`;
    lines.push(
      `[${vlast}]drawtext=fontfile=${font}:textfile=${inp.workDir}/${name}:fontcolor=0x${d.color.slice(1)}:fontsize=${px}:borderw=${border}:bordercolor=black:line_spacing=4:x=(w-text_w)/2:y=${y}:enable='gte(t,${edge(d.startUs)})*lt(t,${edge(d.endUs)})'[${next}]`,
    );
    vlast = next;
  });
  lines.push(`[${vlast}]format=yuv420p[vout]`);

  // ---- mute / bleep: hard gate, sample-accurate (aeval has the sample time t) ----
  const muteWindows: { startUs: number; endUs: number }[] = [];
  const bleepWindows: { startUs: number; endUs: number }[] = [];
  for (const e of tl.effects) {
    if (e.state !== "active") continue;
    if (e.params.kind !== "mute" && e.params.kind !== "bleep") continue;
    const d = effectDisplay(ctx, tl, e);
    if (!d) continue;
    const target = e.params.kind === "mute" ? muteWindows : bleepWindows;
    for (const r of d.runs) target.push({ startUs: r.startUs, endUs: r.endUs });
  }
  const inWindow = (ws: readonly { startUs: number; endUs: number }[]): string => ws.map((w) => `gte(t,${sec(w.startUs)})*lt(t,${sec(w.endUs)})`).join("+");
  const gateWindows = [...muteWindows, ...bleepWindows];
  const mixInputs: string[] = [];
  let amain = "acat";
  if (gateWindows.length > 0) {
    lines.push(`[${amain}]aeval=exprs='val(0)*(1-gt(${inWindow(gateWindows)},0))|val(1)*(1-gt(${inWindow(gateWindows)},0))':channel_layout=stereo[agate]`);
    amain = "agate";
  }
  mixInputs.push(`[${amain}]`);
  if (bleepWindows.length > 0) {
    const g = `${BLEEP_LEVEL}*gt(${inWindow(bleepWindows)},0)*sin(2*PI*${BLEEP_HZ}*t)`;
    lines.push(`aevalsrc=exprs='${g}|${g}':sample_rate=${AUDIO_RATE}:duration=${sec(tl.durationUs)}:channel_layout=stereo[abeep]`);
    mixInputs.push("[abeep]");
  }

  // ---- music: the engine's envelope, spelled as a piecewise-linear gain in centi-dB (linear between keyframes IN dB) ----
  if (tl.music) {
    if (!inp.hasMusic) throw new Error("the timeline has music but no music file was supplied");
    const musicIndex = inputs.length;
    inputs.push({ role: "music", seekUs: null, durationUs: null });
    const kf = duckingEnvelope(ctx, tl, tl.music);
    const terms: string[] = [];
    for (let i = 0; i + 1 < kf.length; i++) {
      const a = kf[i]!;
      const b = kf[i + 1]!;
      const slope = (b.gainCentiDb - a.gainCentiDb) / (b.timeUs - a.timeUs) / 1e-6; // centi-dB per second
      terms.push(`gte(t,${sec(a.timeUs)})*lt(t,${sec(b.timeUs)})*(${a.gainCentiDb}+${slope.toFixed(6)}*(t-${sec(a.timeUs)}))`);
    }
    const last = kf[kf.length - 1]!;
    terms.push(`gte(t,${sec(last.timeUs)})*${last.gainCentiDb}`);
    // asetnsamples: gain is evaluated once per 10 ms block, so a ramp is followed to within 10 ms.
    lines.push(
      `[${musicIndex}:a]aresample=${AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${sec(tl.durationUs)},asetpts=PTS-STARTPTS,asetnsamples=n=480:p=0,volume=volume='pow(10,(${terms.join("+")})/2000)':eval=frame[amusic]`,
    );
    mixInputs.push("[amusic]");
  }
  const total = cumSamples;
  if (mixInputs.length > 1) lines.push(`${mixInputs.join("")}amix=inputs=${mixInputs.length}:duration=first:normalize=0:dropout_transition=0[amix]`);
  lines.push(`[${mixInputs.length > 1 ? "amix" : amain}]apad=whole_len=${total},atrim=end_sample=${total},asetpts=PTS-STARTPTS[aout]`);

  return {
    script: lines.join(";\n") + "\n",
    inputs,
    groups: groups.length,
    files,
    frames: cumFrames,
    samples: total,
    pieces: n,
    outWidth,
    outHeight,
    warnings,
    labels: { video: "vout", audio: "aout" },
  };
}

/** Output labels of a split/asplit: `[vs0][vs1]...;` (a single piece has no split, so it is renamed with null). */
function branches(prefix: string, n: number): string {
  if (n === 1) return `[${prefix}0]`;
  return Array.from({ length: n }, (_, i) => `[${prefix}${i}]`).join("");
}
