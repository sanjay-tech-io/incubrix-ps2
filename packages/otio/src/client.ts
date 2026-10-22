import { ApiError } from "@incubrix/errors";
import { mockOtioJson } from "./mock.ts";
import type { OtioPayload } from "./payload.ts";

/** The exporter behind OTIO_PROVIDER: `http` = services/otio (the OpenTimelineIO library), `mock` = hand-written JSON. */
export interface OtioExporter {
  readonly provider: string;
  /** Text of the .otio file. */
  export(payload: OtioPayload): Promise<string>;
}

export class MockOtioExporter implements OtioExporter {
  readonly provider = "mock";
  async export(payload: OtioPayload): Promise<string> {
    return mockOtioJson(payload);
  }
}

export class HttpOtioExporter implements OtioExporter {
  readonly provider = "opentimelineio";
  private readonly url: string;
  private readonly timeoutMs: number;
  constructor(o: { url: string; timeoutMs?: number }) {
    this.url = o.url.replace(/\/$/, "");
    this.timeoutMs = o.timeoutMs ?? 30_000;
  }
  async export(payload: OtioPayload): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${this.url}/export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new ApiError("SERVICE_UNAVAILABLE", `The OpenTimelineIO export service did not answer: ${(e as Error).message}`);
    }
    if (!res.ok) throw new ApiError("SERVICE_UNAVAILABLE", `The OpenTimelineIO export service answered HTTP ${res.status}`, { body: (await res.text()).slice(0, 500) });
    return res.text();
  }
}
