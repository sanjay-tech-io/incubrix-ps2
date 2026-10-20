import { buildAtoms, type WordInput } from "../../src/atoms";
import { createContext, type EngineContext } from "../../src/context";
import { sha256Hex } from "../../src/hash";
import type { Atom, Source } from "../../src/types";

/**
 * Synthetic single-speaker transcript, mirroring the planned ~3:20 recording
 * (see docs/TEST_VIDEO_SCRIPT.md). No media file exists: this is text + times only.
 *
 * Every sentence is [start second, ms per word, text]; words inside a sentence are
 * back to back, everything else is silence. The numbers the tests assert are
 * written out in FACTS below, not computed from this table, so a typo here
 * shows up as a failing test.
 */
const SENTENCES: ReadonlyArray<readonly [number, number, string]> = [
  [2.0, 400, "Hi everyone and thanks for watching."], // thanks #1
  [6.0, 400, "Um today I will show you something useful."], // filler um
  [12.0, 400, "I like this tool because it is fast."], // the only non-filler "like"
  [18.0, 400, "Uh let me explain how it works first."], // filler uh
  [24.0, 400, "It takes only a few minutes to set up."], // ends 27.6
  [28.0, 400, "Here we go."], // ends 29.2, then silence 29.2-31.0
  [31.0, 400, "First let me show the basic features."],
  [36.0, 400, "You can import media and edit it quickly."],
  [42.0, 500, "welcome to the channel."], // said once, 42.0-44.0
  [48.0, 400, "Thanks for joining me today."], // thanks #2
  [54.0, 400, "The editor works on any video file."],
  [60.0, 400, "Um the interface is very clean."], // filler um
  [65.0, 400, "Now let us talk about pricing."], // pricing #1, 65.0-67.4
  [68.0, 400, "It is free for personal projects."],
  [75.0, 400, "You can export videos without limits."],
  [82.0, 400, "I use it every single day."],
  [90.0, 400, "Honestly the speed is great."], // 90.0-92.0
  [98.0, 400, "Captions are generated from your words."],
  [108.0, 400, "The pricing for teams is different."], // pricing #2, 108.0-110.4, silence to 113.0
  [113.0, 400, "Teams get extra storage and support."],
  [130.0, 400, "Another thing is the music feature."],
  [140.0, 400, "Music ducks under your voice automatically."],
  [150.0, 400, "Thanks again for the support."], // thanks #3
  [160.0, 400, "One last word on pricing."], // pricing #3, 160.0-162.0
  [170.0, 400, "Um I hope this was helpful."], // filler um
  [178.0, 400, "Ask me anything in the comments."],
  [190.0, 400, "Thanks and see you next time."], // thanks #4
];

export const FPS = { num: 30, den: 1 };
export const DURATION_US = 200_000_000;
export const SOURCE_SHA = sha256Hex("incubrix-fixture-single-speaker-v1");

/** Hand-written expectations (microseconds) that tests assert against. */
export const FACTS = {
  durationUs: 200_000_000,
  welcome: { startUs: 42_000_000, endUs: 44_000_000 },
  silenceBeforeFirstCutPoint: { startUs: 29_200_000, endUs: 31_000_000 },
  pricing: [
    { startUs: 65_000_000, sentenceEndUs: 67_400_000, partEndUs: 68_000_000 }, // part = sentence + the silence after it
    { startUs: 108_000_000, sentenceEndUs: 110_400_000, partEndUs: 113_000_000 },
    { startUs: 160_000_000, sentenceEndUs: 162_000_000, partEndUs: 170_000_000 },
  ],
  honestly: { startUs: 90_000_000, endUs: 92_000_000 },
} as const;

function toWords(): WordInput[] {
  const words: WordInput[] = [];
  for (const [startSec, msPerWord, text] of SENTENCES) {
    text.split(" ").forEach((w, i) => {
      const startUs = startSec * 1_000_000 + i * msPerWord * 1000;
      const word: WordInput = { text: w, startUs, endUs: startUs + msPerWord * 1000, speaker: "S1" };
      if (w.toLowerCase() === "like") word.filler = false; // explicit: this "like" is not a filler
      words.push(word);
    });
  }
  return words;
}

export interface Fixture {
  source: Source;
  atoms: Atom[];
  ctx: EngineContext;
}

export function makeFixture(overrideWords?: (w: WordInput[]) => WordInput[], fps: { num: number; den: number } = FPS): Fixture {
  const words = overrideWords ? overrideWords(toWords()) : toWords();
  const atoms = buildAtoms(SOURCE_SHA, DURATION_US, words);
  const source: Source = { sha256: SOURCE_SHA, durationUs: DURATION_US, fps, hasAudio: true, hasVideo: true, variableFrameRate: false };
  return { source, atoms, ctx: createContext(source, atoms) };
}

/** The atom that starts exactly at `us` (fails loudly if the fixture changed). */
export function atomStartingAt(atoms: readonly Atom[], us: number): Atom {
  const a = atoms.find((x) => x.startUs === us);
  if (!a) throw new Error(`no atom starts at ${us}`);
  return a;
}

/** The atom that ends exactly at `us`. */
export function atomEndingAt(atoms: readonly Atom[], us: number): Atom {
  const a = atoms.find((x) => x.endUs === us);
  if (!a) throw new Error(`no atom ends at ${us}`);
  return a;
}
