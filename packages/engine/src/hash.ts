import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { canonicalJson } from "./canonical";
import type { Timeline } from "./types";

// Why @noble/hashes and not node:crypto: the engine must not touch platform
// modules (lint-enforced), and a pure-JS SHA-256 gives the same bytes anywhere.

export function sha256Hex(input: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(input)));
}

/** timeline_hash = sha256(canonical JSON of the materialized timeline). Nothing time-of-day dependent is in a Timeline. */
export function timelineHash(timeline: Timeline): string {
  return sha256Hex(canonicalJson(timeline));
}
