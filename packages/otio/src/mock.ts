import type { OtioPayload } from "./payload.ts";

/**
 * OTIO_PROVIDER=mock: writes the .otio JSON by hand, in the shape the library writes (schema names Timeline.1, Stack.1,
 * Track.1, Clip.2, ExternalReference.1, TimeRange.1, RationalTime.1, LinearTimeWarp.1, Marker.2). It exists so the API
 * works without the Python service (tests with no network). services/otio's tests read the real library's output;
 * the compose test also loads THIS output with the library to keep the two in step.
 */
const MICROS = 1_000_000;
const PALETTE: Record<string, [number, number, number]> = {
  RED: [255, 0, 0], ORANGE: [255, 165, 0], YELLOW: [255, 255, 0], GREEN: [0, 160, 0], CYAN: [0, 255, 255],
  BLUE: [0, 0, 255], PURPLE: [128, 0, 128], MAGENTA: [255, 0, 255], PINK: [255, 192, 203], BLACK: [0, 0, 0], WHITE: [255, 255, 255],
};

function markerColor(hex: string | undefined): string {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return "WHITE";
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  let best = "WHITE";
  let bestD = Infinity;
  for (const [name, c] of Object.entries(PALETTE)) {
    const d = c.reduce((s, v, i) => s + (v - rgb[i]!) ** 2, 0);
    if (d < bestD) [best, bestD] = [name, d];
  }
  return best;
}

export function mockOtioJson(p: OtioPayload): string {
  const rate = p.rate ? p.rate.num / p.rate.den : MICROS;
  const rt = (value: number) => ({ OTIO_SCHEMA: "RationalTime.1", rate, value });
  const range = (start: number, duration: number) => ({ OTIO_SCHEMA: "TimeRange.1", duration: rt(duration), start_time: rt(start) });
  const ref = {
    OTIO_SCHEMA: "ExternalReference.1",
    metadata: { incubrix: { sha256: p.source.sha256 } },
    name: "",
    available_range: range(0, p.source.duration_units),
    available_image_bounds: null,
    target_url: p.source.name,
  };
  const clip = (c: OtioPayload["clips"][number]) => ({
    OTIO_SCHEMA: "Clip.2",
    metadata: { incubrix: { speed: c.speed, src_end_us: c.src_end_us, src_start_us: c.src_start_us } },
    name: c.name,
    source_range: range(c.src_start, c.out_duration),
    effects:
      c.speed.num === c.speed.den
        ? []
        : [{ OTIO_SCHEMA: "LinearTimeWarp.1", metadata: { incubrix: { speed: c.speed } }, name: "speed", effect_name: "LinearTimeWarp", enabled: true, time_scalar: c.speed.num / c.speed.den }],
    markers: [],
    enabled: true,
    color: null,
    media_references: { DEFAULT_MEDIA: ref },
    active_media_reference_key: "DEFAULT_MEDIA",
  });
  const marker = (m: OtioPayload["markers"][number]) => ({
    OTIO_SCHEMA: "Marker.2",
    metadata: { incubrix: Object.fromEntries(Object.entries({ effect_id: m.effect_id, kind: m.kind, text: m.text, detail: m.detail }).filter(([, v]) => v !== undefined)) },
    name: m.name,
    color: markerColor(m.color),
    marked_range: range(m.start, m.duration),
    comment: "",
  });
  const track = (kind: "Video" | "Audio", name: string, markers: OtioPayload["markers"]) => ({
    OTIO_SCHEMA: "Track.1", metadata: {}, name, source_range: null, effects: [], markers: markers.map(marker), enabled: true, color: null, children: p.clips.map(clip), kind,
  });
  const children = [];
  if (p.source.has_video) children.push(track("Video", "V1", p.markers));
  if (p.source.has_audio) children.push(track("Audio", "A1", children.length === 0 ? p.markers : []));
  return JSON.stringify({
    OTIO_SCHEMA: "Timeline.1",
    metadata: { incubrix: { ...p.metadata, source_sha256: p.source.sha256, source_name: p.source.name, exporter: "mock (hand-written OTIO JSON)" } },
    name: p.name,
    global_start_time: rt(0),
    tracks: { OTIO_SCHEMA: "Stack.1", metadata: {}, name: "tracks", source_range: null, effects: [], markers: [], enabled: true, color: null, children },
  });
}
