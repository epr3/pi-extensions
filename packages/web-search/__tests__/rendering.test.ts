/**
 * Web Search tool rendering tests — Vitest.
 *
 * Verifies user-facing call/result presentation through the public render
 * helpers, using a plain theme that strips ANSI codes so the assertions
 * depend on text shape, not on incidental styling.
 *
 * Run: pnpm test  (from this package)
 */

import { describe, it, expect } from "vitest";
import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { renderWebSearchCall, renderWebSearchResult } from "../render.ts";
import type { SearchResponseDetails } from "../search.ts";

// Plain theme: pass-through, no styling.
const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

// ─── Helpers ────────────────────────────────────────────────────────────────

function callText(args: { query?: string; exactPhrases?: string[]; site?: string }): string {
  return renderWebSearchCall(args, plainTheme).render(80).join("\n");
}

function resultText(
  result: AgentToolResult<SearchResponseDetails>,
  isPartial = false,
  expanded = false,
): string {
  return renderWebSearchResult(result, { isPartial, expanded }, plainTheme, undefined)
    .render(80)
    .join("\n");
}

function makeDetails(overrides: Partial<SearchResponseDetails> = {}): SearchResponseDetails {
  return {
    normalizedQuery: "test query",
    exactPhrases: [],
    excludeTerms: [],
    siteRestriction: null,
    resultCount: 5,
    composedQuery: "test query",
    ...overrides,
  };
}

function makeResult(
  content: string,
  details?: SearchResponseDetails,
): AgentToolResult<SearchResponseDetails> {
  return {
    content: [{ type: "text" as const, text: content }],
    details,
  } as AgentToolResult<SearchResponseDetails>;
}

// ─── renderWebSearchCall ────────────────────────────────────────────────────

describe("renderWebSearchCall", () => {
  it("shows the 'Web Search' tool label", () => {
    expect(callText({ query: "typescript patterns" })).toContain("Web Search");
  });

  it("shows the base query", () => {
    expect(callText({ query: "typescript patterns" })).toContain("typescript patterns");
  });

  it("quotes each exact phrase", () => {
    expect(callText({ query: "patterns", exactPhrases: ["design patterns"] })).toContain(
      '"design patterns"',
    );
  });

  it("shows the site restriction as `site:<host>`", () => {
    expect(callText({ query: "patterns", site: "github.com" })).toContain("site:github.com");
  });

  it("keeps all three sources (query, exactPhrases, site) visible together", () => {
    // The renderer caps at 3 parts and joins exactPhrases into a single
    // part, so this exercises the full allowed composition.
    const text = callText({
      query: "a",
      exactPhrases: ["b", "c", "d", "e"],
      site: "example.com",
    });
    expect(text).toContain("a");
    expect(text).toContain('"b" "c" "d" "e"');
    expect(text).toContain("site:example.com");
  });

  it("falls back to 'no query' when the call has no input", () => {
    expect(callText({})).toContain("no query");
  });
});

// ─── renderWebSearchResult — collapsed ──────────────────────────────────────

describe("renderWebSearchResult (collapsed)", () => {
  it("shows the result count", () => {
    const details = makeDetails({ resultCount: 3 });
    const result = makeResult(
      "Found 3 results for: test query\n\n1. Title\n   https://example.com\n   Snippet",
      details,
    );
    expect(resultText(result)).toContain("3 results");
  });

  it("shows 'no results' when the result count is zero", () => {
    const details = makeDetails({ resultCount: 0 });
    const result = makeResult("No results for: test query", details);
    expect(resultText(result)).toContain("no results");
  });

  it("truncates a long composed query with an ellipsis", () => {
    const longQuery =
      "a very long search query that definitely exceeds the sixty character limit for display purposes";
    const details = makeDetails({ composedQuery: longQuery });
    const result = makeResult(`Found 3 results for: ${longQuery}`, details);
    const text = resultText(result);
    expect(text).toMatch(/…$|…\s*$/);
    // And the truncated prefix is present.
    expect(text).toContain(longQuery.slice(0, 50));
  });
});

// ─── renderWebSearchResult — expanded ───────────────────────────────────────

describe("renderWebSearchResult (expanded)", () => {
  it("shows the full numbered result list with URLs and snippets", () => {
    const content = [
      "Found 2 results for: test query",
      "",
      "1. First Result",
      "   https://example.com/1",
      "   First snippet",
      "",
      "2. Second Result",
      "   https://example.com/2",
      "   Second snippet",
    ].join("\n");

    const details = makeDetails({ resultCount: 2 });
    const result = makeResult(content, details);
    const text = resultText(result, false, true);

    expect(text).toContain("First Result");
    expect(text).toContain("Second Result");
    expect(text).toContain("https://example.com/1");
    expect(text).toContain("https://example.com/2");
    expect(text).toContain("First snippet");
    expect(text).toContain("Second snippet");
  });

  it("shows the empty-results message in expanded mode", () => {
    const details = makeDetails({ resultCount: 0 });
    const result = makeResult("No results for: test query", details);
    expect(resultText(result, false, true)).toContain("No results for:");
  });
});

// ─── renderWebSearchResult — missing details fallback ───────────────────────

describe("renderWebSearchResult — missing details fallback", () => {
  it("falls back to raw content text when details are absent", () => {
    const result: AgentToolResult<SearchResponseDetails> = {
      content: [{ type: "text" as const, text: "Found 3 results for: test" }],
    } as AgentToolResult<SearchResponseDetails>;
    expect(resultText(result)).toContain("Found 3 results for: test");
  });
});