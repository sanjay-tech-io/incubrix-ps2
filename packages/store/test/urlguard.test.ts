import { describe, expect, it } from "vitest";
import { assertUrlAllowed, isPrivateAddress } from "../src/index.ts";

describe("url guard", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"])("%s is private", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });
  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"])("%s is public", (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
  it("refuses non-http schemes, bad URLs and private literals", async () => {
    await expect(assertUrlAllowed("file:///etc/passwd", false)).rejects.toMatchObject({ code: "URL_NOT_ALLOWED" });
    await expect(assertUrlAllowed("ftp://x/y.mp4", false)).rejects.toMatchObject({ code: "URL_NOT_ALLOWED" });
    await expect(assertUrlAllowed("not a url", false)).rejects.toMatchObject({ code: "URL_NOT_ALLOWED" });
    await expect(assertUrlAllowed("http://127.0.0.1:9/a.mp4", false)).rejects.toMatchObject({ code: "URL_NOT_ALLOWED" });
    await expect(assertUrlAllowed("http://[::1]/a.mp4", false)).rejects.toMatchObject({ code: "URL_NOT_ALLOWED" });
  });
  it("allows a private address only when explicitly enabled (tests)", async () => {
    expect((await assertUrlAllowed("http://127.0.0.1:9/a.mp4", true)).hostname).toBe("127.0.0.1");
  });
});
