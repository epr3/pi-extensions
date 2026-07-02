/**
 * Web Fetch tool contract + pure logic tests — Vitest.
 *
 * Verifies, through the public tool surface and pure helpers:
 *   - Tool metadata and parameter schema
 *   - URL validation: valid, invalid, missing protocol, empty
 *   - Content-type detection: HTML, text, binary, edge cases
 *   - Fetch with mocked responses (success HTML, success text, HTTP error,
 *     oversized, timeout, binary content type)
 *   - HTML extraction, title extraction, Markdown conversion quality
 *   - Plain-text pass-through
 *   - Short/incomplete extraction warnings
 *   - PDF detection, extraction, and size-cap behavior
 *   - Jina Reader fallback: success, HTTP error, network error
 *   - Structured details shape
 *
 * Run: pnpm test  (from this package)
 */

import { describe, it, expect } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import webFetchExtension from "../index.ts";
import {
	validateUrl,
	isBinaryContentType,
	isHtmlContentType,
	isTextContentType,
	isPdfContentType,
	normalizeContentType,
	extractHtmlContent,
	htmlToMarkdown,
	processPlainText,
	fetchUrl,
	extractPdfContent,
	tryJinaFallback,
	WebFetchError,
} from "../fetch.ts";
import type { WebFetchDetails, FetchOptions, PdfExtractFn } from "../fetch.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeFakeApi(captured: ToolDefinition[]): ExtensionAPI {
	return {
		registerTool: (tool) => {
			captured.push(tool as ToolDefinition);
		},
		on: () => {},
	} as unknown as ExtensionAPI;
}

function registerWebFetch(): ToolDefinition {
	const tools: ToolDefinition[] = [];
	webFetchExtension(makeFakeApi(tools));
	expect(tools).toHaveLength(1);
	return tools[0]!;
}

function mockResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
	const h = new Map(Object.entries(headers));
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: status === 200 ? "OK" : status === 404 ? "Not Found" : "",
		headers: {
			get: (name: string) => h.get(name.toLowerCase()) ?? null,
			has: (name: string) => h.has(name.toLowerCase()),
		} as unknown as Headers,
		body: new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(body));
				controller.close();
			},
		}),
		text: async () => body,
	} as Response;
}

function makeFetchMock(
	result: Response | ((url: string) => Response | Promise<Response>),
): typeof globalThis.fetch {
	const fn = async (url: string | URL | Request, _init?: RequestInit) => {
		if (typeof result === "function") return result(url.toString());
		return result;
	};
	return fn as typeof globalThis.fetch;
}

// Module-scope fixtures for tests that don't need per-test closures.
const customPdfExtract: PdfExtractFn = (_body, _url) => ({
	text: "Custom extracted text",
	pageCount: 3,
});

const networkErrorFetch: typeof globalThis.fetch = async () => {
	throw new Error("Network failure");
};

const abortOnSignalFetch: typeof globalThis.fetch = async (_url, init) => {
	return new Promise<Response>((_resolve, reject) => {
		const signal = (init as RequestInit)?.signal;
		if (signal) {
			signal.addEventListener("abort", () => {
				reject(new DOMException("Aborted", "AbortError"));
			});
		}
	});
};

// ─── Tool metadata ──────────────────────────────────────────────────────────

describe("web_fetch tool metadata", () => {
	it("registers with name 'web_fetch' and label 'Web Fetch'", () => {
		const tool = registerWebFetch();
		expect(tool.name).toBe("web_fetch");
		expect(tool.label).toBe("Web Fetch");
	});

	it("description mentions Markdown, URL, and timeout", () => {
		const tool = registerWebFetch();
		expect(tool.description).toMatch(/Markdown/);
		expect(tool.description).toMatch(/URL/);
		expect(tool.description).toMatch(/timeout/);
	});

	it("prompt guidelines mention web_search and llms.txt", () => {
		const tool = registerWebFetch();
		const p = tool.promptGuidelines ?? [];
		expect(p.some((g) => g.includes("web_search"))).toBe(true);
		expect(p.some((g) => g.includes("llms.txt"))).toBe(true);
	});
});

// ─── Parameter schema ───────────────────────────────────────────────────────

describe("web_fetch parameter schema", () => {
	it("requires a string `url`", () => {
		const tool = registerWebFetch();
		const props = (tool.parameters as { properties: Record<string, { type: string }> }).properties;
		expect(props.url).toBeDefined();
		expect(props.url.type).toBe("string");
	});

	it("exposes only the `url` parameter", () => {
		const tool = registerWebFetch();
		const props = (tool.parameters as { properties: Record<string, unknown> }).properties;
		expect(Object.keys(props)).toEqual(["url"]);
	});
});

// ─── URL validation ─────────────────────────────────────────────────────────

describe("validateUrl", () => {
	it("accepts a valid https URL", () => {
		const url = validateUrl("https://example.com/page");
		expect(url.hostname).toBe("example.com");
		expect(url.protocol).toBe("https:");
	});

	it("accepts a valid http URL", () => {
		const url = validateUrl("http://example.com");
		expect(url.hostname).toBe("example.com");
		expect(url.protocol).toBe("http:");
	});

	it("adds https:// to a bare domain", () => {
		const url = validateUrl("example.com");
		expect(url.hostname).toBe("example.com");
		expect(url.protocol).toBe("https:");
	});

	it("preserves the URL path", () => {
		const url = validateUrl("https://example.com/docs/api/v1");
		expect(url.pathname).toBe("/docs/api/v1");
	});

	it("throws on an empty or whitespace-only string", () => {
		expect(() => validateUrl("")).toThrow(WebFetchError);
		expect(() => validateUrl("   ")).toThrow(WebFetchError);
	});

	it("throws on a malformed input that cannot be parsed", () => {
		expect(() => validateUrl("not a url at all !!!")).toThrow(WebFetchError);
	});

	it("throws on unsupported protocols (ftp, file, data)", () => {
		expect(() => validateUrl("ftp://files.example.com")).toThrow(WebFetchError);
		expect(() => validateUrl("file:///etc/passwd")).toThrow(WebFetchError);
		expect(() => validateUrl("data:text/plain,hello")).toThrow(WebFetchError);
	});

	it("error message names the failure for an empty string", () => {
		try {
			validateUrl("");
		} catch (e) {
			expect(e).toBeInstanceOf(WebFetchError);
			expect((e as WebFetchError).message).toContain("URL must be a non-empty string");
		}
	});

	it("error message names the failure for a malformed input", () => {
		try {
			validateUrl("not a url at all !!!");
		} catch (e) {
			expect(e).toBeInstanceOf(WebFetchError);
			expect((e as WebFetchError).message).toContain("malformed");
		}
	});

	it("error message names the failure for an unsupported protocol", () => {
		try {
			validateUrl("ftp://bad.com");
		} catch (e) {
			expect(e).toBeInstanceOf(WebFetchError);
			expect((e as WebFetchError).message).toContain("Unsupported protocol");
		}
	});
});

// ─── Content-type helpers ───────────────────────────────────────────────────

describe("normalizeContentType", () => {
	it("strips a charset parameter", () => {
		expect(normalizeContentType("text/html; charset=utf-8")).toBe("text/html");
	});

	it("passes a bare MIME type through", () => {
		expect(normalizeContentType("text/plain")).toBe("text/plain");
	});

	it("returns an empty string for null or empty input", () => {
		expect(normalizeContentType(null)).toBe("");
		expect(normalizeContentType("")).toBe("");
	});
});

describe("isBinaryContentType", () => {
	it("matches image, audio, video, and font types", () => {
		expect(isBinaryContentType("image/png")).toBe(true);
		expect(isBinaryContentType("audio/mpeg")).toBe(true);
		expect(isBinaryContentType("video/mp4")).toBe(true);
		expect(isBinaryContentType("font/woff2")).toBe(true);
	});

	it("matches generic binary application types", () => {
		expect(isBinaryContentType("application/zip")).toBe(true);
		expect(isBinaryContentType("application/octet-stream")).toBe(true);
	});

	it("does NOT match text, html, or json", () => {
		expect(isBinaryContentType("text/html")).toBe(false);
		expect(isBinaryContentType("text/plain")).toBe(false);
		expect(isBinaryContentType("application/json")).toBe(false);
	});

	it("returns false for an empty string", () => {
		expect(isBinaryContentType("")).toBe(false);
	});

	it("does NOT match application/pdf (PDF is extracted separately)", () => {
		expect(isBinaryContentType("application/pdf")).toBe(false);
	});
});

describe("isHtmlContentType", () => {
	it("matches text/html and application/xhtml+xml", () => {
		expect(isHtmlContentType("text/html")).toBe(true);
		expect(isHtmlContentType("application/xhtml+xml")).toBe(true);
	});

	it("does not match other types or an empty string", () => {
		expect(isHtmlContentType("text/plain")).toBe(false);
		expect(isHtmlContentType("")).toBe(false);
	});
});

describe("isTextContentType", () => {
	it("matches text/* and JSON/XML/JS variants", () => {
		expect(isTextContentType("text/plain")).toBe(true);
		expect(isTextContentType("text/css")).toBe(true);
		expect(isTextContentType("text/csv")).toBe(true);
		expect(isTextContentType("application/json")).toBe(true);
		expect(isTextContentType("application/xml")).toBe(true);
		expect(isTextContentType("application/javascript")).toBe(true);
		expect(isTextContentType("application/atom+xml")).toBe(true);
	});

	it("does not match images, PDFs, or HTML", () => {
		expect(isTextContentType("image/png")).toBe(false);
		expect(isTextContentType("application/pdf")).toBe(false);
		expect(isTextContentType("text/html")).toBe(false);
	});

	it("treats an empty string as text (assumed-text fallback)", () => {
		expect(isTextContentType("")).toBe(true);
	});
});

// ─── PDF detection ──────────────────────────────────────────────────────────

describe("isPdfContentType", () => {
	it("detects application/pdf regardless of URL", () => {
		expect(isPdfContentType("application/pdf", "https://example.com/doc")).toBe(true);
	});

	it("does not falsely detect non-PDF types", () => {
		expect(isPdfContentType("text/html", "https://example.com/page")).toBe(false);
		expect(isPdfContentType("text/plain", "https://example.com/file.txt")).toBe(false);
		expect(isPdfContentType("", "https://example.com/page")).toBe(false);
	});

	it("detects a .pdf URL when content-type is missing or generic", () => {
		expect(isPdfContentType("", "https://example.com/doc.pdf")).toBe(true);
		expect(isPdfContentType("", "https://example.com/file.PDF")).toBe(true);
		expect(isPdfContentType("text/html", "https://example.com/doc.pdf?raw=1")).toBe(true);
	});

	it("does not match a path that just contains 'pdf'", () => {
		expect(isPdfContentType("", "https://example.com/pdf")).toBe(false);
	});
});

// ─── PDF extraction ─────────────────────────────────────────────────────────

describe("extractPdfContent", () => {
	const SAMPLE_PDF =
		"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
		"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
		"3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R" +
		"/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj\n" +
		"4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n" +
		"5 0 obj<</Length 44>>stream\nBT /F1 12 Tf 72 700 Td (Hello PDF world) Tj ET\n" +
		"endstream\nendobj\nxref\n0 6\ntrailer<</Size 6/Root 1 0 R>>\nstartxref\n349\n%%EOF";

	it("extracts text from a simple PDF and reports its page count", () => {
		const result = extractPdfContent(SAMPLE_PDF, "https://example.com/doc.pdf");
		expect(result.text).toContain("Hello PDF world");
		expect(result.pageCount).toBe(1);
		expect(result.truncated).toBe(false);
	});

	it("uses the injected extractPdfFn when supplied", () => {
		const result = extractPdfContent("%PDF-dummy", "https://example.com/doc.pdf", {
			extractPdfFn: customPdfExtract,
		});
		expect(result.text).toBe("Custom extracted text");
		expect(result.pageCount).toBe(3);
	});

	it("returns empty text and zero pages for an empty PDF", () => {
		const result = extractPdfContent("", "https://example.com/empty.pdf");
		expect(result.text).toBe("");
		expect(result.pageCount).toBe(0);
	});

	it("returns empty text and zero pages for non-PDF content", () => {
		const result = extractPdfContent("This is not a PDF at all", "https://example.com/not.pdf");
		expect(result.text).toBe("");
		expect(result.pageCount).toBe(0);
	});

	it("marks the result truncated when the page count exceeds the limit", () => {
		const pdfHeader = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n";
		const pages = Array.from({ length: 10 }, (_, i) =>
			`${i + 2} 0 obj<</Type/Page/Parent 1 0 R>>endobj`,
		).join("\n");
		const multiPagePdf =
			pdfHeader +
			pages +
			"\n" +
			"/Type /Page\n".repeat(10) +
			"\ntrailer<</Size 12/Root 1 0 R>>\n%%EOF";

		const result = extractPdfContent(multiPagePdf, "https://example.com/multi.pdf", {
			pageLimit: 3,
		});
		expect(result.pageCount).toBe(10);
		expect(result.truncated).toBe(true);
		expect(result.text).toContain("PDF truncated");
	});

	it("extracts zero text but still counts pages for a PDF with no text objects", () => {
		const pdfBytes =
			"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
			"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
			"3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj\n" +
			"xref\n0 4\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n100\n%%EOF";

		const result = extractPdfContent(pdfBytes, "https://example.com/empty.pdf");
		expect(result.text).toBe("");
		expect(result.pageCount).toBe(1);
	});
});

// ─── fetchUrl size caps ─────────────────────────────────────────────────────

describe("fetchUrl — size caps", () => {
	it("uses the PDF-specific cap for PDF responses (larger than the default)", async () => {
		// PDF content just under the PDF-specific cap
		const pdfContent = "%PDF-1.4\n" + "x".repeat(700_000) + "\n%%EOF";
		const mockFetch = makeFetchMock(
			mockResponse(pdfContent, 200, {
				"content-type": "application/pdf",
				"content-length": "700000",
			}),
		);
		const url = validateUrl("https://example.com/large.pdf");
		const opts: FetchOptions = {
			fetchFn: mockFetch,
			maxContentBytes: 100_000, // small standard cap
			maxPdfBytes: 1024 * 1024, // larger PDF cap
		};

		const { body } = await fetchUrl(url, opts);
		expect(body).toContain("%PDF-1.4");
	});

	it("rejects a PDF response that exceeds the PDF-specific cap", async () => {
		const pdfContent = "%PDF-1.4\n" + "x".repeat(12_000_000) + "\n%%EOF";
		const mockFetch = makeFetchMock(
			mockResponse(pdfContent, 200, {
				"content-type": "application/pdf",
				"content-length": "12000000",
			}),
		);
		const url = validateUrl("https://example.com/huge.pdf");
		const opts: FetchOptions = {
			fetchFn: mockFetch,
			maxContentBytes: 100_000,
			maxPdfBytes: 1024 * 1024,
		};

		await expect(fetchUrl(url, opts)).rejects.toThrowError(/too large/);
	});
});

// ─── Jina Reader fallback ───────────────────────────────────────────────────

describe("tryJinaFallback", () => {
	it("returns cleaned Markdown from a successful Jina response", async () => {
		const jinaContent = "# Extracted via Jina\n\nThis is clean Markdown from Jina Reader.";
		const mockFetch = makeFetchMock(
			mockResponse(jinaContent, 200, { "content-type": "text/plain" }),
		);

		const result = await tryJinaFallback("https://example.com/dynamic", { fetchFn: mockFetch });
		expect(result).not.toBeNull();
		expect(result).toContain("Extracted via Jina");
	});

	it("returns null on an HTTP error response", async () => {
		const mockFetch = makeFetchMock(
			mockResponse("Not Found", 404, { "content-type": "text/plain" }),
		);

		const result = await tryJinaFallback("https://example.com/missing", { fetchFn: mockFetch });
		expect(result).toBeNull();
	});

	it("returns null on a network error", async () => {
		const result = await tryJinaFallback("https://example.com/down", { fetchFn: networkErrorFetch });
		expect(result).toBeNull();
	});
});

// ─── HTML extraction ────────────────────────────────────────────────────────

describe("extractHtmlContent", () => {
	it("extracts the <title> tag", () => {
		const html = "<html><head><title>Test Page</title></head><body><p>Hello</p></body></html>";
		const { title, content } = extractHtmlContent(html, "https://example.com");
		expect(title).toBe("Test Page");
		expect(content.length).toBeGreaterThan(0);
	});

	it("extracts content from <article>, stripping <nav> and <footer>", () => {
		const html = `
			<html><head><title>Article Title</title></head>
			<body>
				<nav>Nav links</nav>
				<article>
					<h1>Main Heading</h1>
					<p>This is the article content with a <a href="https://example.com">link</a>.</p>
				</article>
				<footer>Footer</footer>
			</body></html>`;
		const { title, content } = extractHtmlContent(html, "https://example.com");
		expect(title).toBe("Article Title");
		expect(content).toContain("Main Heading");
		expect(content).toContain("article content");
		expect(content).toContain("[link]");
		expect(content).not.toContain("Nav links");
		expect(content).not.toContain("Footer");
	});

	it("extracts content from <main>, stripping <header> and <aside>", () => {
		const html = `
			<html><body>
				<header>Header</header>
				<main>
					<h1>Page Title</h1>
					<p>Main area content here.</p>
				</main>
				<aside>Sidebar</aside>
			</body></html>`;
		const { content } = extractHtmlContent(html, "https://example.com");
		expect(content).toContain("Page Title");
		expect(content).toContain("Main area content");
		expect(content).not.toContain("Header");
		expect(content).not.toContain("Sidebar");
	});

	it("falls back to <body> when no <article> or <main> is present", () => {
		const html =
			"<html><body><h1>Fallback</h1><p>No article or main element.</p></body></html>";
		const { content } = extractHtmlContent(html, "https://example.com");
		expect(content).toContain("Fallback");
		expect(content).toContain("No article or main element");
	});

	it("emits an extraction warning for very short content", () => {
		const html = "<html><body><p>Hi</p></body></html>";
		const { extractionWarning } = extractHtmlContent(html, "https://example.com");
		expect(extractionWarning).toBeDefined();
		expect(extractionWarning).toContain("Very little content");
	});

	it("strips <script> and <style> elements", () => {
		const html = `
			<html><body>
				<article>
					<h1>Real Content</h1>
					<p>Important text.</p>
					<script>alert('hack');</script>
					<style>.css{}</style>
				</article>
			</body></html>`;
		const { content } = extractHtmlContent(html, "https://example.com");
		expect(content).toContain("Real Content");
		expect(content).toContain("Important text");
		expect(content).not.toContain("alert");
		expect(content).not.toContain(".css");
	});
});

// ─── Markdown conversion ────────────────────────────────────────────────────

describe("htmlToMarkdown", () => {
	it("renders h1/h2/h3 as Markdown headings", () => {
		const md = htmlToMarkdown("<h1>One</h1><h2>Two</h2><h3>Three</h3>");
		expect(md).toContain("# One");
		expect(md).toContain("## Two");
		expect(md).toContain("### Three");
	});

	it("renders <a> as Markdown links", () => {
		const md = htmlToMarkdown('<p>Visit <a href="https://example.com">Example</a> today.</p>');
		expect(md).toContain("[Example](https://example.com)");
		expect(md).toContain("today");
	});

	it("renders <strong> and <em> as Markdown bold and italic", () => {
		const md = htmlToMarkdown("<p><strong>Bold</strong> and <em>italic</em> text.</p>");
		expect(md).toContain("**Bold**");
		expect(md).toContain("*italic*");
	});

	it("renders <code> as inline code", () => {
		const md = htmlToMarkdown('<p>Use the <code>fetch()</code> function.</p>');
		expect(md).toContain("`fetch()`");
	});

	it("renders <pre><code> as a fenced code block", () => {
		const md = htmlToMarkdown('<pre><code>const x = 1;\nconsole.log(x);</code></pre>');
		expect(md).toContain("```");
		expect(md).toContain("const x = 1;");
	});

	it("renders <ul>/<ol> as Markdown lists", () => {
		const md = htmlToMarkdown(
			"<ul><li>Item A</li><li>Item B</li></ul><ol><li>First</li><li>Second</li></ol>",
		);
		expect(md).toContain("- Item A");
		expect(md).toContain("- Item B");
		expect(md).toContain("1. First");
		expect(md).toContain("2. Second");
	});

	it("renders <img> as Markdown image syntax", () => {
		const md = htmlToMarkdown('<img src="https://example.com/img.png" alt="Photo">');
		expect(md).toContain("![Photo](https://example.com/img.png)");
	});

	it("decodes common HTML entities", () => {
		const md = htmlToMarkdown("<p>AT&amp;T &amp; IBM</p>");
		expect(md).toContain("AT&T & IBM");
	});
});

// ─── Plain text pass-through ────────────────────────────────────────────────

describe("processPlainText", () => {
	it("trims surrounding whitespace", () => {
		expect(processPlainText("  hello  ")).toBe("hello");
	});

	it("preserves internal newlines", () => {
		expect(processPlainText("hello\nworld")).toBe("hello\nworld");
	});
});

// ─── fetchUrl (mocked) ──────────────────────────────────────────────────────

describe("fetchUrl (mocked fetch)", () => {
	const SAMPLE_PDF =
		"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
		"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
		"3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R" +
		"/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj\n" +
		"4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n" +
		"5 0 obj<</Length 44>>stream\nBT /F1 12 Tf 72 700 Td (Hello PDF world) Tj ET\n" +
		"endstream\nendobj\nxref\n0 6\ntrailer<</Size 6/Root 1 0 R>>\nstartxref\n349\n%%EOF";

	it("returns the response and body for a successful HTML fetch", async () => {
		const html = "<html><body><article><h1>Hello</h1><p>World</p></article></body></html>";
		const mockFetch = makeFetchMock(
			mockResponse(html, 200, { "content-type": "text/html" }),
		);
		const url = validateUrl("https://example.com");
		const { response, body } = await fetchUrl(url, { fetchFn: mockFetch });

		expect(response.status).toBe(200);
		expect(normalizeContentType(response.headers.get("content-type"))).toBe("text/html");
		expect(body).toContain("Hello");
	});

	it("returns the body verbatim for a successful plain-text fetch", async () => {
		const text = "Hello, this is plain text content.";
		const mockFetch = makeFetchMock(
			mockResponse(text, 200, { "content-type": "text/plain" }),
		);
		const url = validateUrl("https://example.com/readme.txt");
		const { response, body } = await fetchUrl(url, { fetchFn: mockFetch });

		expect(response.status).toBe(200);
		expect(body).toBe(text);
	});

	it("rejects with the HTTP status on a 404", async () => {
		const mockFetch = makeFetchMock(
			mockResponse("Not Found", 404, { "content-type": "text/html" }),
		);
		const url = validateUrl("https://example.com/missing");

		await expect(fetchUrl(url, { fetchFn: mockFetch })).rejects.toThrowError(/404/);
	});

	it("rejects with an unsupported content-type message for binary content", async () => {
		const mockFetch = makeFetchMock(
			mockResponse("...binary...", 200, { "content-type": "image/png" }),
		);
		const url = validateUrl("https://example.com/image.png");

		await expect(fetchUrl(url, { fetchFn: mockFetch })).rejects.toThrowError(
			/Unsupported content type.*image\/png/,
		);
	});

	it("lets a PDF response through (extraction happens later)", async () => {
		const mockFetch = makeFetchMock(
			mockResponse(SAMPLE_PDF, 200, { "content-type": "application/pdf" }),
		);
		const url = validateUrl("https://example.com/doc.pdf");

		const { response, body } = await fetchUrl(url, { fetchFn: mockFetch });
		expect(response.status).toBe(200);
		expect(normalizeContentType(response.headers.get("content-type"))).toBe("application/pdf");
		expect(body).toContain("Hello PDF world");
	});

	it("rejects with a too-large message when content-length exceeds the cap", async () => {
		const mockFetch = makeFetchMock(
			mockResponse("x".repeat(600_000), 200, {
				"content-type": "text/html",
				"content-length": "600000",
			}),
		);
		const url = validateUrl("https://example.com/large");
		const opts: FetchOptions = { fetchFn: mockFetch, maxContentBytes: 100_000 };

		await expect(fetchUrl(url, opts)).rejects.toThrowError(/too large/);
	});

	it("rejects with a timeout message when the request is aborted before completion", async () => {
		const url = validateUrl("https://example.com/slow");
		const opts: FetchOptions = { fetchFn: abortOnSignalFetch, fetchTimeoutMs: 50 };

		await expect(fetchUrl(url, opts)).rejects.toThrowError(/timed out/);
	});

	it("rejects with a size-cap message when streamed body exceeds the cap", async () => {
		const oversized = "x".repeat(150_000);
		const mockFetch = makeFetchMock(
			mockResponse(oversized, 200, { "content-type": "text/plain" }),
		);
		const url = validateUrl("https://example.com/big");
		const opts: FetchOptions = { fetchFn: mockFetch, maxContentBytes: 10_000 };

		await expect(fetchUrl(url, opts)).rejects.toThrowError(/exceeded size cap/);
	});
});

// ─── WebFetchError ──────────────────────────────────────────────────────────

describe("WebFetchError", () => {
	it("includes the prefix, reason, and URL in its message and exposes the URL", () => {
		try {
			throw new WebFetchError("https://example.com/bad", "Something went wrong");
		} catch (e) {
			expect(e).toBeInstanceOf(WebFetchError);
			const err = e as WebFetchError;
			expect(err.message).toContain("web_fetch:");
			expect(err.message).toContain("Something went wrong");
			expect(err.message).toContain("https://example.com/bad");
			expect(err.url).toBe("https://example.com/bad");
		}
	});
});

// ─── Full extraction pipeline ───────────────────────────────────────────────

describe("full extraction pipeline", () => {
	it("produces Markdown from a complex article with multiple block elements", () => {
		const html = `
			<html><head><title>Test Pipeline</title></head>
			<body>
				<article>
					<h1>Pipeline Test</h1>
					<p>This is a <strong>test</strong> of the full extraction pipeline with a
					<a href="https://example.com">link</a> and some <code>code</code>.</p>
					<ul>
						<li>Item one</li>
						<li>Item two</li>
					</ul>
				</article>
			</body></html>`;

		const { title, content } = extractHtmlContent(html, "https://example.com/pipeline");
		expect(title).toBe("Test Pipeline");
		expect(content).toContain("Pipeline Test");
		expect(content).toContain("**test**");
		expect(content).toContain("[link]");
		expect(content).toContain("`code`");
		expect(content).toContain("- Item one");
		expect(content).toContain("- Item two");
	});
});

// ─── Structured details shape ───────────────────────────────────────────────

describe("WebFetchDetails shape", () => {
	it("exposes every field of the details contract on a fully-populated input", () => {
		const d: WebFetchDetails = {
			url: "https://example.com/article",
			title: "An Article",
			contentType: "text/html",
			contentLength: 1234,
			source: "html",
		};
		expect(d).toEqual({
			url: "https://example.com/article",
			title: "An Article",
			contentType: "text/html",
			contentLength: 1234,
			source: "html",
		});
	});
});

