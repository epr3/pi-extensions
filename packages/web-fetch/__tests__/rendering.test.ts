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
	return renderWebFetchResult(result, { isPartial, expanded }, plainTheme, undefined).render(80).join(
		"\n",
	);
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

// ─── renderWebFetchCall ────────────────────────────────────────────────────

describe("renderWebFetchCall", () => {
	it("shows the 'Web Fetch' tool label", () => {
		expect(callText({ url: "https://example.com/page" })).toContain("Web Fetch");
	});

	it("shows the URL in the call row", () => {
		expect(callText({ url: "https://example.com/page" })).toContain("example.com/page");
	});

	it("truncates an overlong URL", () => {
		const longUrl = "https://example.com/" + "a".repeat(100);
		const text = callText({ url: longUrl });
		expect(text.length).toBeLessThan(longUrl.length);
	});

	it("falls back to '(no URL)' when no URL is provided", () => {
		expect(callText({})).toContain("(no URL)");
	});
});

// ─── renderWebFetchResult — collapsed (success) ─────────────────────────────

describe("renderWebFetchResult (collapsed, success)", () => {
	it("shows check + URL + title + content size", () => {
		const details = makeDetails({
			url: "https://example.com/article",
			title: "Test Article",
			contentLength: 1500,
		});
		const result = makeResult("# Test Article\n\nContent here...", details);
		const text = resultText(result);

		expect(text).toContain("✓");
		expect(text).toContain("Test Article");
		expect(text).toContain("1500 chars");
	});

	it("renders without a title when none is provided", () => {
		const details = makeDetails({
			url: "https://example.com/plain",
			title: "",
			contentLength: 500,
		});
		const result = makeResult("Source: ...", details);
		const text = resultText(result);

		expect(text).toContain("✓");
		expect(text).toContain("500 chars");
	});
});

// ─── renderWebFetchResult — collapsed PDF and fallback badges ──────────────

describe("renderWebFetchResult (collapsed, PDF and fallback badges)", () => {
	it("shows the [PDF] badge for a PDF result", () => {
		const details = makeDetails({
			url: "https://example.com/doc.pdf",
			source: "pdf",
			pageCount: 5,
		});
		const result = makeResult("Source: url\n\nPDF text", details);
		const text = resultText(result);

		expect(text).toContain("[PDF]");
		expect(text).toContain("✓");
	});

	it("shows the [Fallback] badge for a Jina-fallback result", () => {
		const details = makeDetails({
			url: "https://example.com/dynamic",
			source: "fallback",
		});
		const result = makeResult("Fallback content", details);
		const text = resultText(result);

		expect(text).toContain("[Fallback]");
	});
});

// ─── renderWebFetchResult — collapsed (error) ──────────────────────────────

describe("renderWebFetchResult (collapsed, error)", () => {
	it("shows check + URL (error is content-driven in collapsed mode)", () => {
		const details = makeDetails({
			url: "https://example.com/error",
			contentLength: 0,
		});
		const result = makeResult("Error text", details);
		const text = resultText(result);

		expect(text).toContain("✓");
		expect(text).toContain("example.com/error");
	});
});

// ─── renderWebFetchResult — expanded ───────────────────────────────────────

describe("renderWebFetchResult (expanded)", () => {
	it("shows title, URL, content-type, size, and body", () => {
		const content =
			"# Article Title\n\nSource: https://example.com/article\n\nFull article text here.";
		const details = makeDetails({
			url: "https://example.com/article",
			title: "Article Title",
			contentType: "text/html",
			contentLength: 1500,
		});
		const result = makeResult(content, details);
		const text = resultText(result, false, true);

		expect(text).toContain("Article Title");
		expect(text).toContain("https://example.com/article");
		expect(text).toContain("Content-Type: text/html");
		expect(text).toContain("Content: 1500 chars");
		expect(text).toContain("Full article text here");
	});

	it("truncates a long body with an ellipsis", () => {
		const longBody = "Paragraph text. ".repeat(150);
		const details = makeDetails({
			url: "https://example.com/long",
			title: "Long Page",
			contentLength: longBody.length + 50,
		});
		const result = makeResult(longBody, details);
		const text = resultText(result, false, true);

		expect(text).toContain("…");
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
		const result = makeResult("PDF text content", details);
		const text = resultText(result, false, true);

		expect(text).toContain("[pdf]");
		expect(text).toContain("Pages: 15");
		expect(text).not.toContain("truncated");
	});

	it("shows truncation note when a PDF exceeds the page limit", () => {
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

		expect(text).toContain("Pages: 100");
		expect(text).toContain("truncated");
	});

	it("shows the [fallback] source tag for a Jina-fallback result", () => {
		const details = makeDetails({
			url: "https://example.com/dynamic",
			title: "Dynamic Page",
			contentType: "text/markdown",
			contentLength: 2000,
			source: "fallback",
		});
		const result = makeResult("Fallback markdown content", details);
		const text = resultText(result, false, true);

		expect(text).toContain("[fallback]");
	});
});

// ─── Extraction warning display ────────────────────────────────────────────

describe("renderWebFetchResult — extraction warning", () => {
	const WARNING = "Very little content extracted (30 chars)";

	it("shows the warning in expanded mode", () => {
		const details = makeDetails({
			url: "https://example.com/dynamic",
			title: "Dynamic Page",
			contentType: "text/html",
			contentLength: 30,
			extractionWarning: WARNING,
		});
		const result = makeResult("Source: url\n\nOnly a little text", details);
		const text = resultText(result, false, true);

		expect(text).toContain("Warning:");
		expect(text).toContain(WARNING);
	});

	it("hides the warning in collapsed mode", () => {
		const details = makeDetails({
			url: "https://example.com/dynamic",
			title: "Dynamic",
			contentLength: 30,
			extractionWarning: WARNING,
		});
		const result = makeResult("Short", details);
		const text = resultText(result, false, false);

		expect(text).not.toContain("Warning:");
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
