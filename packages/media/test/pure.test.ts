import { describe, expect, it } from "vitest";
import { clampWordsToSilence, detectVfr, parseFraction, parseSilenceDetect, secondsToUs } from "../src/index.ts";

describe("secondsToUs (no float drift)", () => {
  it("parses decimal strings exactly", () => {
    expect(secondsToUs("1.5")).toBe(1_500_000);
    expect(secondsToUs("0.000001")).toBe(1);
    expect(secondsToUs("3628.990667")).toBe(3_628_990_667);
    expect(secondsToUs("12")).toBe(12_000_000);
    expect(secondsToUs("1.1234567")).toBe(1_123_457); // rounds half up at the 7th digit
  });
  it("rejects garbage", () => {
    expect(() => secondsToUs("N/A")).toThrow();
  });
});

describe("parseFraction", () => {
  it("keeps NTSC rates exact and reduces to lowest terms", () => {
    expect(parseFraction("30000/1001")).toEqual({ num: 30000, den: 1001 });
    expect(parseFraction("50/2")).toEqual({ num: 25, den: 1 });
    expect(parseFraction("25")).toEqual({ num: 25, den: 1 });
  });
  it("rejects 0/0 (ffprobe's 'unknown')", () => {
    expect(() => parseFraction("0/0")).toThrow();
  });
});

describe("detectVfr", () => {
  const regular = Array.from({ length: 60 }, (_, i) => i * 40_000);
  it("constant spacing is not VFR", () => expect(detectVfr(regular)).toBe(false));
  it("tiny timestamp jitter is not VFR", () => expect(detectVfr(regular.map((t, i) => t + (i % 2) * 500))).toBe(false));
  it("a dropped-frame gap is VFR", () => expect(detectVfr([...regular.slice(0, 30), ...regular.slice(40)])).toBe(true));
  it("fewer than 3 frames cannot be judged and is not VFR", () => expect(detectVfr([0, 40_000])).toBe(false));
});

describe("parseSilenceDetect", () => {
  const log = [
    "[silencedetect @ 0x1] silence_start: 1.000000",
    "[silencedetect @ 0x1] silence_end: 2.000000 | silence_duration: 1.000000",
    "[silencedetect @ 0x1] silence_start: 3.5",
  ].join("\n");
  it("returns closed intervals in integer microseconds", () => {
    expect(parseSilenceDetect(log, 4_000_000)).toEqual([
      { startUs: 1_000_000, endUs: 2_000_000 },
      { startUs: 3_500_000, endUs: 4_000_000 }, // still open at EOF: closed at the file duration
    ]);
  });
  it("no silence => empty", () => expect(parseSilenceDetect("nothing here", 1_000_000)).toEqual([]));
  it("a negative start (ffmpeg can print one) is clamped to 0", () => {
    expect(parseSilenceDetect("silence_start: -0.001\nsilence_end: 0.5 | silence_duration: 0.501", 1_000_000)[0]!.startUs).toBe(0);
  });
});

describe("clampWordsToSilence", () => {
  const sil = [{ startUs: 1_000_000, endUs: 2_000_000 }];
  it("pulls a word end that stretches into a pause back to the silence start", () => {
    const r = clampWordsToSilence([{ text: "hello", startUs: 500_000, endUs: 1_800_000 }], sil);
    expect(r.words[0]).toEqual({ text: "hello", startUs: 500_000, endUs: 1_000_000 });
    expect(r.adjustments).toEqual([{ index: 0, field: "endUs", from: 1_800_000, to: 1_000_000 }]);
  });
  it("pushes a word start that begins inside a pause forward to the silence end", () => {
    const r = clampWordsToSilence([{ text: "next", startUs: 1_200_000, endUs: 2_400_000 }], sil);
    expect(r.words[0]).toMatchObject({ startUs: 2_000_000, endUs: 2_400_000 });
  });
  it("leaves words that do not touch a silence untouched", () => {
    const w = { text: "a", startUs: 100_000, endUs: 900_000 };
    expect(clampWordsToSilence([w], sil)).toEqual({ words: [w], adjustments: [], insideSilence: [] });
  });
  it("a word that lies entirely inside a silence is left alone and reported (likely hallucination)", () => {
    const r = clampWordsToSilence([{ text: "ghost", startUs: 1_200_000, endUs: 1_600_000 }], sil);
    expect(r.words[0]).toMatchObject({ startUs: 1_200_000, endUs: 1_600_000 });
    expect(r.insideSilence).toEqual([0]);
  });
  it("never shrinks a word below the minimum duration", () => {
    const r = clampWordsToSilence([{ text: "x", startUs: 999_990, endUs: 1_500_000 }], sil, { minWordUs: 20_000 });
    expect(r.words[0]!.endUs - r.words[0]!.startUs).toBeGreaterThanOrEqual(20_000);
  });
  it("does not mutate its input", () => {
    const input = Object.freeze([Object.freeze({ text: "h", startUs: 500_000, endUs: 1_800_000 })]);
    expect(() => clampWordsToSilence(input, sil)).not.toThrow();
  });
});
