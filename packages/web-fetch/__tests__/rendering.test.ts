/**
 * Web Fetch tool rendering tests — Vitest.
 *
 * Verifies user-facing call/result presentation through the public render
 * helpers, using a plain theme that strips ANSI codes so the assertions
 * depend on text shape, not on incidental styling.
 *
 * Run: pnpm test  (from this package)
 */

import { describe, it, expect } from "vitest";
import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { renderWebFetchCall, renderWebFetchResult } from "../render.ts";
import type { WebFetchDetails } from "../fetch.ts";

// Plain theme: pass-through, no styling.
const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

// ─── Helpers ────────────────────────────────────────────────────────────────

function callText(args: { url?: string }): string {
  return renderWebFetchCall(args, plainTheme).render(80).join("\n");
}

function resultText(
  result: AgentToolResult<WebFetchDetails>,
  isPartial = false,
  expanded = false,
): string {
  return renderWebFetchResult(result, { isPartial, expanded }, plainTheme, undefined)
    .render(80)
    .join("\n");
}

function makeDetails(overrides: Partial<WebFetchDetails> = {}): WebFetchDetails {
  return {
    url: "https://example.com/article",
    title: "",
    contentType: "text/html",
    contentLength: 0,
    source: "html",
    artifactPath: "/tmp/pi-web-fetch/sess-1/run-1/call-1-artifact.md",
    artifactComplete: true,
    ...overrides,
  };
}

function makeResult(content: string, details?: WebFetchDetails): AgentToolResult<WebFetchDetails> {
  return {
    content: [{ type: "text" as const, text: content }],
    details,
  } as AgentToolResult<WebFetchDetails>;
}

// ─── renderWebFetchCall ────────────────────────────────────────────────────

describe("renderWebFetchCall", () => {
  it("shows the 'Web Fetch' label and the URL", () => {
    expect(callText({ url: "https://example.com/page" })).toContain("Web Fetch");
    expect(callText({ url: "https://example.com/page" })).toContain("example.com/page");
  });

  it("truncates an overlong URL and falls back to '(no URL)'", () => {
    const longUrl = "https://example.com/" + "a".repeat(100);
    expect(callText({ url: longUrl }).length).toBeLessThan(longUrl.length);
    expect(callText({})).toContain("(no URL)");
  });
});

// ─── renderWebFetchResult — collapsed ───────────────────────────────────────

describe("renderWebFetchResult (collapsed)", () => {
  it("shows check + URL + title + content size", () => {
    const details = makeDetails({ title: "Test Article", contentLength: 1500 });
    const text = resultText(makeResult("Content...", details));

    expect(text).toContain("✓");
    expect(text).toContain("Test Article");
    expect(text).toContain("1500 chars");
  });

  it("shows the [PDF] badge for a PDF result", () => {
    const details = makeDetails({ url: "https://example.com/doc.pdf", source: "pdf", pageCount: 5 });
    expect(resultText(makeResult("PDF text", details))).toContain("[PDF]");
  });

  it("renders without a title when none is provided", () => {
    const details = makeDetails({ title: "", contentLength: 500 });
    expect(resultText(makeResult("Source: ...", details))).toContain("500 chars");
  });
});

// ─── renderWebFetchResult — expanded ────────────────────────────────────────

describe("renderWebFetchResult (expanded)", () => {
  it("shows title, URL, content-type, size, artifact path, and body", () => {
    const content = "# Article Title\n\nSource: https://example.com/article\n\nFull text here.";
    const details = makeDetails({
      url: "https://example.com/article",
      title: "Article Title",
      contentType: "text/html",
      contentLength: 1500,
      artifactPath: "/tmp/pi-web-fetch/sess-1/run/c1.md",
    });
    const text = resultText(makeResult(content, details), false, true);

    expect(text).toContain("Article Title");
    expect(text).toContain("Content-Type: text/html");
    expect(text).toContain("Content: 1500 chars");
    expect(text).toContain("Artifact: /tmp/pi-web-fetch/sess-1/run/c1.md");
    expect(text).toContain("Full text here");
  });

  it("explains artifact session lifetime", () => {
    const details = makeDetails({ artifactPath: "/tmp/pi-web-fetch/sess-1/run/c1.md" });
    const text = resultText(makeResult("Body", details), false, true);

    expect(text).toMatch(/Deleted when you leave this session/);
  });

  it("truncates a long body with an ellipsis", () => {
    const longBody = "Paragraph text. ".repeat(150);
    const details = makeDetails({ contentLength: longBody.length + 50 });
    expect(resultText(makeResult(longBody, details), false, true)).toContain("…");
  });

  it("shows page count for a PDF result", () => {
    const details = makeDetails({
      url: "https://example.com/doc.pdf",
      title: "PDF Document",
      contentType: "application/pdf",
      contentLength: 5000,
      source: "pdf",
      pageCount: 15,
    });
    const text = resultText(makeResult("PDF text content", details), false, true);

    expect(text).toContain("[pdf]");
    expect(text).toContain("Pages: 15");
    expect(text).not.toContain("truncated");
  });

  it("shows truncation note and partial-artifact warning when a PDF exceeds the limit", () => {
    const details = makeDetails({
      url: "https://example.com/large.pdf",
      title: "Large PDF",
      contentType: "application/pdf",
      contentLength: 500_000,
      source: "pdf",
      pageCount: 100,
      truncated: true,
      artifactComplete: false,
    });
    const text = resultText(makeResult("Truncated PDF content", details), false, true);

    expect(text).toContain("Pages: 100");
    expect(text).toContain("truncated");
    expect(text).toContain("Warning: artifact is partial");
  });

  it("does not warn about a partial artifact when it is complete", () => {
    const details = makeDetails({});
    const text = resultText(makeResult("Body", details), false, true);
    expect(text).not.toContain("artifact is partial");
  });
});

// ─── Extraction warning display ────────────────────────────────────────────

describe("renderWebFetchResult — extraction warning", () => {
  const WARNING = "Very little content extracted (30 chars)";

  it("shows the warning in expanded mode and hides it when collapsed", () => {
    const details = makeDetails({
      url: "https://example.com/dynamic",
      title: "Dynamic",
      contentLength: 30,
      extractionWarning: WARNING,
    });
    const expanded = resultText(makeResult("Short", details), false, true);
    const collapsed = resultText(makeResult("Short", details), false, false);

    expect(expanded).toContain("Warning:");
    expect(expanded).toContain(WARNING);
    expect(collapsed).not.toContain("Warning:");
  });
});

// ─── Missing details fallback ──────────────────────────────────────────────

describe("renderWebFetchResult — missing details fallback", () => {
  it("renders raw content when details are absent", () => {
    const result: AgentToolResult<WebFetchDetails> = {
      content: [{ type: "text" as const, text: "Fetched content here" }],
    } as AgentToolResult<WebFetchDetails>;
    expect(resultText(result)).toContain("Fetched content here");
  });
});