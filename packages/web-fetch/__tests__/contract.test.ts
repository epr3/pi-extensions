/**
 * Web Fetch tool contract + behavior tests — Vitest.
 *
 * Verifies through the registered tool (fake Pi API) and the extension's own
 * lifecycle events, plus pure helpers:
 *   - Tool metadata and parameter schema
 *   - URL validation, content-type detection, Markdown conversion
 *   - Disk-backed download (streaming sink), size caps, timeouts
 *   - Readable artifacts: finalized files, absolute paths, completeness
 *   - Session lifecycle: leave/replace/fork/shutdown remove artifacts;
 *     reload and in-session navigation keep them
 *   - Cancellation, concurrency, and ownership: pending work after a leave
 *     cannot recreate files or publish stale artifact paths
 *   - Cleanup robustness: idempotent, tolerates missing files, failures
 *     observable with ownership records preserved
 *
 * Run: pnpm test  (from this package)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, chmod, access, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import webFetchExtension from "../index.ts";
import { configureTestRuntime, resetTestRuntime } from "../runtime.ts";
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
  WebFetchError,
} from "../fetch.ts";
import type { WebFetchDetails, FetchOptions, PdfExtractFn } from "../fetch.ts";
import { ArtifactStore } from "../storage.ts";

// ─── Test harness: fake Pi API with tool capture + lifecycle events ─────────

interface FakeApi {
  tool: ToolDefinition;
  handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
}

function makeFakeApi(): FakeApi {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const api = {
    registerTool: (tool: ToolDefinition) => {
      (api as unknown as { tool: ToolDefinition }).tool = tool;
    },
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      handlers.set(event, handler);
    },
  } as ExtensionAPI & { tool: ToolDefinition };
  webFetchExtension(api as ExtensionAPI);
  return { tool: api.tool, handlers };
}

/** Minimal ExtensionContext: only what web_fetch executes read. */
function makeCtx(sessionId?: string): ExtensionContext {
  return {
    sessionManager: sessionId === undefined ? undefined : { getSessionId: () => sessionId },
    cwd: process.cwd(),
  } as unknown as ExtensionContext;
}

async function emit(
  api: FakeApi,
  event: { type: string } & Record<string, unknown>,
  ctx: ExtensionContext,
): Promise<void> {
  const handler = api.handlers.get(event.type);
  if (handler) await handler(event, ctx);
}

// ─── Response/fetch mocks ────────────────────────────────────────────────────

function mockResponse(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
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

/** Response whose body stream waits for `gate` before streaming `body`. */
function gatedResponse(
  body: string,
  gate: Promise<void>,
  opts: { signal?: AbortSignal; chunkSize?: number } = {},
): Response {
  const chunkSize = opts.chunkSize ?? 16;
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: {
      get: () => null,
      has: () => false,
    } as unknown as Headers,
    body: new ReadableStream({
      start(controller) {
        if (opts.signal) {
          opts.signal.addEventListener(
            "abort",
            () => controller.error(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }
        void gate.then(() => {
          const enc = new TextEncoder();
          for (let i = 0; i < body.length; i += chunkSize) {
            controller.enqueue(enc.encode(body.slice(i, i + chunkSize)));
          }
          controller.close();
        });
      },
    }),
    text: async () => {
      await gate;
      return body;
    },
  } as Response;
}

/** Fetch mock over a gated body stream; honors the request signal by default. */
function makeGatedFetch(
  body: string,
  gate: Promise<void>,
  opts: { honorSignal?: boolean; chunkSize?: number } = {},
): typeof globalThis.fetch {
  return async (_url, init) => {
    const signal =
      opts.honorSignal === false ? undefined : (init as { signal?: AbortSignal } | undefined)?.signal;
    return gatedResponse(body, gate, { signal, chunkSize: opts.chunkSize });
  };
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

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const HTML_FIXTURE = `
<html><head><title>Test Page</title></head>
<body>
  <nav>Nav links</nav>
  <article>
    <h1>Main Heading</h1>
    <p>Article content with a <a href="https://example.com">link</a>.</p>
    <ul><li>Item one</li><li>Item two</li></ul>
    <pre><code>const x = 1;</code></pre>
  </article>
  <footer>Footer</footer>
</body></html>`;

const SAMPLE_PDF =
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
  "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
  "3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R" +
  "/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj\n" +
  "4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n" +
  "5 0 obj<</Length 44>>stream\nBT /F1 12 Tf 72 700 Td (Hello PDF world) Tj ET\n" +
  "endstream\nendobj\nxref\n0 6\ntrailer<</Size 6/Root 1 0 R>>\nstartxref\n349\n%%EOF";

const customPdfExtract: PdfExtractFn = (_body, _url) => ({
  text: "Custom extracted text",
  pageCount: 3,
});

const truncatingPdf: PdfExtractFn = () => ({ text: "Only the beginning", pageCount: 120, truncated: true });

const emptyPdf: PdfExtractFn = () => ({ text: "", pageCount: 0 });

// ─── Storage helpers ─────────────────────────────────────────────────────────

/** Recursively list every file under root (missing root => empty). */
async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else out.push(p);
    }
  }
  await walk(root);
  return out;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// ─── Per-test isolation ──────────────────────────────────────────────────────

let storageRoot: string;

beforeEach(async () => {
  storageRoot = await mkdtemp(join(os.tmpdir(), "web-fetch-test-"));
  configureTestRuntime({ storageRoot });
});

afterEach(async () => {
  resetTestRuntime();
  await rm(storageRoot, { recursive: true, force: true });
});

// ─── Tool metadata ──────────────────────────────────────────────────────────

describe("web_fetch tool metadata", () => {
  it("registers with name 'web_fetch' and label 'Web Fetch'", () => {
    const api = makeFakeApi();
    expect(api.tool.name).toBe("web_fetch");
    expect(api.tool.label).toBe("Web Fetch");
  });

  it("description mentions Markdown, URL, timeout, artifact, and session lifetime", () => {
    const api = makeFakeApi();
    expect(api.tool.description).toMatch(/Markdown/);
    expect(api.tool.description).toMatch(/URL/);
    expect(api.tool.description).toMatch(/timeout/);
    expect(api.tool.description).toMatch(/artifact/i);
    expect(api.tool.description).toMatch(/session/i);
  });

  it("description and guidelines never mention Jina or an alternate service", () => {
    const api = makeFakeApi();
    expect(api.tool.description).not.toMatch(/Jina/i);
    expect(api.tool.description).not.toMatch(/alternate service/i);
    for (const g of api.tool.promptGuidelines ?? []) {
      expect(g).not.toMatch(/Jina/i);
    }
  });

  it("prompt guidelines mention web_search, llms.txt, and refetching", () => {
    const api = makeFakeApi();
    const p = api.tool.promptGuidelines ?? [];
    expect(p.some((g) => g.includes("web_search"))).toBe(true);
    expect(p.some((g) => g.includes("llms.txt"))).toBe(true);
    expect(p.some((g) => /refetch/i.test(g))).toBe(true);
  });
});

// ─── Parameter schema ────────────────────────────────────────────────────────

describe("web_fetch parameter schema", () => {
  it("requires a string `url` and exposes only that parameter", () => {
    const api = makeFakeApi();
    const props = (api.tool.parameters as { properties: Record<string, { type: string }> })
      .properties;
    expect(Object.keys(props)).toEqual(["url"]);
    expect(props.url.type).toBe("string");
  });
});

// ─── Lifecycle registration ──────────────────────────────────────────────────

describe("web_fetch lifecycle registration", () => {
  it("subscribes to session_start and session_shutdown", () => {
    const api = makeFakeApi();
    expect(api.handlers.has("session_start")).toBe(true);
    expect(api.handlers.has("session_shutdown")).toBe(true);
  });
});

// ─── URL validation ──────────────────────────────────────────────────────────

describe("validateUrl", () => {
  it("accepts https and http URLs and prefixes bare domains with https", () => {
    expect(validateUrl("https://example.com/page").hostname).toBe("example.com");
    expect(validateUrl("http://example.com").protocol).toBe("http:");
    const bare = validateUrl("example.com");
    expect(bare.hostname).toBe("example.com");
    expect(bare.protocol).toBe("https:");
  });

  it("preserves the URL path", () => {
    expect(validateUrl("https://example.com/docs/api/v1").pathname).toBe("/docs/api/v1");
  });

  it("throws on empty, malformed, and unsupported-protocol inputs", () => {
    expect(() => validateUrl("")).toThrow(WebFetchError);
    expect(() => validateUrl("   ")).toThrow(WebFetchError);
    expect(() => validateUrl("not a url at all !!!")).toThrow(WebFetchError);
    expect(() => validateUrl("ftp://files.example.com")).toThrow(WebFetchError);
    expect(() => validateUrl("file:///etc/passwd")).toThrow(WebFetchError);
    expect(() => validateUrl("data:text/plain,hello")).toThrow(WebFetchError);
  });

  it("names the failure reason in its message", () => {
    try {
      validateUrl("");
    } catch (e) {
      expect((e as WebFetchError).message).toContain("URL must be a non-empty string");
    }
    try {
      validateUrl("ftp://bad.com");
    } catch (e) {
      expect((e as WebFetchError).message).toContain("Unsupported protocol");
    }
  });
});

// ─── Content-type helpers ────────────────────────────────────────────────────

describe("content-type helpers", () => {
  it("normalizes charset parameters and empty input", () => {
    expect(normalizeContentType("text/html; charset=utf-8")).toBe("text/html");
    expect(normalizeContentType("text/plain")).toBe("text/plain");
    expect(normalizeContentType(null)).toBe("");
  });

  it("classifies binary media types (PDF excluded)", () => {
    expect(isBinaryContentType("image/png")).toBe(true);
    expect(isBinaryContentType("audio/mpeg")).toBe(true);
    expect(isBinaryContentType("application/zip")).toBe(true);
    expect(isBinaryContentType("application/pdf")).toBe(false);
    expect(isBinaryContentType("text/html")).toBe(false);
    expect(isBinaryContentType("")).toBe(false);
  });

  it("classifies HTML, text, JSON/XML/JS types", () => {
    expect(isHtmlContentType("text/html")).toBe(true);
    expect(isHtmlContentType("application/xhtml+xml")).toBe(true);
    expect(isTextContentType("text/plain")).toBe(true);
    expect(isTextContentType("application/json")).toBe(true);
    expect(isTextContentType("application/atom+xml")).toBe(true);
    expect(isTextContentType("text/html")).toBe(false);
    expect(isTextContentType("application/pdf")).toBe(false);
    expect(isTextContentType("image/png")).toBe(false);
    expect(isTextContentType("")).toBe(true);
  });

  it("detects PDFs by content-type or a .pdf URL", () => {
    expect(isPdfContentType("application/pdf", "https://example.com/doc")).toBe(true);
    expect(isPdfContentType("", "https://example.com/doc.pdf")).toBe(true);
    expect(isPdfContentType("", "https://example.com/file.PDF")).toBe(true);
    expect(isPdfContentType("text/html", "https://example.com/doc.pdf?raw=1")).toBe(true);
    expect(isPdfContentType("text/html", "https://example.com/page")).toBe(false);
    expect(isPdfContentType("", "https://example.com/pdf")).toBe(false);
  });
});

// ─── PDF extraction ──────────────────────────────────────────────────────────

describe("extractPdfContent", () => {
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

  it("returns empty text and zero pages for non-PDF content", () => {
    expect(extractPdfContent("", "https://example.com/empty.pdf").text).toBe("");
    expect(extractPdfContent("Not a PDF", "https://example.com/not.pdf").text).toBe("");
  });

  it("marks the result truncated when the page count exceeds the limit", () => {
    const pdfHeader = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n";
    const pages = Array.from({ length: 10 }, (_, i) => `${i + 2} 0 obj<</Type/Page/Parent 1 0 R>>endobj`).join("\n");
    const result = extractPdfContent(
      pdfHeader + pages + "\n/Type /Page\n".repeat(10) + "\ntrailer<</Size 12/Root 1 0 R>>\n%%EOF",
      "https://example.com/multi.pdf",
      { pageLimit: 3 },
    );
    expect(result.pageCount).toBe(10);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("PDF truncated");
  });
});

// ─── HTML extraction ─────────────────────────────────────────────────────────

describe("extractHtmlContent", () => {
  it("extracts the <title> and strips nav/footer chrome", () => {
    const { title, content } = extractHtmlContent(HTML_FIXTURE, "https://example.com");
    expect(title).toBe("Test Page");
    expect(content).toContain("Main Heading");
    expect(content).not.toContain("Nav links");
    expect(content).not.toContain("Footer");
  });

  it("strips <script> and <style> elements", () => {
    const html = `<html><body><article><h1>Real</h1><p>Text.</p><script>alert('x');</script><style>.c{}</style></article></body></html>`;
    const { content } = extractHtmlContent(html, "https://example.com");
    expect(content).toContain("Real");
    expect(content).not.toContain("alert");
    expect(content).not.toContain(".c");
  });

  it("emits an extraction warning for very short content", () => {
    const { extractionWarning } = extractHtmlContent("<html><body><p>Hi</p></body></html>", "https://example.com");
    expect(extractionWarning).toContain("Very little content");
  });
});

// ─── Markdown conversion ─────────────────────────────────────────────────────

describe("htmlToMarkdown", () => {
  it("renders headings, links, emphasis, code, lists, and entities", () => {
    const md = htmlToMarkdown(
      "<h1>One</h1><p>Visit <a href=\"https://example.com\">Example</a> with <strong>bold</strong> and <code>fetch()</code>.</p><ul><li>Item A</li></ul><p>AT&amp;T</p>",
    );
    expect(md).toContain("# One");
    expect(md).toContain("[Example](https://example.com)");
    expect(md).toContain("**bold**");
    expect(md).toContain("`fetch()`");
    expect(md).toContain("- Item A");
    expect(md).toContain("AT&T");
  });

  it("renders fenced code blocks and images", () => {
    const md = htmlToMarkdown("<pre><code>const x = 1;</code></pre><img src=\"https://example.com/i.png\" alt=\"Photo\">");
    expect(md).toContain("```");
    expect(md).toContain("const x = 1;");
    expect(md).toContain("![Photo](https://example.com/i.png)");
  });
});

// ─── Plain text pass-through ─────────────────────────────────────────────────

describe("processPlainText", () => {
  it("trims surrounding whitespace but preserves newlines", () => {
    expect(processPlainText("  hello  ")).toBe("hello");
    expect(processPlainText("hello\nworld")).toBe("hello\nworld");
  });
});

// ─── fetchUrl (mocked): caps, timeout, streaming sink ───────────────────────

describe("fetchUrl (mocked fetch)", () => {
  it("returns the response and body for a successful fetch", async () => {
    const mockFetch = makeFetchMock(mockResponse(HTML_FIXTURE, 200, { "content-type": "text/html" }));
    const { response, body } = await fetchUrl(validateUrl("https://example.com"), { fetchFn: mockFetch });
    expect(response.status).toBe(200);
    expect(body).toContain("Main Heading");
  });

  it("rejects with the HTTP status on a 404 and for binary content", async () => {
    const notFound = makeFetchMock(mockResponse("Not Found", 404, { "content-type": "text/html" }));
    await expect(fetchUrl(validateUrl("https://example.com/missing"), { fetchFn: notFound })).rejects.toThrowError(/404/);

    const binary = makeFetchMock(mockResponse("...", 200, { "content-type": "image/png" }));
    await expect(fetchUrl(validateUrl("https://example.com/i.png"), { fetchFn: binary })).rejects.toThrowError(/Unsupported content type.*image\/png/);
  });

  it("rejects when the declared content-length exceeds the cap", async () => {
    const mockFetch = makeFetchMock(
      mockResponse("x".repeat(600), 200, { "content-type": "text/html", "content-length": "600000" }),
    );
    const opts: FetchOptions = { fetchFn: mockFetch, maxContentBytes: 100_000 };
    await expect(fetchUrl(validateUrl("https://example.com/large"), opts)).rejects.toThrowError(/too large/);
  });

  it("rejects when the streamed body exceeds the cap", async () => {
    const mockFetch = makeFetchMock(mockResponse("x".repeat(150_000), 200, { "content-type": "text/plain" }));
    const opts: FetchOptions = { fetchFn: mockFetch, maxContentBytes: 10_000 };
    await expect(fetchUrl(validateUrl("https://example.com/big"), opts)).rejects.toThrowError(/exceeded size cap/);
  });

  it("rejects on timeout with an AbortError-style signal", async () => {
    const opts: FetchOptions = { fetchFn: abortOnSignalFetch, fetchTimeoutMs: 50 };
    await expect(fetchUrl(validateUrl("https://example.com/slow"), opts)).rejects.toThrowError(/timed out/);
  });

  it("streams body bytes to a sink instead of accumulating them", async () => {
    const mockFetch = makeFetchMock(mockResponse("streamed body text", 200, { "content-type": "text/plain" }));
    const received: string[] = [];
    const { body } = await fetchUrl(validateUrl("https://example.com/stream"), {
      fetchFn: mockFetch,
      sink: async (chunk) => {
        received.push(new TextDecoder().decode(chunk));
      },
    });
    expect(body).toBe("");
    expect(received.join("")).toBe("streamed body text");
  });

  it("enforces the streamed cap while writing to a sink", async () => {
    const mockFetch = makeFetchMock(mockResponse("x".repeat(150_000), 200, { "content-type": "text/plain" }));
    const opts: FetchOptions = { fetchFn: mockFetch, maxContentBytes: 10_000, sink: async () => {} };
    await expect(fetchUrl(validateUrl("https://example.com/big"), opts)).rejects.toThrowError(/exceeded size cap/);
  });
});

// ─── WebFetchError ───────────────────────────────────────────────────────────

describe("WebFetchError", () => {
  it("includes the prefix, reason, and URL in its message and exposes the URL", () => {
    const err = new WebFetchError("https://example.com/bad", "Something went wrong");
    expect(err.message).toContain("web_fetch:");
    expect(err.message).toContain("Something went wrong");
    expect(err.message).toContain("https://example.com/bad");
    expect(err.url).toBe("https://example.com/bad");
  });
});

// ─── Successful calls through the registered tool ────────────────────────────

describe("web_fetch tool — successful calls", () => {
  it("fetching HTML returns inline content, a finalized artifact, and details", async () => {
    const api = makeFakeApi();
    configureTestRuntime({ fetchFn: makeFetchMock(mockResponse(HTML_FIXTURE, 200, { "content-type": "text/html" })) });

    const result = await api.tool.execute("c1", { url: "https://example.com" }, undefined, undefined, makeCtx("sess-1"));
    const text = (result.content[0] as { type: "text"; text: string }).text;
    const details = result.details as WebFetchDetails;

    expect(text).toContain("Source: https://example.com");
    expect(text).toContain("Artifact:");
    expect(text).toContain("Main Heading");
    expect(details.source).toBe("html");
    expect(details.artifactPath.startsWith("/")).toBe(true);
    expect(details.artifactComplete).toBe(true);
    expect(details.artifactPath.endsWith(".md")).toBe(true);

    // The artifact file itself contains converted source, not the inline header.
    const artifactText = await readFile(details.artifactPath, "utf8");
    expect(artifactText).toContain("Main Heading");
    expect(artifactText).not.toContain("Artifact:");
    expect(artifactText).not.toContain("Nav links");
  });

  it("fetching plain text creates a .txt artifact with the trimmed source", async () => {
    const api = makeFakeApi();
    configureTestRuntime({ fetchFn: makeFetchMock(mockResponse("  hello\nworld  ", 200, { "content-type": "text/plain" })) });

    const result = await api.tool.execute("c2", { url: "https://example.com/robots.txt" }, undefined, undefined, makeCtx("sess-1"));
    const text = (result.content[0] as { type: "text"; text: string }).text;
    const details = result.details as WebFetchDetails;

    expect(text).toContain("hello\nworld");
    expect(details.source).toBe("text");
    expect(details.artifactPath.endsWith(".txt")).toBe(true);
    expect(await readFile(details.artifactPath, "utf8")).toBe("hello\nworld");
  });

  it("fetching a PDF creates an artifact and reports page count", async () => {
    const api = makeFakeApi();
    configureTestRuntime({
      fetchFn: makeFetchMock(mockResponse(SAMPLE_PDF, 200, { "content-type": "application/pdf" })),
      extractPdfFn: customPdfExtract,
    });

    const result = await api.tool.execute("c3", { url: "https://example.com/doc.pdf" }, undefined, undefined, makeCtx("sess-1"));
    const text = (result.content[0] as { type: "text"; text: string }).text;
    const details = result.details as WebFetchDetails;

    expect(text).toContain("Custom extracted text");
    expect(text).toContain("Pages: 3");
    expect(details.source).toBe("pdf");
    expect(details.pageCount).toBe(3);
    expect(details.truncated).toBe(false);
    expect(details.artifactComplete).toBe(true);
    expect(await readFile(details.artifactPath, "utf8")).toContain("Custom extracted text");
  });

  it("marks a truncated PDF artifact as partial in content and details", async () => {
    const api = makeFakeApi();
    configureTestRuntime({
      fetchFn: makeFetchMock(mockResponse("%PDF-dummy", 200, { "content-type": "application/pdf" })),
      extractPdfFn: truncatingPdf,
      pdfPageLimit: 50,
    });

    const result = await api.tool.execute("c4", { url: "https://example.com/big.pdf" }, undefined, undefined, makeCtx("sess-1"));
    const text = (result.content[0] as { type: "text"; text: string }).text;
    const details = result.details as WebFetchDetails;

    expect(text).toContain("Pages: 120 (extraction limited to first 50 pages)");
    expect(text).toContain("Warning: artifact is partial");
    expect(details.truncated).toBe(true);
    expect(details.artifactComplete).toBe(false);
  });

  it("succeeds for a meaningful short page, with only a warning", async () => {
    const api = makeFakeApi();
    configureTestRuntime({ fetchFn: makeFetchMock(mockResponse("<html><body><p>Hi there</p></body></html>", 200, { "content-type": "text/html" })) });

    const result = await api.tool.execute("c5", { url: "https://example.com/short" }, undefined, undefined, makeCtx("sess-1"));
    const text = (result.content[0] as { type: "text"; text: string }).text;
    const details = result.details as WebFetchDetails;

    expect(text).toContain("Hi there");
    expect(details.extractionWarning).toBeDefined();
    expect(details.artifactComplete).toBe(true);
  });

  it("produces distinct artifacts for concurrent calls", async () => {
    const api = makeFakeApi();
    configureTestRuntime({
      fetchFn: makeFetchMock((url) =>
        mockResponse(`<html><body><article><h1>${url}</h1><p>content</p></article></body></html>`, 200, { "content-type": "text/html" }),
      ),
    });

    const [r1, r2] = await Promise.all([
      api.tool.execute("a", { url: "https://example.com/one" }, undefined, undefined, makeCtx("sess-1")),
      api.tool.execute("b", { url: "https://example.com/two" }, undefined, undefined, makeCtx("sess-1")),
    ]);
    const p1 = (r1.details as WebFetchDetails).artifactPath;
    const p2 = (r2.details as WebFetchDetails).artifactPath;

    expect(p1).not.toBe(p2);
    expect(await readFile(p1, "utf8")).toContain("https://example.com/one");
    expect(await readFile(p2, "utf8")).toContain("https://example.com/two");
  });
});

// ─── Failures through the registered tool ────────────────────────────────────

describe("web_fetch tool — failures never publish artifacts", () => {
  it("HTTP errors, network errors, binary types, and timeouts leave no files", async () => {
    const cases: [string, typeof globalThis.fetch, RegExp][] = [
      ["https://example.com/404", makeFetchMock(mockResponse("Not Found", 404, { "content-type": "text/html" })), /404/],
      ["https://example.com/down", networkErrorFetch, /Network error/],
      ["https://example.com/i.png", makeFetchMock(mockResponse("...", 200, { "content-type": "image/png" })), /Unsupported content type/],
      ["https://example.com/slow", abortOnSignalFetch, /timed out/],
    ];
    for (const [url, fetchFn, expectMsg] of cases) {
      const api = makeFakeApi();
      configureTestRuntime({ fetchFn, fetchTimeoutMs: 50 });

      await expect(
        api.tool.execute("f", { url }, undefined, undefined, makeCtx("sess-1")),
      ).rejects.toThrowError(expectMsg);
      expect(await listFiles(storageRoot)).toEqual([]);
    }
  });

  it("rejects an oversized declared length and cleans up the download", async () => {
    const api = makeFakeApi();
    configureTestRuntime({
      fetchFn: makeFetchMock(mockResponse("small body", 200, { "content-type": "text/html", "content-length": "99999999" })),
    });
    await expect(
      api.tool.execute("f", { url: "https://example.com/huge" }, undefined, undefined, makeCtx("sess-1")),
    ).rejects.toThrowError(/too large/);
    expect(await listFiles(storageRoot)).toEqual([]);
  });

  it("removes the partial download when the streamed body exceeds the cap", async () => {
    const api = makeFakeApi();
    configureTestRuntime({
      fetchFn: makeFetchMock(mockResponse("x".repeat(600_000), 200, { "content-type": "text/html" })),
    });
    await expect(
      api.tool.execute("f", { url: "https://example.com/over" }, undefined, undefined, makeCtx("sess-1")),
    ).rejects.toThrowError(/exceeded size cap/);
    expect(await listFiles(storageRoot)).toEqual([]);
  });

  it("rejects an unsupported PDF without creating an empty artifact", async () => {
    const api = makeFakeApi();
    configureTestRuntime({
      fetchFn: makeFetchMock(mockResponse("%PDF-1.4 compressed", 200, { "content-type": "application/pdf" })),
      extractPdfFn: emptyPdf,
    });
    await expect(
      api.tool.execute("f", { url: "https://example.com/scanned.pdf" }, undefined, undefined, makeCtx("sess-1")),
    ).rejects.toThrowError(/Failed to extract text from PDF/);
    expect(await listFiles(storageRoot)).toEqual([]);
  });

  it("rejects unusable HTML without publishing an artifact", async () => {
    const api = makeFakeApi();
    configureTestRuntime({
      fetchFn: makeFetchMock(mockResponse("<html><body><script>var x=1;</script><style>.a{}</style></body></html>", 200, { "content-type": "text/html" })),
    });
    await expect(
      api.tool.execute("f", { url: "https://example.com/empty" }, undefined, undefined, makeCtx("sess-1")),
    ).rejects.toThrowError(/Failed to extract readable content/);
    expect(await listFiles(storageRoot)).toEqual([]);
  });

  it("never issues a request to an alternate host on direct failure", async () => {
    const requested: string[] = [];
    const api = makeFakeApi();
    const spyFetch: typeof globalThis.fetch = async (input, _init) => {
      requested.push(String(input));
      throw new Error("Network failure");
    };
    configureTestRuntime({ fetchFn: spyFetch });

    await expect(
      api.tool.execute("f", { url: "https://example.com/direct" }, undefined, undefined, makeCtx("sess-1")),
    ).rejects.toThrow();
    expect(requested).toEqual(["https://example.com/direct"]);
  });
});

// ─── Ownership records ───────────────────────────────────────────────────────

describe("web_fetch tool — ownership records", () => {
  it("writes an owner record listing the finalized artifact and removed download", async () => {
    const api = makeFakeApi();
    configureTestRuntime({
      fetchFn: makeFetchMock(mockResponse(HTML_FIXTURE, 200, { "content-type": "text/html" })),
    });
    const result = await api.tool.execute("c1", { url: "https://example.com" }, undefined, undefined, makeCtx("sess-1"));
    const artifactPath = (result.details as WebFetchDetails).artifactPath;

    const files = await listFiles(storageRoot);
    const recordPath = files.find((f) => f.endsWith("owner.json"));
    expect(recordPath).toBeDefined();
    const record = JSON.parse(await readFile(recordPath!, "utf8"));
    expect(record.sessionId).toBe("sess-1");
    expect(record.pid).toBe(process.pid);
    expect(record.artifacts).toEqual([
      expect.objectContaining({ path: artifactPath, complete: true }),
    ]);
    // The raw download is gone; only the artifact and record remain.
    expect(files.filter((f) => f.endsWith(".download"))).toEqual([]);
  });
});

// ─── Session lifecycle ───────────────────────────────────────────────────────

describe("web_fetch tool — session lifecycle", () => {
  async function fetchAndExpectArtifact(api: FakeApi, sessionId: string, url = "https://example.com"): Promise<string> {
    configureTestRuntime({
      fetchFn: makeFetchMock(mockResponse(HTML_FIXTURE, 200, { "content-type": "text/html" })),
    });
    const result = await api.tool.execute("c1", { url }, undefined, undefined, makeCtx(sessionId));
    return (result.details as WebFetchDetails).artifactPath;
  }

  for (const reason of ["quit", "new", "resume", "fork"] as const) {
    it(`removes session artifacts on shutdown reason "${reason}"`, async () => {
      const api = makeFakeApi();
      await emit(api, { type: "session_start", reason: "startup" }, makeCtx("sess-1"));
      const artifactPath = await fetchAndExpectArtifact(api, "sess-1");
      expect(await fileExists(artifactPath)).toBe(true);

      await emit(
        api,
        { type: "session_shutdown", reason, targetSessionFile: "/other/session" },
        makeCtx("sess-1"),
      );
      expect(await fileExists(artifactPath)).toBe(false);
      expect(await listFiles(storageRoot)).toEqual([]);
    });
  }

  it("keeps artifacts on reload and removes them when the session is finally left", async () => {
    const api = makeFakeApi();
    await emit(api, { type: "session_start", reason: "startup" }, makeCtx("sess-1"));
    const artifactPath = await fetchAndExpectArtifact(api, "sess-1");

    await emit(api, { type: "session_shutdown", reason: "reload" }, makeCtx("sess-1"));
    expect(await fileExists(artifactPath)).toBe(true);

    await emit(api, { type: "session_shutdown", reason: "resume", targetSessionFile: "/new" }, makeCtx("sess-1"));
    expect(await fileExists(artifactPath)).toBe(false);
    expect(await listFiles(storageRoot)).toEqual([]);
  });

  it("keeps artifacts across navigation within the same session", async () => {
    const api = makeFakeApi();
    const artifactPath = await fetchAndExpectArtifact(api, "sess-1");
    await emit(api, { type: "session_tree", newLeafId: "l2", oldLeafId: "l1" }, makeCtx("sess-1"));
    expect(await fileExists(artifactPath)).toBe(true);
  });

  it("a second leave is a harmless no-op (idempotent cleanup)", async () => {
    const api = makeFakeApi();
    const artifactPath = await fetchAndExpectArtifact(api, "sess-1");
    await emit(api, { type: "session_shutdown", reason: "resume", targetSessionFile: "/x" }, makeCtx("sess-1"));
    await emit(api, { type: "session_shutdown", reason: "resume", targetSessionFile: "/x" }, makeCtx("sess-1"));
    expect(await fileExists(artifactPath)).toBe(false);
  });

  it("tolerates already-removed artifacts at leave time", async () => {
    const api = makeFakeApi();
    const artifactPath = await fetchAndExpectArtifact(api, "sess-1");
    await rm(artifactPath, { force: true });
    await expect(emit(api, { type: "session_shutdown", reason: "resume", targetSessionFile: "/x" }, makeCtx("sess-1"))).resolves.toBeUndefined();
  });

  it("concurrent sessions keep separate owned areas and clean only their own", async () => {
    const api = makeFakeApi();
    const aPath = await fetchAndExpectArtifact(api, "sess-A", "https://example.com/a");
    await emit(api, { type: "session_start", reason: "new", previousSessionFile: "a" }, makeCtx("sess-B"));
    const bPath = await fetchAndExpectArtifact(api, "sess-B", "https://example.com/b");

    await emit(api, { type: "session_shutdown", reason: "resume", targetSessionFile: "/x" }, makeCtx("sess-A"));
    expect(await fileExists(aPath)).toBe(false);
    expect(await fileExists(bPath)).toBe(true);

    await emit(api, { type: "session_shutdown", reason: "resume", targetSessionFile: "/y" }, makeCtx("sess-B"));
    expect(await fileExists(bPath)).toBe(false);
    expect(await listFiles(storageRoot)).toEqual([]);
  });

  it("works without a known session id (fallback ownership) and cleans up", async () => {
    const api = makeFakeApi();
    const result = await api.tool.execute("c1", { url: "https://example.com" }, undefined, undefined, makeCtx(undefined));
    const artifactPath = (result.details as WebFetchDetails).artifactPath;
    expect(await fileExists(artifactPath)).toBe(true);

    await emit(api, { type: "session_shutdown", reason: "resume", targetSessionFile: "/x" }, makeCtx(undefined));
    expect(await listFiles(storageRoot)).toEqual([]);
  });
});

// ─── Cancellation and pending-work ownership ─────────────────────────────────

describe("web_fetch tool — cancellation and pending work", () => {
  it("cancels a pending download and removes the incomplete file", async () => {
    const api = makeFakeApi();
    const gate = deferred<void>();
    configureTestRuntime({ fetchFn: makeGatedFetch(HTML_FIXTURE, gate.promise) });
    const controller = new AbortController();
    const pending = api.tool.execute("c1", { url: "https://example.com" }, controller.signal, undefined, makeCtx("sess-1"));

    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(await listFiles(storageRoot)).toEqual([]);
  });

  it("an abandoned conversion cannot finalize an artifact", async () => {
    const api = makeFakeApi();
    const gate = deferred<void>();
    configureTestRuntime({ fetchFn: makeGatedFetch(HTML_FIXTURE, gate.promise, { honorSignal: false }) });
    const controller = new AbortController();
    const pending = api.tool.execute("c1", { url: "https://example.com" }, controller.signal, undefined, makeCtx("sess-1"));

    // Abort before the gated body is released: the download completes from the
    // mock's perspective, but the post-download liveness check must stop it.
    controller.abort();
    gate.resolve();
    await expect(pending).rejects.toThrow();
    expect(await listFiles(storageRoot)).toEqual([]);
  });

  it("a pending download released after its owner left cannot recreate files or publish", async () => {
    const api = makeFakeApi();
    await emit(api, { type: "session_start", reason: "startup" }, makeCtx("sess-1"));
    const gate = deferred<void>();
    configureTestRuntime({ fetchFn: makeGatedFetch(HTML_FIXTURE, gate.promise, { honorSignal: false }) });

    const pending = api.tool.execute("c1", { url: "https://example.com" }, undefined, undefined, makeCtx("sess-1"));
    // Leave the owner while the download is still blocked.
    await emit(api, { type: "session_shutdown", reason: "resume", targetSessionFile: "/next" }, makeCtx("sess-1"));

    // Release the blocked response: the old owner is gone and cannot publish.
    gate.resolve();
    await expect(pending).rejects.toThrow();
    expect(await listFiles(storageRoot)).toEqual([]);

    // The next session starts fresh and fetches independently.
    await emit(api, { type: "session_start", reason: "resume", previousSessionFile: "/prev" }, makeCtx("sess-2"));
    configureTestRuntime({
      fetchFn: makeFetchMock(mockResponse("<html><body><article><h1>Second session</h1><p>ok</p></article></body></html>", 200, { "content-type": "text/html" })),
    });
    const result = await api.tool.execute("c2", { url: "https://example.com/next" }, undefined, undefined, makeCtx("sess-2"));
    const details = result.details as WebFetchDetails;
    expect(details.artifactPath.includes("sess-2")).toBe(true);
    expect(await readFile(details.artifactPath, "utf8")).toContain("Second session");
  });
});

// ─── Cleanup failure observability ───────────────────────────────────────────

describe("web_fetch tool — cleanup failure observability", () => {
  it("reports a failed removal, keeps the ownership record, and cleans on retry", async () => {
    const api = makeFakeApi();
    configureTestRuntime({
      fetchFn: makeFetchMock(mockResponse(HTML_FIXTURE, 200, { "content-type": "text/html" })),
    });
    const result = await api.tool.execute("c1", { url: "https://example.com" }, undefined, undefined, makeCtx("sess-1"));
    const artifactPath = (result.details as WebFetchDetails).artifactPath;

    // Make the run directory read-only so every unlink inside it fails.
    const runDir = join(storageRoot, "sess-1");
    await chmod(runDir, 0o555);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await emit(api, { type: "session_shutdown", reason: "resume", targetSessionFile: "/x" }, makeCtx("sess-1"));

    // Failure is observable (diagnostic emitted) and nothing was deleted.
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("artifact cleanup for session sess-1 failed"));
    expect(await fileExists(artifactPath)).toBe(true);

    // Restore permissions: the next leave succeeds and removes everything.
    await chmod(runDir, 0o755);
    await emit(api, { type: "session_shutdown", reason: "resume", targetSessionFile: "/x" }, makeCtx("sess-1"));
    expect(await listFiles(storageRoot)).toEqual([]);
    errorSpy.mockRestore();
  });
});

// ─── Internal resource guarantee: finalized artifact retention ─────────────

describe("ArtifactStore internal — finalized artifact retention", () => {
  it("does not delete an artifact that was settled before a later failure", async () => {
    const store = new ArtifactStore(storageRoot);
    const call = store.beginCall("sess-1", "c1", undefined);
    const run = await store.ensureRunDir(call);

    // Simulate a completed call: download registered, artifact written, settled.
    const artifactPath = join(run.dir, `${call.baseName}-artifact.md`);
    call.artifactPath = artifactPath;
    await run.registerDownload(join(run.tmpDir, `${call.baseName}.download`));
    await writeFile(artifactPath, "finalized source");
    await store.settleArtifact(call, "markdown", true);

    // A late failure (e.g. releaseDownload throwing) must not remove the finalized artifact.
    await store.failCall(call);

    expect(await fileExists(artifactPath)).toBe(true);
    expect(await readFile(artifactPath, "utf8")).toBe("finalized source");
  });

  it("still removes an artifact that was never settled", async () => {
    const store = new ArtifactStore(storageRoot);
    const call = store.beginCall("sess-1", "c1", undefined);
    await store.ensureRunDir(call);

    const artifactPath = join(storageRoot, "sess-1", store.runId, `${call.baseName}-artifact.md`);
    call.artifactPath = artifactPath;
    await writeFile(artifactPath, "incomplete source");

    await store.failCall(call);

    expect(await fileExists(artifactPath)).toBe(false);
  });
});

// ─── Structured details shape ────────────────────────────────────────────────

describe("WebFetchDetails shape", () => {
  it("carries source identity, artifact path, and completeness", () => {
    const d: WebFetchDetails = {
      url: "https://example.com/article",
      title: "An Article",
      contentType: "text/html",
      contentLength: 1234,
      source: "html",
      artifactPath: "/tmp/pi-web-fetch/sess/run/a.md",
      artifactComplete: true,
    };
    expect(d.artifactPath.startsWith("/")).toBe(true);
    expect(d.artifactComplete).toBe(true);
    expect(d.source).toBe("html");
  });
});