import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ApiError } from "@incubrix/errors";

function privateV4(a: number[]): boolean {
  const [p, q] = a as [number, number];
  return p === 10 || p === 127 || p === 0 || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 100 && q >= 64 && q <= 127) || p >= 224;
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return privateV4(ip.split(".").map(Number));
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return privateV4(mapped[1]!.split(".").map(Number));
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb");
}

/**
 * Refuse URLs that are not http(s) or that resolve to a private/loopback address (SSRF).
 * Known gap: the check resolves the name itself, then fetch resolves it again, so a DNS-rebinding attacker could
 * still win that race. Not hardened further in M2.
 */
export async function assertUrlAllowed(raw: string, allowPrivate: boolean): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ApiError("URL_NOT_ALLOWED", "The video URL is not a valid URL.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new ApiError("URL_NOT_ALLOWED", `Only http(s) URLs are accepted, not ${u.protocol}`);
  if (allowPrivate) return u;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addrs.length === 0) throw new ApiError("URL_NOT_ALLOWED", `The host "${host}" does not resolve.`);
  if (addrs.some(isPrivateAddress)) throw new ApiError("URL_NOT_ALLOWED", "The URL points to a private or loopback address.");
  return u;
}
