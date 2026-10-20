import { describe, expect, it } from "vitest";
import { buildAtoms, indexAtoms, atomAt } from "../src/atoms";
import { cursorToUs, spanToInterval, usToCursor, validateCursor } from "../src/cursor";
import { frameStartUs, snapToFrameUs } from "../src/frames";
import type { Atom } from "../src/types";

const SHA = "c".repeat(64);
const FPS30 = { num: 30, den: 1 };

// 0-1s silence | "hello" 1-2s | "um" 2-2.5s | silence 2.5-4s | "world" 4-5s (end of source at 5s)
function tiny(): Atom[] {
  return buildAtoms(SHA, 5_000_000, [
    { text: "hello", startUs: 1_000_000, endUs: 2_000_000 },
    { text: "um", startUs: 2_000_000, endUs: 2_500_000 },
    { text: "world", startUs: 4_000_000, endUs: 5_000_000 },
  ]);
}

describe("buildAtoms", () => {
  it("fills gaps with silence atoms so atoms tile the whole duration", () => {
    const atoms = tiny();
    expect(atoms.map((a) => [a.kind, a.startUs, a.endUs])).toEqual([
      ["silence", 0, 1_000_000],
      ["word", 1_000_000, 2_000_000],
      ["word", 2_000_000, 2_500_000],
      ["silence", 2_500_000, 4_000_000],
      ["word", 4_000_000, 5_000_000],
    ]);
  });

  it("flags um/uh as filler by default but not ordinary words", () => {
    const atoms = tiny();
    expect(atoms.find((a) => a.text === "um")!.filler).toBe(true);
    expect(atoms.find((a) => a.text === "hello")!.filler).toBe(false);
  });

  it("respects an explicit filler flag (a filler 'like' vs a normal 'like')", () => {
    const atoms = buildAtoms(SHA, 3_000_000, [
      { text: "like", startUs: 0, endUs: 1_000_000, filler: true },
      { text: "like", startUs: 1_000_000, endUs: 2_000_000 },
    ]);
    expect(atoms.filter((a) => a.kind === "word").map((a) => a.filler)).toEqual([true, false]);
  });

  it("marks low confidence below the threshold", () => {
    const atoms = buildAtoms(SHA, 2_000_000, [{ text: "maybe", startUs: 0, endUs: 1_000_000, confidencePermille: 400 }], { lowConfidencePermille: 600 });
    expect(atoms[0]!.lowConfidence).toBe(true);
  });

  it("derives ids from content: same input gives same ids, different source hash gives different ids", () => {
    const a = tiny();
    const b = tiny();
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
    const c = buildAtoms("d".repeat(64), 5_000_000, [{ text: "hello", startUs: 1_000_000, endUs: 2_000_000 }]);
    expect(c[1]!.id).not.toBe(a[1]!.id);
    expect(new Set(a.map((x) => x.id)).size).toBe(a.length);
    for (const x of a) expect(x.id).toMatch(/^a_[0-9a-f]{12}$/);
  });

  it("rejects overlapping or out-of-range words", () => {
    expect(() => buildAtoms(SHA, 3_000_000, [{ text: "a", startUs: 0, endUs: 2_000_000 }, { text: "b", startUs: 1_000_000, endUs: 2_500_000 }])).toThrow();
    expect(() => buildAtoms(SHA, 1_000_000, [{ text: "a", startUs: 0, endUs: 2_000_000 }])).toThrow();
  });
});

describe("indexAtoms", () => {
  it("rejects atoms that do not tile the duration", () => {
    const atoms = tiny();
    expect(() => indexAtoms([atoms[0]!, atoms[2]!], 5_000_000)).toThrow();
    expect(() => indexAtoms(atoms, 6_000_000)).toThrow();
  });
  it("finds the atom at a time (boundaries belong to the atom that starts there)", () => {
    const idx = indexAtoms(tiny(), 5_000_000);
    expect(atomAt(idx, 0).kind).toBe("silence");
    expect(atomAt(idx, 1_000_000).text).toBe("hello");
    expect(atomAt(idx, 1_999_999).text).toBe("hello");
    expect(atomAt(idx, 2_000_000).text).toBe("um");
    expect(atomAt(idx, 4_999_999).text).toBe("world");
  });
});

describe("frame grid with rational fps", () => {
  it("30000/1001: frame starts are rounded to the nearest microsecond", () => {
    const f = { num: 30000, den: 1001 };
    expect(frameStartUs(0, f)).toBe(0);
    expect(frameStartUs(1, f)).toBe(33_367); // 33366.67
    expect(frameStartUs(2, f)).toBe(66_733); // 66733.33
    expect(frameStartUs(30_000, f)).toBe(1_001_000_000); // exactly 1001 s
  });
  it("snaps to the nearest frame start", () => {
    const f = { num: 30000, den: 1001 };
    expect(snapToFrameUs(50_000, f)).toBe(33_367); // 1.4985 frames
    expect(snapToFrameUs(51_000, f)).toBe(66_733); // 1.5285 frames
    expect(snapToFrameUs(66_733, f)).toBe(66_733); // already on grid
  });
  it("30 fps: 30.0 s is on the grid, 30.01 s snaps to 30.0 s", () => {
    expect(snapToFrameUs(30_000_000, FPS30)).toBe(30_000_000);
    expect(snapToFrameUs(30_010_000, FPS30)).toBe(30_000_000);
  });
});

describe("cursor validation", () => {
  const atoms = tiny();
  const idx = indexAtoms(atoms, 5_000_000);
  const [sil0, hello, um, sil1, world] = atoms as [Atom, Atom, Atom, Atom, Atom];

  it("accepts offset 0 at any atom (a boundary)", () => {
    for (const a of atoms) expect(() => validateCursor(idx, { atom: a.id, offsetUs: 0 }, FPS30)).not.toThrow();
  });

  it("accepts an on-grid offset inside a silence atom", () => {
    // sil1 spans 2.5s..4.0s; 3.0s = 0.5 s offset is on the 30 fps grid
    const c = { atom: sil1.id, offsetUs: 500_000 };
    expect(() => validateCursor(idx, c, FPS30)).not.toThrow();
    expect(cursorToUs(idx, c, FPS30)).toBe(3_000_000);
  });

  it("rejects an unknown atom", () => {
    expect(() => validateCursor(idx, { atom: "a_000000000000", offsetUs: 0 }, FPS30)).toThrow(/INVALID_CURSOR|unknown/i);
  });
  it("rejects negative, fractional and too-large offsets", () => {
    expect(() => validateCursor(idx, { atom: sil1.id, offsetUs: -1 }, FPS30)).toThrow();
    expect(() => validateCursor(idx, { atom: sil1.id, offsetUs: 0.5 }, FPS30)).toThrow();
    expect(() => validateCursor(idx, { atom: sil1.id, offsetUs: 1_500_000 }, FPS30)).toThrow(); // == atom length, not allowed mid-source
    expect(() => validateCursor(idx, { atom: sil1.id, offsetUs: 9_000_000 }, FPS30)).toThrow();
  });
  it("rejects a non-zero offset inside a word", () => {
    expect(() => validateCursor(idx, { atom: hello.id, offsetUs: 100_000 }, FPS30)).toThrow(/word/i);
    expect(() => validateCursor(idx, { atom: um.id, offsetUs: 1 }, FPS30)).toThrow(/word/i);
  });
  it("rejects an offset inside a silence that is off the frame grid", () => {
    // 0.5 s + 1 us = not a multiple of 1/30 s
    expect(() => validateCursor(idx, { atom: sil1.id, offsetUs: 500_001 }, FPS30)).toThrow(/frame/i);
  });
  it("does not check the grid for audio-only sources (fps null)", () => {
    expect(() => validateCursor(idx, { atom: sil1.id, offsetUs: 500_001 }, null)).not.toThrow();
  });
  it("allows the end-of-source cursor only on the last atom, only as an end cursor", () => {
    const end = { atom: world.id, offsetUs: 1_000_000 };
    expect(() => validateCursor(idx, end, FPS30, "end")).not.toThrow();
    expect(() => validateCursor(idx, end, FPS30, "start")).toThrow();
    expect(() => validateCursor(idx, { atom: sil0.id, offsetUs: 1_000_000 }, FPS30, "end")).toThrow();
  });
  it("usToCursor is canonical: a boundary is the NEXT atom at offset 0; the end is last atom at its length", () => {
    expect(usToCursor(idx, 2_000_000, FPS30)).toEqual({ atom: um.id, offsetUs: 0 });
    expect(usToCursor(idx, 3_000_000, FPS30)).toEqual({ atom: sil1.id, offsetUs: 500_000 });
    expect(usToCursor(idx, 5_000_000, FPS30)).toEqual({ atom: world.id, offsetUs: 1_000_000 });
    expect(() => usToCursor(idx, 1_500_000, FPS30)).toThrow(); // inside a word
  });
  it("a span needs start < end", () => {
    const a = { atom: hello.id, offsetUs: 0 };
    const b = { atom: um.id, offsetUs: 0 };
    expect(spanToInterval(idx, { start: a, end: b }, FPS30)).toEqual({ s: 1_000_000, e: 2_000_000 });
    expect(() => spanToInterval(idx, { start: b, end: a }, FPS30)).toThrow();
    expect(() => spanToInterval(idx, { start: a, end: a }, FPS30)).toThrow();
  });
});
