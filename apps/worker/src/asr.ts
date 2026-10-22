import { ApiError } from "@incubrix/errors";

/** One word as the ASR service returns it (integer microseconds and permille; see services/asr/asr/schema.py). */
export interface AsrWord {
  text: string;
  start_us: number;
  end_us: number;
  confidence_permille: number;
  speaker?: string | null;
  speaker_uncertain?: boolean | null;
  overlaps_speech?: boolean | null;
  possible_label_swap?: boolean | null;
}

export interface AsrResult {
  words: AsrWord[];
  /** Provider and model that produced the words, for the cache key and the manifest. */
  provider: string;
  model: string;
  diarizationProvider: string;
  speakersFound: number | null;
  /** Seconds of CPU-bound work reported by the ASR service (transcribe + diarize). */
  serviceSeconds: number;
  timings: Record<string, number | null>;
}

export interface AsrClient {
  readonly provider: string;
  readonly model: string;
  readonly diarizationProvider: string;
  transcribe(wav: Uint8Array, opts: { numSpeakers: number | null }): Promise<AsrResult>;
}

/** Calls services/asr over HTTP. Which engine runs there (faster-whisper or the fixture) is that service's own setting. */
export class HttpAsrClient implements AsrClient {
  readonly provider: string;
  readonly model: string;
  readonly diarizationProvider: string;
  private readonly url: string;
  private readonly timeoutMs: number;
  constructor(o: { url: string; provider: string; model: string; diarizationProvider: string; timeoutS: number }) {
    this.url = o.url.replace(/\/$/, "");
    this.provider = o.provider;
    this.model = o.model;
    this.diarizationProvider = o.diarizationProvider;
    this.timeoutMs = o.timeoutS * 1000;
  }

  async transcribe(wav: Uint8Array, opts: { numSpeakers: number | null }): Promise<AsrResult> {
    const form = new FormData();
    form.append("file", new Blob([wav as Uint8Array<ArrayBuffer>], { type: "audio/wav" }), "audio.wav");
    const q = new URLSearchParams({ diarize: this.diarizationProvider === "none" ? "false" : "true" });
    if (opts.numSpeakers !== null) q.set("num_speakers", String(opts.numSpeakers));
    let res: Response;
    try {
      res = await fetch(`${this.url}/transcribe?${q}`, { method: "POST", body: form, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new ApiError("ASR_UNAVAILABLE", `The speech-to-text service did not answer: ${(e as Error).message}`);
    }
    if (!res.ok) throw new ApiError("ASR_UNAVAILABLE", `The speech-to-text service answered HTTP ${res.status}`, { body: (await res.text()).slice(0, 500) });
    const t = (await res.json()) as { adapter: string; model: string; words: AsrWord[]; settings?: { diarization?: { speakers_found?: number } }; timings?: Record<string, unknown> };
    const timings = (t.timings ?? {}) as Record<string, unknown> & { diarization?: Record<string, unknown> };
    const num = (v: unknown): number => (typeof v === "number" ? v : 0);
    return {
      words: t.words,
      provider: t.adapter,
      model: t.model,
      diarizationProvider: this.diarizationProvider,
      speakersFound: t.settings?.diarization?.speakers_found ?? null,
      serviceSeconds: num(timings.transcribe_s) + num(timings.diarization?.process_s),
      timings: { asr_load_s: (timings.load_s as number | null) ?? null, asr_transcribe_s: (timings.transcribe_s as number | null) ?? null, diarization_process_s: (timings.diarization?.process_s as number | null) ?? null },
    };
  }
}

/** Test double for ASR_PROVIDER=mock: returns the words it was built with, whatever the audio is. */
export class MockAsrClient implements AsrClient {
  readonly provider = "mock";
  readonly model: string;
  readonly diarizationProvider: string;
  private readonly words: AsrWord[];
  calls = 0;
  /** What the last call was asked for, so tests can see the num_speakers hint arrive. */
  lastNumSpeakers: number | null | undefined;
  constructor(words: AsrWord[], diarizationProvider = "mock", model = "fixture") {
    this.words = words;
    this.diarizationProvider = diarizationProvider;
    this.model = model;
  }
  async transcribe(_wav: Uint8Array, opts: { numSpeakers: number | null }): Promise<AsrResult> {
    this.calls++;
    this.lastNumSpeakers = opts.numSpeakers;
    return { words: this.words, provider: "mock", model: this.model, diarizationProvider: this.diarizationProvider, speakersFound: new Set(this.words.map((w) => w.speaker).filter(Boolean)).size || null, serviceSeconds: 0, timings: {} };
  }
}

/** Built-in fixture so ASR_PROVIDER=mock works without a file: a short single-speaker sentence. */
export const DEFAULT_MOCK_WORDS: AsrWord[] = ["Hello", "and", "welcome", "to", "the", "mock", "transcript"].map((text, i) => ({
  text, start_us: 500_000 + i * 400_000, end_us: 500_000 + i * 400_000 + 350_000, confidence_permille: 950, speaker: "SPEAKER_00",
}));
