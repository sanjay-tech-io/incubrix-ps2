import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical";
import { sha256Hex } from "../src/hash";

describe("canonicalJson", () => {
  it("sorts object keys at every depth and writes no whitespace", () => {
    // Expected string written by hand, not produced by the code under test.
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }], z: null })).toBe('{"a":[2,{"c":2,"d":1}],"b":1,"z":null}');
  });

  it("is independent of key insertion order", () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  it("keeps array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("escapes strings like JSON", () => {
    expect(canonicalJson({ s: 'a"b\n' })).toBe('{"s":"a\\"b\\n"}');
  });

  it.each([
    ["a float", { t: 1.5 }],
    ["NaN", { t: NaN }],
    ["Infinity", { t: Infinity }],
    ["undefined", { t: undefined }],
    ["undefined in array", [undefined]],
    ["a function", { f: () => 1 }],
    ["a bigint", { n: 1n }],
    ["an unsafe integer", { n: 2 ** 60 }],
  ])("throws on %s", (_name, value) => {
    expect(() => canonicalJson(value)).toThrow();
  });
});

describe("sha256Hex (pure JS) agrees with node:crypto, used here only as an independent oracle", () => {
  it.each(["", "abc", "timeline", "héllo wörld ✓", "x".repeat(10_000)])("input of length %#", (s) => {
    expect(sha256Hex(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
  });

  it("matches the published SHA-256 test vector for 'abc'", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
