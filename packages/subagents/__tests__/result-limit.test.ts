import { describe, it, expect } from "vitest";
import { RESULT_TEXT_LIMIT, boundResultText, truncationNotice } from "../result-limit.ts";

// ---------------------------------------------------------------------------
// Bounded result text — fixed limit, boundaries, multibyte, notice
// ---------------------------------------------------------------------------

const ascii = "a";

/** ASCII string of exactly n bytes. */
function asciiOf(n: number): string {
  return ascii.repeat(n);
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

// Emoji occupies 4 UTF-8 bytes.
const emoji = "😀";

describe("result text limit", () => {
  it("is fixed at 20,000 bytes", () => {
    expect(RESULT_TEXT_LIMIT).toBe(20_000);
  });

  it("passes text at exactly the limit through unchanged", () => {
    const text = asciiOf(RESULT_TEXT_LIMIT);
    const out = boundResultText(text);
    expect(out.text).toBe(text);
    expect(out.truncated).toBe(false);
    expect(out.originalBytes).toBe(RESULT_TEXT_LIMIT);
    expect(out.retainedBytes).toBe(RESULT_TEXT_LIMIT);
  });

  it("truncates to the first 20,000 bytes with one byte over the limit", () => {
    const text = asciiOf(RESULT_TEXT_LIMIT) + "X";
    const out = boundResultText(text);
    expect(out.truncated).toBe(true);
    expect(out.originalBytes).toBe(RESULT_TEXT_LIMIT + 1);
    expect(out.retainedBytes).toBe(RESULT_TEXT_LIMIT);
    expect(out.text).toBe(asciiOf(RESULT_TEXT_LIMIT));
  });

  it("never splits a multibyte character at the limit boundary", () => {
    // 5004 emoji = 20,016 bytes; the 20,000-byte cut falls inside an emoji.
    const text = emoji.repeat(5004);
    expect(byteLength(text)).toBe(20_016);
    const out = boundResultText(text);
    expect(out.truncated).toBe(true);
    expect(out.originalBytes).toBe(20_016);
    // Retained text must be complete characters only: byte length must be a
    // multiple of 4 and decoding is exact — the retained text is a true prefix
    // of the original.
    expect(out.retainedBytes % 4).toBe(0);
    expect(out.retainedBytes).toBeLessThanOrEqual(RESULT_TEXT_LIMIT);
    expect(text.startsWith(out.text)).toBe(true);
    expect(out.text).toBe(emoji.repeat(out.retainedBytes / 4));
  });

  it("accepts multibyte text ending exactly on the limit", () => {
    // 5000 emoji = exactly 20,000 bytes.
    const text = emoji.repeat(5000);
    const out = boundResultText(text);
    expect(out.truncated).toBe(false);
    expect(out.text).toBe(text);
    expect(out.retainedBytes).toBe(RESULT_TEXT_LIMIT);
  });

  it("keeps the beginning of mixed multibyte text", () => {
    const head = emoji.repeat(1000); // 4,000 bytes
    const rest = asciiOf(RESULT_TEXT_LIMIT); // total 24,000 bytes
    const out = boundResultText(head + rest);
    expect(out.truncated).toBe(true);
    expect(out.originalBytes).toBe(24_000);
    expect(out.text.startsWith(head)).toBe(true);
    expect(byteLength(out.text)).toBeLessThanOrEqual(RESULT_TEXT_LIMIT);
  });

  it("reports zero-length and small texts as untruncated", () => {
    const out = boundResultText("");
    expect(out).toEqual({ text: "", truncated: false, originalBytes: 0, retainedBytes: 0 });
  });

  it("composes the truncation notice outside the result-text limit", () => {
    // The bounded text alone may occupy the full limit; the notice must add
    // on top of it rather than consuming the byte budget.
    const text = asciiOf(RESULT_TEXT_LIMIT) + " tail";
    const out = boundResultText(text);
    expect(byteLength(out.text)).toBe(RESULT_TEXT_LIMIT);
    const notice = truncationNotice(out);
    expect(notice.length).toBeGreaterThan(0);
    expect(notice).not.toContain(asciiOf(RESULT_TEXT_LIMIT)); // notice is its own text
    expect(notice).toContain("20,000");
    expect(notice).toContain("20,005");
    expect(notice).toContain(byteLength(text).toLocaleString("en-US"));
  });

  it("returns an empty notice when text is not truncated", () => {
    expect(truncationNotice(boundResultText("short"))).toBe("");
  });
});