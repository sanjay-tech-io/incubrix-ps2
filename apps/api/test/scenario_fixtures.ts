import { makeFixture } from "../../../packages/engine/test/fixtures/transcript.ts";
import type { AsrWord } from "../../worker/src/asr.ts";
import type { ClipOptions } from "./clips.ts";

/**
 * Transcripts the mock ASR returns for the CI scenarios (scenarios/*.yaml, `fixture:`), and the generated clip each one is paired with.
 * The mock returns these words whatever the audio is, so the scenarios are about the EDITING (parsing, engine, API, render), not about speech recognition.
 * Nothing here is a real recording: the times are written by hand (the single-speaker one is the engine's worked-example fixture, docs/TEST_VIDEO_SCRIPT.md).
 */
export interface ScenarioFixture {
  words: AsrWord[];
  clip: ClipOptions;
}

const U = 1_000_000;
const word = (text: string, start: number, end: number, extra: Partial<AsrWord> = {}): AsrWord => ({ text, start_us: Math.round(start * U), end_us: Math.round(end * U), confidence_permille: 950, speaker: "SPEAKER_00", ...extra });

const single = makeFixture().atoms.filter((a) => a.kind === "word").map((a) => word(a.text, a.startUs / U, a.endUs / U, { speaker: "SPEAKER_00" }));

/** [start second, text, speaker, per-word flags by word index] */
type Line = [number, string, string, ((i: number) => Partial<AsrWord>)?];
function lines(ls: Line[], msPerWord = 400): AsrWord[] {
  return ls.flatMap(([start, text, speaker, flags]) => text.split(" ").map((t, i) => word(t, start + (i * msPerWord) / 1000, start + (i * msPerWord + msPerWord - 50) / 1000, { speaker, ...(flags ? flags(i) : {}) })));
}

const twoSpeakers = lines([
  [1, "Welcome to the show today we talk about careers.", "SPEAKER_00"],
  [8, "So tell me about your old job.", "SPEAKER_00"],
  [12, "My old job was in a factory.", "SPEAKER_01", (i) => ({ speaker_uncertain: i < 2 })],
  [18, "The old job was hard but I learned a lot.", "SPEAKER_01", () => ({ possible_label_swap: true })],
  [25, "And what do you do now.", "SPEAKER_00"],
  [29, "Now I build software and I love it.", "SPEAKER_01", (i) => ({ overlaps_speech: i === 3 })],
  [36, "Thanks for joining us today.", "SPEAKER_00"],
  [41, "Thanks for having me.", "SPEAKER_01"],
]);

const lowConfidence = single.map((w) => (w.text === "Honestly" ? { ...w, confidence_permille: 250 } : w));

/** The first 29 seconds of the single-speaker transcript, for the short variable-frame-rate phone clip. */
const phone = single.filter((w) => w.end_us <= 29_200_000);

export const FIXTURES: Record<string, ScenarioFixture> = {
  single: { words: single, clip: { seconds: 200 } },
  two_speakers: { words: twoSpeakers, clip: { seconds: 50 } },
  low_confidence: { words: lowConfidence, clip: { seconds: 200 } },
  phone_vfr: { words: phone, clip: { seconds: 30, vfr: true } },
  no_audio: { words: single, clip: { seconds: 20, audio: false } },
};
