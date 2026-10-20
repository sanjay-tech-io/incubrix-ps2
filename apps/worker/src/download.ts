import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ApiError } from "@incubrix/errors";
import { assertUrlAllowed } from "@incubrix/store";

const MAX_REDIRECTS = 3;

export interface Downloaded {
  sha256: string;
  size: number;
  contentType: string | null;
}

/** Stream a URL to a file, hashing as it goes. Re-checks every redirect hop and enforces the size cap while reading (not only the header). */
export async function downloadUrl(rawUrl: string, dest: string, o: { maxBytes: number; allowPrivate: boolean; timeoutMs?: number }): Promise<Downloaded> {
  let url = (await assertUrlAllowed(rawUrl, o.allowPrivate)).toString();
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(o.timeoutMs ?? 600_000) });
    } catch (e) {
      throw new ApiError("DOWNLOAD_FAILED", `Could not download the video: ${(e as Error).message}`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (hop >= MAX_REDIRECTS) throw new ApiError("URL_NOT_ALLOWED", `The URL redirects more than ${MAX_REDIRECTS} times.`);
      url = (await assertUrlAllowed(new URL(res.headers.get("location")!, url).toString(), o.allowPrivate)).toString();
      continue;
    }
    if (!res.ok || !res.body) throw new ApiError("DOWNLOAD_FAILED", `The video URL answered HTTP ${res.status}.`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > o.maxBytes) throw new ApiError("FILE_TOO_LARGE", `The file is ${declared} bytes; the limit is ${o.maxBytes}.`);
    const hash = createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > o.maxBytes) return cb(new ApiError("FILE_TOO_LARGE", `The download is larger than the limit of ${o.maxBytes} bytes.`));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), meter, createWriteStream(dest));
    return { sha256: hash.digest("hex"), size, contentType: res.headers.get("content-type") };
  }
}
