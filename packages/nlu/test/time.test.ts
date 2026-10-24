import { describe, expect, it } from "vitest";
import { findRange, findTimeAfter, tokenize, wordsToDigits } from "../src/time.ts";

const U = 1_000_000;
const D = 200 * U;
const range = (text: string) => {
  const r = findRange(tokenize(wordsToDigits(text)), D);
  return r && [r.startUs / U, r.endUs / U];
};

describe("time expressions", () => {
  it.each([
    ["remove 0:30-0:40", [30, 40]],
    ["remove 0:30 to 0:40", [30, 40]],
    ["from 1:00 to 1:30", [60, 90]],
    ["between 0:10 and 0:20", [10, 20]],
    ["cut 80 seconds to 90 seconds", [80, 90]],
    ["cut from a minute twenty to a minute thirty", [80, 90]],
    ["cut a minute and twenty seconds to 1:30", [80, 90]],
    ["cut one minute and a half to two minutes", [90, 120]],
    ["cut 1 minute 20 to 1 minute 30", [80, 90]],
    ["cut 1m20s to 1m30s", [80, 90]],
    ["cut the first 30 seconds", [0, 30]],
    ["cut the first half a minute", [0, 30]],
    ["cut the last 10 seconds", [190, 200]],
    ["cut the last minute", [140, 200]],
    ["cut the last ten seconds", [190, 200]],
    ["cut 1:02:03 to 1:03:00", [3723, 3780]],
    // the "and" between two times must not be eaten as part of the first ("30 seconds and 40 seconds" is a range, not 70 s)
    ["get rid of the stretch between half a minute and forty seconds", [30, 40]],
    ["cut between 20 seconds and 40 seconds", [20, 40]],
    ["cut between 1 minute and 2 minutes", [60, 120]],
  ])("%s", (text, want) => expect(range(text)).toEqual(want));

  it("a bare number is read as seconds with a warning", () => {
    const r = findRange(tokenize("cut 30 to 40"), D)!;
    expect([r.startUs, r.endUs]).toEqual([30 * U, 40 * U]);
    expect(r.warnings).toHaveLength(1);
  });

  it("80 seconds on its own is 80 s, a minute twenty is 80 s", () => {
    expect(findTimeAfter(tokenize(wordsToDigits("add a caption at 80 seconds")), ["at"])!.us).toBe(80 * U);
    expect(findTimeAfter(tokenize(wordsToDigits("at a minute twenty")), ["at"])!.us).toBe(80 * U);
    expect(findTimeAfter(tokenize("add a caption at 5:00"), ["at"])!.us).toBe(300 * U);
  });

  it("no time -> null; invalid clock -> null", () => {
    expect(range("remove the part about pricing")).toBeNull();
    expect(range("cut 1:75 to 2:00")).toBeNull();
  });
});
