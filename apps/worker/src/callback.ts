import { createHmac, timingSafeEqual } from "node:crypto";

/** "sha256=<hex>" of the raw body. The receiver recomputes it with the shared secret (CALLBACK_HMAC_SECRET). */
export function signBody(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

export function verifySignature(secret: string, body: string, header: string): boolean {
  const want = Buffer.from(signBody(secret, body));
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

export interface CallbackResult {
  delivered: boolean;
  attempts: number;
  status?: number;
  error?: string;
}

/** POST the job JSON, signed when a secret is configured. Up to 3 attempts (1 s, 2 s apart). Never throws: a dead callback must not fail the job. */
export async function sendCallback(url: string, payload: object, secret: string | undefined, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<CallbackResult> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) headers["X-IncuBrix-Signature"] = signBody(secret, body);
  let last: CallbackResult = { delivered: false, attempts: 0 };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
      last = { delivered: r.ok, attempts: attempt, status: r.status };
      if (r.ok) return last;
    } catch (e) {
      last = { delivered: false, attempts: attempt, error: (e as Error).message };
    }
    if (attempt < 3) await sleep(attempt * 1000);
  }
  return last;
}
