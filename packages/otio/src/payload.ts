import { autoCaptionCues, effectDisplay, timelineHash, timelinePieces, type EngineContext, type Rate, type Timeline } from "@incubrix/engine";

/**
 * What the OpenTimelineIO service needs (services/otio/otio_service/server.py `Payload`). Pure data, no OTIO knowledge:
 * the library lives in the Python service, this package only turns a materialized timeline into integers.
 *
 * Time units: frames of `rate` (the source's frame rate), or microseconds when the source has no frame rate.
 * A clip is one engine "piece" (a stretch of source played at one constant rate), in OUTPUT order. Its
 * `out_duration` is the piece's rendered length, i.e. the engine's cumulative-rounded frame count, so the clips add up to exactly
 * the timeline length in frames. With speed s the clip reads s x out_duration of source (a LinearTimeWarp), which is within a
 * frame of the piece's source span; the exact span in microseconds travels along in `src_start_us` / `src_end_us`.
 */
export interface OtioPayload {
  name: string;
  rate: { num: number; den: number } | null;
  source: { name: string; sha256: string; duration_units: number; has_video: boolean; has_audio: boolean };
  clips: { name: string; src_start: number; out_duration: number; speed: Rate; src_start_us: number; src_end_us: number }[];
  markers: { name: string; start: number; duration: number; color?: string; kind: string; text?: string; effect_id?: string; detail?: string }[];
  metadata: Record<string, unknown>;
}

export interface OtioOptions {
  name: string;
  sourceName: string;
  aiGenerated: boolean;
  /** Extra facts for the file's metadata (rights, manifest summary...). Plain JSON values only. */
  extra?: Record<string, unknown>;
}

const US = 1_000_000;

export function buildOtioPayload(ctx: EngineContext, tl: Timeline, o: OtioOptions): OtioPayload {
  const src = ctx.source;
  const fps = src.fps;
  // units: frames when there is a frame rate, microseconds otherwise
  const unitsOf = (us: number): number => (fps ? Math.round((us * fps.num) / (fps.den * US)) : us);
  const pieces = timelinePieces(ctx, tl);

  const clips = pieces.map((p, i) => ({
    name: `clip ${i + 1}`,
    src_start: unitsOf(p.srcS),
    out_duration: p.outFrames ?? p.outE - p.outS,
    speed: { num: p.rate.num, den: p.rate.den },
    src_start_us: p.srcS,
    src_end_us: p.srcE,
  }));

  const markers: OtioPayload["markers"] = [];
  const mark = (m: Omit<OtioPayload["markers"][number], "start" | "duration">, startUs: number, endUs: number): void => {
    const start = unitsOf(startUs);
    markers.push({ ...m, start, duration: Math.max(1, unitsOf(endUs) - start) });
  };
  for (const e of tl.effects) {
    const d = effectDisplay(ctx, tl, e); // null = inactive (every anchored word is cut): no marker, the effect stays in the log
    if (!d) continue;
    const params = e.params;
    if (params.kind === "caption" || params.kind === "text_overlay") {
      // shown on the first run only (see the fragmented flag), with the 0.7 s minimum already applied
      mark({ name: params.text, kind: params.kind, text: params.text, color: params.style.color, effect_id: e.id }, d.startUs, d.endUs);
    } else {
      for (const r of d.runs) mark({ name: params.kind, kind: params.kind, effect_id: e.id }, r.startUs, r.endUs);
    }
  }
  if (tl.autoCaption) for (const c of autoCaptionCues(ctx, tl)) mark({ name: c.text, kind: "auto_caption", text: c.text, color: tl.autoCaption.color }, c.startUs, c.endUs);
  markers.sort((a, b) => a.start - b.start || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));

  return {
    name: o.name,
    rate: fps ? { num: fps.num, den: fps.den } : null,
    source: { name: o.sourceName, sha256: src.sha256, duration_units: unitsOf(src.durationUs), has_video: src.hasVideo, has_audio: src.hasAudio },
    clips,
    markers,
    metadata: {
      timeline_hash: timelineHash(tl),
      duration_us: tl.durationUs,
      ai_generated: o.aiGenerated,
      inactive_effects: tl.effects.filter((e) => e.state === "inactive").map((e) => e.id),
      music: tl.music ? { gain_centi_db: tl.music.gainCentiDb, duck_centi_db: tl.music.duckCentiDb } : null,
      speed_convention: "clip.source_range = (source start, OUTPUT duration); LinearTimeWarp.time_scalar = speed, so the clip reads speed x duration of source",
      ...(o.extra ?? {}),
    },
  };
}
