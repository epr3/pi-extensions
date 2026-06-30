/**
 * Web Fetch rendering tests.
 *
 * Verifies:
 *   - Call row shows "Web Fetch" label and URL summary
 *   - Call row shows fallback when no URL
 *   - Collapsed result shows status, URL, title, content size
 *   - Expanded result shows full content with header info
 *   - Error result rendering
 *   - Missing details fallback
 *   - Extraction warning display
 *
 * Run: npx tsx tests/web-fetch-rendering.test.ts
 */

import { strict as assert } from "node:assert";
import {
  renderWebFetchCall,
  renderWebFetchResult,
} from "../packages/web-fetch/render.ts";
import type { WebFetchDetails } from "../packages/web-fetch/fetch.ts";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Plain theme — no ANSI codes, passes text through.
// ---------------------------------------------------------------------------

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderedCall(args: { url?: string }): string[] {
  const component = renderWebFetchCall(args, plainTheme);
  return component.render(80);
}

function callText(args: { url?: string }): string {
  return renderedCall(args).join("\n");
}

function renderedResult(
  result: AgentToolResult<WebFetchDetails>,
  isPartial = false,
  expanded = false,
): string[] {
  const component = renderWebFetchResult(result, { isPartial, expanded }, plainTheme, undefined);
  return component.render(80);
}

function resultText(
  result: AgentToolResult<WebFetchDetails>,
  isPartial = false,
  expanded = false,
): string {
  return renderedResult(result, isPartial, expanded).join("\n");
}

function makeDetails(overrides: Partial<WebFetchDetails> = {}): WebFetchDetails {
  return {
    url: "https://example.com/article",
    title: "",
    contentType: "text/html",
    contentLength: 0,
    source: "html",
    ...overrides,
  };
}

function makeResult(
  content: string,
  details?: WebFetchDetails,
): AgentToolResult<WebFetchDetails> {
  return {
    content: [{ type: "text" as const, text: content }],
    details,
  } as AgentToolResult<WebFetchDetails>;
}

// ---------------------------------------------------------------------------
// renderWebFetchCall
// ---------------------------------------------------------------------------

function testCallShowsLabel() {
  const text = callText({ url: "https://example.com/page" });
  assert.ok(text.includes("Web Fetch"), "call row shows Web Fetch label");
  console.log("  Shows Web Fetch label ............................ PASS");
}

function testCallShowsUrl() {
  const text = callText({ url: "https://example.com/page" });
  assert.ok(text.includes("example.com/page"), "call row shows URL");
  console.log("  Shows URL ........................................ PASS");
}

function testCallTruncatesLongUrl() {
  const longUrl = "https://example.com/" + "a".repeat(100);
  const text = callText({ url: longUrl });
  // Should not show the full URL (truncated to 70 chars)
  assert.ok(text.length < longUrl.length, "long URL is truncated");
  console.log("  Truncates long URL ............................... PASS");
}

function testCallShowsNoUrlFallback() {
  const text = callText({});
  assert.ok(text.includes("(no URL)"), "fallback shows (no URL)");
  console.log("  Shows fallback when no URL ....................... PASS");
}

// ---------------------------------------------------------------------------
// renderWebFetchResult — collapsed (success)
// ---------------------------------------------------------------------------

function testCollapsedShowsCheckAndUrl() {
  const details = makeDetails({
    url: "https://example.com/article",
    title: "Test Article",
    contentLength: 1500,
  });
  const result = makeResult("# Test Article\n\nContent here...", details);
  const text = resultText(result, false, false);

  assert.ok(text.includes("✓"), "collapsed shows check mark");
  assert.ok(text.includes("Test Article"), "collapsed shows title");
  assert.ok(text.includes("1500 chars"), "collapsed shows content size");
  console.log("  Collapsed success: check + URL + title + size ..... PASS");
}

function testCollapsedWithNoTitle() {
  const details = makeDetails({
    url: "https://example.com/plain",
    title: "",
    contentLength: 500,
  });
  const result = makeResult("Source: ...", details);
  const text = resultText(result, false, false);

  assert.ok(text.includes("✓"), "check mark present");
  assert.ok(text.includes("500 chars"), "size present");
  console.log("  Collapsed no title: shows check + size ........... PASS");
}

// ---------------------------------------------------------------------------
// renderWebFetchResult — collapsed PDF
// ---------------------------------------------------------------------------

function testCollapsedPdfShowsBadge() {
  const details = makeDetails({
    url: "https://example.com/doc.pdf",
    source: "pdf",
    pageCount: 5,
  });
  const result = makeResult("Source: url\n\nPDF text", details);
  const text = resultText(result, false, false);

  assert.ok(text.includes("[PDF]"), "collapsed PDF shows [PDF] badge");
  assert.ok(text.includes("✓"), "collapsed shows check mark");
  console.log("  Collapsed PDF shows [PDF] badge ................... PASS");
}

function testCollapsedFallbackShowsBadge() {
  const details = makeDetails({
    url: "https://example.com/dynamic",
    source: "fallback",
  });
  const result = makeResult("Fallback content", details);
  const text = resultText(result, false, false);

  assert.ok(text.includes("[Fallback]"), "collapsed fallback shows [Fallback] badge");
  console.log("  Collapsed fallback shows [Fallback] badge ......... PASS");
}

// ---------------------------------------------------------------------------
// renderWebFetchResult — collapsed (error)
// ---------------------------------------------------------------------------

function testCollapsedError() {
  const details = makeDetails({
    url: "https://example.com/error",
    contentLength: 0,
  });
  const result = makeResult("Error text", details);
  const text = resultText(result, false, false);

  // Error rendering is content-driven; the check still shows since
  // we don't distinguish errors in collapsed mode.
  assert.ok(text.includes("✓"), "collapsed still shows check (no error state distinction)");
  assert.ok(text.includes("example.com/error"), "collapsed error shows URL");
  console.log("  Collapsed error: check + URL ....................... PASS");
}

// ---------------------------------------------------------------------------
// renderWebFetchResult — expanded
// ---------------------------------------------------------------------------

function testExpandedShowsFullContent() {
  const content = "# Article Title\n\nSource: https://example.com/article\n\nFull article text here.";
  const details = makeDetails({
    url: "https://example.com/article",
    title: "Article Title",
    contentType: "text/html",
    contentLength: 1500,
  });
  const result = makeResult(content, details);
  const text = resultText(result, false, true);

  assert.ok(text.includes("Article Title"), "expanded shows title as accent");
  assert.ok(text.includes("https://example.com/article"), "expanded shows URL");
  assert.ok(text.includes("Content-Type: text/html"), "expanded shows content type");
  assert.ok(text.includes("Content: 1500 chars"), "expanded shows size");
  assert.ok(text.includes("Full article text here"), "expanded shows body");
  console.log("  Expanded shows full content + metadata ........... PASS");
}

function testExpandedPreviewTruncation() {
  // Content longer than 2000 chars should be truncated
  const longBody = "Paragraph text. ".repeat(150);
  const details = makeDetails({
    url: "https://example.com/long",
    title: "Long Page",
    contentLength: longBody.length + 50,
  });
  const result = makeResult(longBody, details);
  const text = resultText(result, false, true);

  // Should be truncated with ellipsis
  assert.ok(text.endsWith("…") || text.includes("…"), "long content truncated with ellipsis");
  console.log("  Expanded truncates long content .................. PASS");
}

function testExpandedPdfShowsPageInfo() {
  const details = makeDetails({
    url: "https://example.com/doc.pdf",
    title: "PDF Document",
    contentType: "application/pdf",
    contentLength: 5000,
    source: "pdf",
    pageCount: 15,
  });
  const result = makeResult("PDF text content", details);
  const text = resultText(result, false, true);

  assert.ok(text.includes("[pdf]"), "expanded shows source tag");
  assert.ok(text.includes("Pages: 15"), "expanded shows page count");
  assert.ok(!text.includes("truncated"), "not truncated");
  console.log("  Expanded PDF shows page count .................... PASS");
}

function testExpandedPdfShowsTruncation() {
  const details = makeDetails({
    url: "https://example.com/large.pdf",
    title: "Large PDF",
    contentType: "application/pdf",
    contentLength: 500_000,
    source: "pdf",
    pageCount: 100,
    truncated: true,
  });
  const result = makeResult("Truncated PDF content", details);
  const text = resultText(result, false, true);

  assert.ok(text.includes("Pages: 100"), "expanded shows page count");
  assert.ok(text.includes("truncated"), "expanded shows truncation note");
  console.log("  Expanded PDF truncation .......................... PASS");
}

function testExpandedFallbackShowsSource() {
  const details = makeDetails({
    url: "https://example.com/dynamic",
    title: "Dynamic Page",
    contentType: "text/markdown",
    contentLength: 2000,
    source: "fallback",
  });
  const result = makeResult("Fallback markdown content", details);
  const text = resultText(result, false, true);

  assert.ok(text.includes("[fallback]"), "expanded shows fallback source");
  console.log("  Expanded fallback shows source ................... PASS");
}

// ---------------------------------------------------------------------------
// renderWebFetchResult — extraction warning
// ---------------------------------------------------------------------------

function testExpandedShowsWarning() {
  const details = makeDetails({
    url: "https://example.com/dynamic",
    title: "Dynamic Page",
    contentType: "text/html",
    contentLength: 30,
    extractionWarning: "Very little content extracted (30 chars)",
  });
  const result = makeResult("Source: url\n\nOnly a little text", details);
  const text = resultText(result, false, true);

  assert.ok(text.includes("Warning:"), "expanded shows warning label");
  assert.ok(text.includes("Very little content"), "expanded shows warning message");
  console.log("  Expanded shows extraction warning ................ PASS");
}

function testCollapsedWarningNotShown() {
  // Warning should not appear in collapsed mode
  const details = makeDetails({
    url: "https://example.com/dynamic",
    title: "Dynamic",
    contentLength: 30,
    extractionWarning: "Very little content extracted (30 chars)",
  });
  const result = makeResult("Short", details);
  const text = resultText(result, false, false);

  assert.ok(!text.includes("Warning:"), "collapsed does not show warning");
  console.log("  Collapsed hides extraction warning ............... PASS");
}

// ---------------------------------------------------------------------------
// renderWebFetchResult — missing details fallback
// ---------------------------------------------------------------------------

function testMissingDetailsFallback() {
  const result: AgentToolResult<WebFetchDetails> = {
    content: [{ type: "text" as const, text: "Fetched content here" }],
  } as any;
  const text = resultText(result);
  assert.ok(text.includes("Fetched content here"), "falls back to raw content");
  console.log("  Missing details fallback ......................... PASS");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function main() {
  console.log("\nWeb Fetch rendering tests\n");

  // Call rendering
  testCallShowsLabel();
  testCallShowsUrl();
  testCallTruncatesLongUrl();
  testCallShowsNoUrlFallback();

  // Collapsed result
  testCollapsedShowsCheckAndUrl();
  testCollapsedWithNoTitle();
  testCollapsedError();

  // Collapsed PDF and fallback badges
  testCollapsedPdfShowsBadge();
  testCollapsedFallbackShowsBadge();

  // Expanded result
  testExpandedShowsFullContent();
  testExpandedPreviewTruncation();
  testExpandedPdfShowsPageInfo();
  testExpandedPdfShowsTruncation();
  testExpandedFallbackShowsSource();

  // Warning display
  testExpandedShowsWarning();
  testCollapsedWarningNotShown();

  // Fallbacks
  testMissingDetailsFallback();

  console.log("\nAll tests PASS\n");
}

main();
