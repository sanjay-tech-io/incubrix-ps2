import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { runFfmpeg, type StreamFacts } from "./ffmpeg.ts";

export interface ProxyDecision {
  needed: boolean;
  reasons: string[];
  /** Colour conversion the proxy applies, if any. */
  colour: "none" | "to_8bit" | "to_sdr_bt709";
}

/**
 * When a render reads a CFR H.264 8-bit BT.709 proxy instead of the original:
 *  - the source is variable frame rate (frame-exact claims need a fixed grid);
 *  - the source is 10-bit, HDR (PQ/HLG) or wide-gamut (the output is always 8-bit SDR BT.709);
 *  - the source is not H.264 (HEVC etc. would be decoded again on every render; the proxy is made once and kept).
 * The original is never touched either way.
 */
export function decideProxy(f: StreamFacts, vfr: boolean): ProxyDecision {
  const reasons: string[] = [];
  const hdr = f.colorTransfer === "smpte2084" || f.colorTransfer === "arib-std-b67";
  const wide = f.colorPrimaries === "bt2020";
  const tenBit = /10|12/.test(f.pixFmt) || (f.bitsPerRawSample ?? 8) > 8;
  if (vfr) reasons.push("variable frame rate source");
  if (hdr) reasons.push(`HDR transfer ${f.colorTransfer}`);
  else if (wide) reasons.push("wide-gamut BT.2020 primaries");
  if (tenBit) reasons.push(`${f.pixFmt || "high"} bit depth`);
  if (f.codec && f.codec !== "h264") reasons.push(`${f.codec} source (decoded once into an H.264 proxy)`);
  const colour = hdr || wide ? "to_sdr_bt709" : tenBit ? "to_8bit" : "none";
  return { needed: reasons.length > 0, reasons, colour };
}

export function proxyFilter(d: ProxyDecision, f: StreamFacts, fpsText: string, offsetUs: number): string {
  const shift = offsetUs === 0 ? "" : `${offsetUs < 0 ? "-" : "+"}${(Math.abs(offsetUs) / 1e6).toFixed(6)}/TB`;
  const clock = `setpts=PTS-STARTPTS${shift},fps=fps=${fpsText}:start_time=0`;
  if (d.colour === "to_sdr_bt709") {
    const hdr = f.colorTransfer === "smpte2084" || f.colorTransfer === "arib-std-b67";
    // HDR: to linear light, tone map (Hable), then to BT.709 SDR. Wide-gamut SDR: only the primaries/matrix change.
    return hdr
      ? `${clock},zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p`
      : `${clock},zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p`;
  }
  return `${clock},format=yuv420p`;
}

export interface ProxyResult {
  path: string;
  sha256: string;
  decision: ProxyDecision;
  warnings: string[];
}

/**
 * Make the CFR proxy: video only (the audio always comes from the original), H.264 8-bit yuv420p BT.709, on the grid of
 * the nominal frame rate. Time stays on the original's clock, so no timeline number changes.
 */
export async function makeProxy(o: {
  original: string;
  out: string;
  facts: StreamFacts;
  vfr: boolean;
  fps: { num: number; den: number };
  offsetUs: number;
  onProgress?: (outTimeUs: number) => void;
}): Promise<ProxyResult> {
  const decision = decideProxy(o.facts, o.vfr);
  const fpsText = `${o.fps.num}/${o.fps.den}`;
  const vf = proxyFilter(decision, o.facts, fpsText, o.offsetUs);
  await runFfmpeg(
    [
      "-i", o.original, "-map", "0:v:0", "-an", "-vf", vf,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p",
      "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
      "-r", fpsText, "-fps_mode", "cfr", "-movflags", "+faststart", o.out,
    ],
    o.onProgress ? { onProgress: o.onProgress } : {},
  );
  const warnings: string[] = [];
  if (o.vfr) warnings.push(`variable frame rate source rendered through a constant-frame-rate H.264 proxy at ${fpsText} fps; frames may be duplicated or dropped to fit the grid`);
  if (decision.colour === "to_8bit") warnings.push(`source is ${o.facts.pixFmt} (more than 8 bits); the proxy and the render are 8-bit yuv420p`);
  if (decision.colour === "to_sdr_bt709") warnings.push(`source colour is ${o.facts.colorTransfer}/${o.facts.colorPrimaries}; converted to 8-bit SDR BT.709${o.facts.colorTransfer === "smpte2084" || o.facts.colorTransfer === "arib-std-b67" ? " with a Hable tone map (colours differ from an HDR display)" : ""}`);
  return { path: o.out, sha256: await sha256File(o.out), decision, warnings };
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (d) => h.update(d)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });
}
