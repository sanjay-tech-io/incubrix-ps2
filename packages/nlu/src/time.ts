/**
 * Spoken and written time expressions -> integer microseconds. Pure string work, no clock.
 * Handles: 1:30  0:30-0:40  80 seconds  a minute twenty  one minute and a half  1m20s  the last 10 seconds.
 */
const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

const U = 1_000_000;

/** "twenty five" -> "25", "a minute" -> "1 minute", "half a minute" -> "30 seconds". Only call it on text meant to hold times. */
export function wordsToDigits(input: string): string {
  let s = input.toLowerCase();
  const tens = Object.keys(TENS).join("|");
  const units = Object.keys(UNITS).filter((u) => UNITS[u]! >= 1 && UNITS[u]! <= 9).join("|");
  s = s.replace(new RegExp(`\\b(${tens})[\\s-]+(${units})\\b`, "g"), (_m, t: string, u: string) => String(TENS[t]! + UNITS[u]!));
  s = s.replace(new RegExp(`\\b(${tens})\\b`, "g"), (_m, t: string) => String(TENS[t]!));
  s = s.replace(new RegExp(`\\b(${Object.keys(UNITS).join("|")})\\b`, "g"), (_m, u: string) => String(UNITS[u]!));
  s = s.replace(/\bhalf an? (minute|min)\b/g, "30 seconds");
  s = s.replace(/\b(a|an)\s+(?=(?:minutes?|mins?|seconds?|secs?|hours?|hrs?)\b)/g, "1 ");
  s = s.replace(/(\d+)\s*(minutes?|mins?)\s*(?:and\s*)?(?:a\s*)?half\b/g, "$1 $2 30 seconds");
  return s;
}

export interface TimeAt {
  us: number;
  next: number;
  /** A number with no unit ("cut 30 to 40"): read as seconds, and the caller should warn. */
  bare: boolean;
}

const CLOCK = /^(\d+):(\d{2})(?::(\d{2}))?(\.\d+)?$/;
const COMPACT = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/;
const NUM = /^\d+(?:\.\d+)?$/;
const H = /^(hours?|hrs?|h)$/;
const M = /^(minutes?|mins?|m)$/;
const S = /^(seconds?|secs?|s)$/;

function us(n: number): number {
  return Math.round(n * U);
}

/** Read one time starting at tokens[i]. Tokens come from `tokenize`. */
export function parseTimeAt(tokens: readonly string[], i: number): TimeAt | null {
  const t = tokens[i];
  if (t === undefined) return null;
  const clock = CLOCK.exec(t);
  if (clock) {
    const a = Number(clock[1]);
    const b = Number(clock[2]);
    const c = clock[3] === undefined ? null : Number(clock[3]);
    const frac = clock[4] ? Number(clock[4]) : 0;
    // 1:30 = 1 min 30 s; 1:02:03 = 1 h 2 min 3 s
    const seconds = c === null ? a * 60 + b : a * 3600 + b * 60 + c;
    if (b >= 60 || (c !== null && c >= 60)) return null;
    return { us: us(seconds + frac), next: i + 1, bare: false };
  }
  const compact = COMPACT.exec(t);
  if (compact && t !== "" && /[hms]$/.test(t)) {
    return { us: us(Number(compact[1] ?? 0) * 3600 + Number(compact[2] ?? 0) * 60 + Number(compact[3] ?? 0)), next: i + 1, bare: false };
  }
  if (!NUM.test(t)) return null;
  let total = 0;
  let j = i;
  let sawUnit = false;
  // hours? minutes? seconds? in that order, each "<number> <unit>"; a lone number after minutes means seconds
  for (const [re, mult] of [[H, 3600], [M, 60], [S, 1]] as const) {
    const n = tokens[j];
    const unit = tokens[j + 1];
    if (n !== undefined && NUM.test(n) && unit !== undefined && re.test(unit)) {
      total += Number(n) * mult;
      j += 2;
      sawUnit = true;
      if (tokens[j] === "and") j += 1;
    }
  }
  if (sawUnit) {
    if (tokens[j] === "and") j -= 0;
    const n = tokens[j];
    const prevWasMinutes = j >= 2 && M.test(tokens[j - 1] ?? "");
    const stuck = tokens[j - 1] === "and" && j >= 3 && M.test(tokens[j - 2] ?? "");
    if (n !== undefined && NUM.test(n) && (prevWasMinutes || stuck) && !(tokens[j + 1] !== undefined && (H.test(tokens[j + 1]!) || M.test(tokens[j + 1]!)))) {
      total += Number(n); // "a minute twenty" = 1 minute 20 seconds
      j += 1;
    }
    return { us: us(total), next: j, bare: false };
  }
  return { us: us(Number(t)), next: i + 1, bare: true };
}

/** Lower-case words and numbers; "0:30-0:40" and "30 - 40" become "0:30 to 0:40"; punctuation is dropped. */
export function tokenize(text: string): string[] {
  const s = text
    .toLowerCase()
    .replace(/(\d)\s*[-–—]\s*(?=\d)/g, "$1 to ")
    .replace(/[,;!?"“”]/g, " ")
    .replace(/(?<!\d)\.(?!\d)/g, " ")
    .replace(/\.$/g, " ");
  return s.split(/\s+/).filter((x) => x.length > 0);
}

export interface TimeRange {
  startUs: number;
  endUs: number;
  /** Index of the first token after the range. */
  next: number;
  warnings: string[];
}

/**
 * Find a time range anywhere in the tokens. Forms: "<t> to <t>", "from <t> to <t>", "between <t> and <t>",
 * "the first <duration>", "the last <duration>" (needs the video length). Returns null when there is none.
 */
export function findRange(tokens: readonly string[], durationUs: number): TimeRange | null {
  for (let i = 0; i < tokens.length; i++) {
    const w = tokens[i];
    if ((w === "first" || w === "last") && i + 1 < tokens.length) {
      // "the last minute" has no number: treat the bare unit as 1
      const next = tokens[i + 1]!;
      const withOne = M.test(next) || S.test(next) || H.test(next) ? ["1", ...tokens.slice(i + 1)] : tokens.slice(i + 1);
      const d = parseTimeAt(withOne, 0);
      if (d && !d.bare) {
        const consumed = i + 1 + (M.test(next) || S.test(next) || H.test(next) ? d.next - 1 : d.next);
        return w === "first"
          ? { startUs: 0, endUs: d.us, next: consumed, warnings: [] }
          : { startUs: Math.max(0, durationUs - d.us), endUs: durationUs, next: consumed, warnings: [] };
      }
    }
    const t1 = parseTimeAt(tokens, i);
    if (!t1) continue;
    const sep = tokens[t1.next];
    const okSep = sep === "to" || sep === "until" || sep === "through" || (sep === "and" && tokens[i - 1] === "between");
    if (!okSep) continue;
    const t2 = parseTimeAt(tokens, t1.next + 1);
    if (!t2) continue;
    const warnings = t1.bare || t2.bare ? ["A time had no unit; I read it as seconds."] : [];
    return { startUs: t1.us, endUs: t2.us, next: t2.next, warnings };
  }
  return null;
}

/** A single time ("at 5:00", "after 1:30", "to 2:00"). */
export function findTimeAfter(tokens: readonly string[], keywords: readonly string[]): { us: number; warnings: string[] } | null {
  for (let i = 0; i < tokens.length - 1; i++) {
    if (!keywords.includes(tokens[i]!)) continue;
    const t = parseTimeAt(tokens, i + 1);
    if (t) return { us: t.us, warnings: t.bare ? ["A time had no unit; I read it as seconds."] : [] };
  }
  return null;
}
