// Why strings and BigInt-free integer math: ffprobe/ffmpeg print seconds as decimal text, and
// parseFloat(x) * 1e6 can be off by one microsecond. Engine time is integer microseconds.
export function secondsToUs(text: string): number {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) throw new Error(`not a decimal number of seconds: "${text}"`);
  const frac = (m[3] ?? "").padEnd(7, "0"); // 6 digits + 1 rounding digit
  let us = Number(m[2]) * 1_000_000 + Number(frac.slice(0, 6));
  if (Number(frac[6]) >= 5) us += 1;
  return m[1] ? -us : us;
}

export interface Fraction {
  num: number;
  den: number;
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

export function parseFraction(text: string): Fraction {
  const m = /^(\d+)(?:\/(\d+))?$/.exec(text.trim());
  if (!m) throw new Error(`not a fraction: "${text}"`);
  const num = Number(m[1]);
  const den = m[2] === undefined ? 1 : Number(m[2]);
  if (num === 0 || den === 0) throw new Error(`unknown frame rate "${text}"`);
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

// Formats integer microseconds as a decimal seconds string for ffmpeg arguments, e.g. 300000 -> "0.3".
export function usToSecondsText(us: number): string {
  const whole = Math.floor(us / 1_000_000);
  const frac = String(us % 1_000_000).padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}
