/**
 * Web Fetch contract and pure logic tests.
 *
 * Verifies:
 *   - Tool metadata and parameter schema
 *   - URL validation: valid, invalid, missing protocol, empty
 *   - Content-type detection: HTML, text, binary, edge cases
 *   - Fetch with mocked responses (success HTML, success text, HTTP error,
 *     oversized, timeout, binary content type)
 *   - HTML extraction, title extraction, Markdown conversion quality
 *   - Plain-text pass-through
 *   - Short/incomplete extraction warnings
 *   - Structured details shape
 *
 * Run: npx tsx tests/web-fetch-contract.test.ts
 */

import { strict as assert } from "node:assert";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import webFetchExtension from "../packages/web-fetch/index.ts";
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
} from "../packages/web-fetch/fetch.ts";
import type { WebFetchDetails, FetchOptions, PdfExtractResult } from "../packages/web-fetch/fetch.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeApi(captured: ToolDefinition[]): ExtensionAPI {
  return { registerTool: (tool) => captured.push(tool as ToolDefinition), on: () => {} } as unknown as ExtensionAPI;
}

function registerWebFetch(): ToolDefinition {
  const tools: ToolDefinition[] = [];
  webFetchExtension(makeFakeApi(tools));
  assert.strictEqual(tools.length, 1, "web_fetch registers exactly one tool");
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
  const fn: any = async (url: string | URL | Request, _init?: RequestInit) => {
    if (typeof result === "function") return result(url.toString());
    return result;
  };
  return fn;
}

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

function testToolNameAndLabel() {
  const tool = registerWebFetch();
  assert.strictEqual(tool.name, "web_fetch", "tool name is web_fetch");
  assert.strictEqual(tool.label, "Web Fetch", "tool label is Web Fetch");
  console.log("  Tool name and label .............................. PASS");
}

function testDescriptionCoversCapabilities() {
  const tool = registerWebFetch();
  assert.ok(tool.description.includes("Markdown"), "description mentions Markdown");
  assert.ok(tool.description.includes("URL"), "description mentions URL");
  assert.ok(tool.description.includes("timeout"), "description mentions timeout");
  console.log("  Description covers capabilities .................. PASS");
}

function testPromptGuidelinesMentionWebSearch() {
  const tool = registerWebFetch();
  const p = tool.promptGuidelines ?? [];
  assert.ok(p.some((g: string) => g.includes("web_search")), "guidelines mention web_search");
  assert.ok(p.some((g: string) => g.includes("llms.txt")), "guidelines mention llms.txt");
  console.log("  Prompt guidelines mention web_search + llms.txt ... PASS");
}

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

function testParameterSchemaHasUrl() {
  const tool = registerWebFetch();
  const props = (tool.parameters as any).properties;
  assert.ok(props.url, "parameters have url property");
  assert.strictEqual(props.url.type, "string", "url is a string");
  console.log("  Parameter schema has url ......................... PASS");
}

function testParameterSchemaOnlyUrl() {
  const tool = registerWebFetch();
  const props = (tool.parameters as any).properties;
  const keys = Object.keys(props);
  assert.deepStrictEqual(keys, ["url"], "only url parameter");
  console.log("  Parameter schema has only url .................... PASS");
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

function testValidateUrlValidHttps() {
  const url = validateUrl("https://example.com/page");
  assert.strictEqual(url.hostname, "example.com");
  assert.strictEqual(url.protocol, "https:");
  console.log("  validateUrl valid https .......................... PASS");
}

function testValidateUrlValidHttp() {
  const url = validateUrl("http://example.com");
  assert.strictEqual(url.hostname, "example.com");
  assert.strictEqual(url.protocol, "http:");
  console.log("  validateUrl valid http ........................... PASS");
}

function testValidateUrlAddsHttpsProtocol() {
  const url = validateUrl("example.com");
  assert.strictEqual(url.hostname, "example.com");
  assert.strictEqual(url.protocol, "https:");
  console.log("  validateUrl adds https:// for bare domains ....... PASS");
}

function testValidateUrlWithPath() {
  const url = validateUrl("https://example.com/docs/api/v1");
  assert.strictEqual(url.pathname, "/docs/api/v1");
  console.log("  validateUrl preserves path ....................... PASS");
}

function testValidateUrlEmpty() {
  assert.throws(() => validateUrl(""), WebFetchError, "empty string throws");
  assert.throws(() => validateUrl("   "), WebFetchError, "whitespace throws");
  console.log("  validateUrl empty/whitespace throws .............. PASS");
}

function testValidateUrlInvalidFormat() {
  // Only truly unparseable URLs throw — bare hostnames get https:// prefixed
  assert.throws(() => validateUrl(""), WebFetchError, "empty throws");
  assert.throws(() => validateUrl("not a url at all !!!"), WebFetchError, "garbage with space throws");
  console.log("  validateUrl invalid format throws ................ PASS");
}

function testValidateUrlUnsupportedProtocol() {
  assert.throws(() => validateUrl("ftp://files.example.com"), WebFetchError, "ftp throws");
  assert.throws(() => validateUrl("file:///etc/passwd"), WebFetchError, "file throws");
  assert.throws(() => validateUrl("data:text/plain,hello"), WebFetchError, "data throws");
  console.log("  validateUrl unsupported protocol throws .......... PASS");
}

function testValidateUrlErrorMessage() {
  try {
    validateUrl("");
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof WebFetchError);
    assert.ok((e as WebFetchError).message.includes("URL must be a non-empty string"));
    console.log("  validateUrl error message for empty .............. PASS");
  }

  // Bare hostnames like "not-a-url" are valid when we prepend https://
  // Only truly unparseable inputs fail
  try {
    validateUrl("not a url at all !!!");
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof WebFetchError);
    assert.ok((e as WebFetchError).message.includes("malformed"), "malformed message");
    console.log("  validateUrl error message for malformed .......... PASS");
  }

  try {
    validateUrl("ftp://bad.com");
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof WebFetchError);
    assert.ok((e as WebFetchError).message.includes("Unsupported protocol"), "protocol message");
    console.log("  validateUrl error message for unsupported protocol PASS");
  }
}

// ---------------------------------------------------------------------------
// Content-type helpers
// ---------------------------------------------------------------------------

function testNormalizeContentType() {
  assert.strictEqual(normalizeContentType("text/html; charset=utf-8"), "text/html");
  assert.strictEqual(normalizeContentType("text/plain"), "text/plain");
  assert.strictEqual(normalizeContentType(null), "");
  assert.strictEqual(normalizeContentType(""), "");
  console.log("  normalizeContentType ............................. PASS");
}

function testIsBinaryContentType() {
  assert.ok(isBinaryContentType("image/png"), "image/png is binary");
  assert.ok(isBinaryContentType("audio/mpeg"), "audio/mpeg is binary");
  assert.ok(isBinaryContentType("video/mp4"), "video/mp4 is binary");
  assert.ok(isBinaryContentType("font/woff2"), "font/woff2 is binary");
  assert.ok(isBinaryContentType("application/zip"), "application/zip is binary");
  assert.ok(isBinaryContentType("application/octet-stream"), "octet-stream is binary");
  assert.ok(!isBinaryContentType("text/html"), "text/html is not binary");
  assert.ok(!isBinaryContentType("text/plain"), "text/plain is not binary");
  assert.ok(!isBinaryContentType("application/json"), "application/json is not binary");
  assert.ok(!isBinaryContentType(""), "empty string is not binary");
  console.log("  isBinaryContentType .............................. PASS");
}

function testIsHtmlContentType() {
  assert.ok(isHtmlContentType("text/html"), "text/html is HTML");
  assert.ok(isHtmlContentType("application/xhtml+xml"), "xhtml is HTML");
  assert.ok(!isHtmlContentType("text/plain"), "text/plain is not HTML");
  assert.ok(!isHtmlContentType(""), "empty is not HTML");
  console.log("  isHtmlContentType ................................ PASS");
}

function testIsTextContentType() {
  assert.ok(isTextContentType("text/plain"), "text/plain is text");
  assert.ok(isTextContentType("text/css"), "text/css is text");
  assert.ok(isTextContentType("text/csv"), "text/csv is text");
  assert.ok(isTextContentType("application/json"), "application/json is text");
  assert.ok(isTextContentType("application/xml"), "application/xml is text");
  assert.ok(isTextContentType("application/javascript"), "application/javascript is text");
  assert.ok(isTextContentType("application/atom+xml"), "atom+xml is text");
  assert.ok(!isTextContentType("image/png"), "image/png is not text");
  assert.ok(!isTextContentType("application/pdf"), "application/pdf is not text");
  assert.ok(!isTextContentType("text/html"), "text/html is not text (handled separately)");
  assert.ok(isTextContentType(""), "empty is assumed text");
  console.log("  isTextContentType ................................ PASS");
}

// ---------------------------------------------------------------------------
// PDF detection
// ---------------------------------------------------------------------------

function testIsPdfContentTypeByContentType() {
  assert.ok(isPdfContentType("application/pdf", "https://example.com/doc"), "application/pdf content type");
  assert.ok(!isPdfContentType("text/html", "https://example.com/page"), "text/html is not PDF");
  assert.ok(!isPdfContentType("text/plain", "https://example.com/file.txt"), "text/plain is not PDF");
  assert.ok(!isPdfContentType("", "https://example.com/page"), "empty content type is not PDF");
  console.log("  isPdfContentType by content-type ................. PASS");
}

function testIsPdfContentTypeByUrl() {
  assert.ok(isPdfContentType("", "https://example.com/doc.pdf"), "URL ending in .pdf");
  assert.ok(isPdfContentType("", "https://example.com/file.PDF"), "URL ending in .PDF (case-insensitive)");
  assert.ok(isPdfContentType("text/html", "https://example.com/doc.pdf?raw=1"), "URL with .pdf and query string");
  assert.ok(!isPdfContentType("", "https://example.com/page"), "URL without .pdf");
  assert.ok(!isPdfContentType("", "https://example.com/pdf"), "URL ending in /pdf not a file");
  console.log("  isPdfContentType by URL .......................... PASS");
}

function testIsPdfContentTypeTakesPriority() {
  // Content-type takes priority over URL hint
  assert.ok(isPdfContentType("application/pdf", "https://example.com/page"), "content-type wins over URL");
  // But if content-type is non-PDF and URL is .pdf, still detected as PDF
  assert.ok(isPdfContentType("text/html", "https://example.com/doc.pdf"), "URL .pdf detected even with non-PDF content-type");
  console.log("  isPdfContentType priority ........................ PASS");
}

function testIsBinaryContentTypeExcludesPdf() {
  assert.ok(!isBinaryContentType("application/pdf"), "application/pdf is not binary (can be extracted)");
  // Other application/* types remain binary
  assert.ok(isBinaryContentType("application/zip"), "application/zip remains binary");
  assert.ok(isBinaryContentType("application/octet-stream"), "octet-stream remains binary");
  console.log("  isBinaryContentType excludes PDF ................. PASS");
}

// ---------------------------------------------------------------------------
// PDF extraction
// ---------------------------------------------------------------------------

function testExtractPdfContentBasic() {
  // A minimal PDF with a single text object
  const pdfBytes = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R" +
    "/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj\n" +
    "4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n" +
    "5 0 obj<</Length 44>>stream\nBT /F1 12 Tf 72 700 Td (Hello PDF world) Tj ET\n" +
    "endstream\nendobj\nxref\n0 6\ntrailer<</Size 6/Root 1 0 R>>\nstartxref\n349\n%%EOF";

  const result = extractPdfContent(pdfBytes, "https://example.com/doc.pdf");
  assert.ok(result.text.includes("Hello PDF world"), "extracts text from simple PDF");
  assert.strictEqual(result.pageCount, 1, "reports page count");
  assert.ok(!result.truncated, "not truncated by default");
  console.log("  extractPdfContent basic PDF ...................... PASS");
}

function testExtractPdfContentUsesInjectedFn() {
  const customExtract: (body: string, url: string) => PdfExtractResult = (
    _body: string,
    _url: string,
  ) => ({
    text: "Custom extracted text",
    pageCount: 3,
  });

  const result = extractPdfContent(
    "%PDF-dummy",
    "https://example.com/doc.pdf",
    { extractPdfFn: customExtract },
  );
  assert.strictEqual(result.text, "Custom extracted text", "uses injected extract function");
  assert.strictEqual(result.pageCount, 3, "uses injected page count");
  console.log("  extractPdfContent uses injected fn .............. PASS");
}

function testExtractPdfContentEmptyPdf() {
  const result = extractPdfContent("", "https://example.com/empty.pdf");
  assert.strictEqual(result.text, "", "empty PDF produces empty text");
  assert.strictEqual(result.pageCount, 0, "empty PDF has 0 pages");
  console.log("  extractPdfContent empty PDF ...................... PASS");
}

function testExtractPdfContentNonPdf() {
  const result = extractPdfContent("This is not a PDF at all", "https://example.com/not.pdf");
  assert.strictEqual(result.text, "", "non-PDF content produces empty text");
  assert.strictEqual(result.pageCount, 0, "non-PDF has 0 pages");
  console.log("  extractPdfContent non-PDF content ............... PASS");
}

function testExtractPdfContentPageLimitTruncation() {
  // Create a PDF with multiple pages
  const page = "/Type /Page\n";
  const pdfHeader = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n";
  const pages = Array.from({ length: 10 }, (_, i) =>
    `${i + 2} 0 obj<</Type/Page/Parent 1 0 R>>endobj`,
  ).join("\n");
  const multiPagePdf = pdfHeader + pages + "\n" + page.repeat(10) + "\ntrailer<</Size 12/Root 1 0 R>>\n%%EOF";

  // With page limit of 3
  const result = extractPdfContent(multiPagePdf, "https://example.com/multi.pdf", { pageLimit: 3 });
  assert.strictEqual(result.pageCount, 10, "reports actual page count");
  assert.ok(result.truncated, "truncated flag set");
  assert.ok(result.text.includes("PDF truncated"), "truncation note in text");
  console.log("  extractPdfContent page limit truncation .......... PASS");
}

function testExtractPdfContentUnparseable() {
  // A PDF header but no extractable text content
  const pdfBytes = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj\n" +
    "xref\n0 4\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n100\n%%EOF";

  const result = extractPdfContent(pdfBytes, "https://example.com/empty.pdf");
  assert.strictEqual(result.text, "", "no text extracted from empty PDF");
  assert.strictEqual(result.pageCount, 1, "detects 1 page even without text");
  console.log("  extractPdfContent unparseable PDF ................ PASS");
}

async function testFetchPdfSizeCap() {
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

  // Should NOT throw since PDF cap is larger
  const { body } = await fetchUrl(url, opts);
  assert.ok(body.includes("%PDF-1.4"), "PDF body retrieved with PDF-specific cap");
  console.log("  fetchUrl PDF-specific size cap ................... PASS");
}

async function testFetchPdfSizeCapExceeded() {
  // PDF content exceeding both caps
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
    maxPdfBytes: 1024 * 1024, // 1MB — still smaller than 12MB
  };

  await assert.rejects(
    () => fetchUrl(url, opts),
    (err: WebFetchError) => {
      assert.ok(err.message.includes("too large"), "error mentions too large");
      return true;
    },
  );
  console.log("  fetchUrl PDF-specific size cap exceeded ........... PASS");
}

// ---------------------------------------------------------------------------
// Jina Reader fallback
// ---------------------------------------------------------------------------

async function testJinaFallbackSuccess() {
  // Jina returns clean markdown
  const jinaContent = "# Extracted via Jina\n\nThis is clean Markdown from Jina Reader.";
  const mockFetch = makeFetchMock(
    mockResponse(jinaContent, 200, { "content-type": "text/plain" }),
  );

  const result = await tryJinaFallback("https://example.com/dynamic", {
    fetchFn: mockFetch,
  });

  assert.ok(result !== null, "fallback returns content");
  assert.ok(result!.includes("Extracted via Jina"), "Jina content included");
  console.log("  tryJinaFallback success ........................... PASS");
}

async function testJinaFallbackHttpError() {
  const mockFetch = makeFetchMock(
    mockResponse("Not Found", 404, { "content-type": "text/plain" }),
  );

  const result = await tryJinaFallback("https://example.com/missing", {
    fetchFn: mockFetch,
  });

  assert.strictEqual(result, null, "fallback returns null on HTTP error");
  console.log("  tryJinaFallback HTTP error returns null ........... PASS");
}

async function testJinaFallbackNetworkError() {
  const mockFetch: typeof globalThis.fetch = async () => {
    throw new Error("Network failure");
  };

  const result = await tryJinaFallback("https://example.com/down", {
    fetchFn: mockFetch,
  });

  assert.strictEqual(result, null, "fallback returns null on network error");
  console.log("  tryJinaFallback network error returns null ....... PASS");
}

// ---------------------------------------------------------------------------
// HTML extraction
// ---------------------------------------------------------------------------

function testExtractHtmlTitle() {
  const html = "<html><head><title>Test Page</title></head><body><p>Hello</p></body></html>";
  const { title, content } = extractHtmlContent(html, "https://example.com");
  assert.strictEqual(title, "Test Page", "extracts title");
  assert.ok(content.length > 0, "has content");
  console.log("  extractHtmlContent extracts title ................ PASS");
}

function testExtractHtmlContentFromArticle() {
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
  assert.strictEqual(title, "Article Title");
  assert.ok(content.includes("Main Heading"), "content includes heading");
  assert.ok(content.includes("article content"), "content includes paragraph text");
  assert.ok(content.includes("[link]"), "content includes markdown link");
  assert.ok(!content.includes("Nav links"), "chrome nav stripped");
  assert.ok(!content.includes("Footer"), "chrome footer stripped");
  console.log("  extractHtmlContent from <article> ................ PASS");
}

function testExtractHtmlContentFromMain() {
  const html = `
    <html><body>
      <header>Header</header>
      <main>
        <h1>Page Title</h1>
        <p>Main area content here.</p>
      </main>
      <aside>Sidebar</aside>
    </body></html>`;
  const { title, content } = extractHtmlContent(html, "https://example.com");
  assert.ok(content.includes("Page Title"), "includes main heading");
  assert.ok(content.includes("Main area content"), "includes main text");
  assert.ok(!content.includes("Header"), "header stripped");
  assert.ok(!content.includes("Sidebar"), "aside stripped");
  console.log("  extractHtmlContent from <main> ................... PASS");
}

function testExtractHtmlContentBodyFallback() {
  const html = "<html><body><h1>Fallback</h1><p>No article or main element.</p></body></html>";
  const { title, content } = extractHtmlContent(html, "https://example.com");
  assert.ok(content.includes("Fallback"), "includes heading from body");
  assert.ok(content.includes("No article or main element"), "includes text from body");
  console.log("  extractHtmlContent body fallback ................. PASS");
}

function testExtractHtmlNoContentWarning() {
  const html = "<html><body><p>Hi</p></body></html>";
  const { title, extractionWarning } = extractHtmlContent(html, "https://example.com");
  assert.ok(extractionWarning, "short content produces warning");
  assert.ok(extractionWarning!.includes("Very little content"), "warning mentions little content");
  console.log("  extractHtmlContent short content warning ......... PASS");
}

function testExtractHtmlStripScripts() {
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
  assert.ok(content.includes("Real Content"), "real content preserved");
  assert.ok(content.includes("Important text"), "text preserved");
  assert.ok(!content.includes("alert"), "script stripped");
  assert.ok(!content.includes(".css"), "style stripped");
  console.log("  extractHtmlContent strips scripts and styles ..... PASS");
}

// ---------------------------------------------------------------------------
// Markdown conversion
// ---------------------------------------------------------------------------

function testHtmlToMarkdownHeadings() {
  const md = htmlToMarkdown("<h1>One</h1><h2>Two</h2><h3>Three</h3>");
  assert.ok(md.includes("# One"), "h1");
  assert.ok(md.includes("## Two"), "h2");
  assert.ok(md.includes("### Three"), "h3");
  console.log("  htmlToMarkdown headings .......................... PASS");
}

function testHtmlToMarkdownLinks() {
  const md = htmlToMarkdown('<p>Visit <a href="https://example.com">Example</a> today.</p>');
  assert.ok(md.includes("[Example](https://example.com)"), "markdown link");
  assert.ok(md.includes("today"), "text preserved");
  console.log("  htmlToMarkdown links ............................. PASS");
}

function testHtmlToMarkdownBoldAndItalic() {
  const md = htmlToMarkdown("<p><strong>Bold</strong> and <em>italic</em> text.</p>");
  assert.ok(md.includes("**Bold**"), "bold");
  assert.ok(md.includes("*italic*"), "italic");
  console.log("  htmlToMarkdown bold and italic ................... PASS");
}

function testHtmlToMarkdownCode() {
  const md = htmlToMarkdown('<p>Use the <code>fetch()</code> function.</p>');
  assert.ok(md.includes("`fetch()`"), "inline code");
  console.log("  htmlToMarkdown inline code ....................... PASS");
}

function testHtmlToMarkdownCodeBlock() {
  const md = htmlToMarkdown('<pre><code>const x = 1;\nconsole.log(x);</code></pre>');
  assert.ok(md.includes("```"), "code fence");
  assert.ok(md.includes("const x = 1;"), "code content");
  console.log("  htmlToMarkdown code block ........................ PASS");
}

function testHtmlToMarkdownLists() {
  const md = htmlToMarkdown(
    "<ul><li>Item A</li><li>Item B</li></ul>" +
    "<ol><li>First</li><li>Second</li></ol>",
  );
  assert.ok(md.includes("- Item A"), "unordered list item");
  assert.ok(md.includes("- Item B"), "unordered list item 2");
  assert.ok(md.includes("1. First"), "ordered list item");
  assert.ok(md.includes("2. Second"), "ordered list item 2");
  console.log("  htmlToMarkdown lists ............................. PASS");
}

function testHtmlToMarkdownImages() {
  const md = htmlToMarkdown('<img src="https://example.com/img.png" alt="Photo">');
  assert.ok(md.includes("![Photo](https://example.com/img.png)"), "image markdown");
  console.log("  htmlToMarkdown images ............................ PASS");
}

function testHtmlToMarkdownEntities() {
  const md = htmlToMarkdown("<p>AT&amp;T &amp; IBM</p>");
  assert.ok(md.includes("AT&T & IBM"), "decoded entities");
  console.log("  htmlToMarkdown decodes entities .................. PASS");
}

// ---------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------

function testProcessPlainText() {
  assert.strictEqual(processPlainText("  hello  "), "hello");
  assert.strictEqual(processPlainText("hello\nworld"), "hello\nworld");
  console.log("  processPlainText ................................. PASS");
}

// ---------------------------------------------------------------------------
// fetchUrl with mocked fetch
// ---------------------------------------------------------------------------

async function testFetchSuccessHtml() {
  const html = "<html><body><article><h1>Hello</h1><p>World</p></article></body></html>";
  const mockFetch = makeFetchMock(mockResponse(html, 200, { "content-type": "text/html" }));
  const url = validateUrl("https://example.com");
  const { response, body } = await fetchUrl(url, { fetchFn: mockFetch });

  assert.strictEqual(response.status, 200);
  assert.strictEqual(normalizeContentType(response.headers.get("content-type")), "text/html");
  assert.ok(body.includes("Hello"), "body contains HTML");
  console.log("  fetchUrl (mocked) HTML success ................... PASS");
}

async function testFetchPlainText() {
  const text = "Hello, this is plain text content.";
  const mockFetch = makeFetchMock(mockResponse(text, 200, { "content-type": "text/plain" }));
  const url = validateUrl("https://example.com/readme.txt");
  const { response, body } = await fetchUrl(url, { fetchFn: mockFetch });

  assert.strictEqual(response.status, 200);
  assert.strictEqual(body, text);
  console.log("  fetchUrl (mocked) plain text ..................... PASS");
}

async function testFetchHttpError() {
  const mockFetch = makeFetchMock(mockResponse("Not Found", 404, { "content-type": "text/html" }));
  const url = validateUrl("https://example.com/missing");

  await assert.rejects(
    () => fetchUrl(url, { fetchFn: mockFetch }),
    (err: WebFetchError) => {
      assert.ok(err.message.includes("404"), "error mentions status");
      assert.ok(err.message.includes("Not Found"), "error mentions status text");
      return true;
    },
  );
  console.log("  fetchUrl (mocked) HTTP 404 error ................. PASS");
}

async function testFetchBinaryContent() {
  const mockFetch = makeFetchMock(
    mockResponse("...binary...", 200, { "content-type": "image/png" }),
  );
  const url = validateUrl("https://example.com/image.png");

  await assert.rejects(
    () => fetchUrl(url, { fetchFn: mockFetch }),
    (err: WebFetchError) => {
      assert.ok(err.message.includes("Unsupported content type"), "error mentions content type");
      assert.ok(err.message.includes("image/png"), "error mentions image/png");
      return true;
    },
  );
  console.log("  fetchUrl (mocked) binary content ................. PASS");
}

async function testFetchPdfAllowed() {
  // PDF is not treated as binary — it passes through for PDF extraction
  const pdfContent = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R" +
    "/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj\n" +
    "4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n" +
    "5 0 obj<</Length 44>>stream\nBT /F1 12 Tf 72 700 Td (Hello PDF world) Tj ET\n" +
    "endstream\nendobj\nxref\n0 6\ntrailer<</Size 6/Root 1 0 R>>\nstartxref\n349\n%%EOF";
  const mockFetch = makeFetchMock(
    mockResponse(pdfContent, 200, { "content-type": "application/pdf" }),
  );
  const url = validateUrl("https://example.com/doc.pdf");

  // Should not throw (PDF is allowed through, extraction happens later)
  const { response, body } = await fetchUrl(url, { fetchFn: mockFetch });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(
    normalizeContentType(response.headers.get("content-type")),
    "application/pdf",
  );
  assert.ok(body.includes("Hello PDF world"), "PDF body content preserved");
  console.log("  fetchUrl (mocked) PDF allowed through ............ PASS");
}

async function testFetchContentLengthCap() {
  const mockFetch = makeFetchMock(
    mockResponse("x".repeat(600_000), 200, {
      "content-type": "text/html",
      "content-length": "600000",
    }),
  );
  const url = validateUrl("https://example.com/large");
  const opts: FetchOptions = { fetchFn: mockFetch, maxContentBytes: 100_000 };

  await assert.rejects(
    () => fetchUrl(url, opts),
    (err: WebFetchError) => {
      assert.ok(err.message.includes("too large"), "error mentions too large");
      return true;
    },
  );
  console.log("  fetchUrl (mocked) content-length cap ............. PASS");
}

async function testFetchTimeout() {
  let abortCalled = false;
  const mockFetch: typeof globalThis.fetch = async (_url, init) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = (init as RequestInit)?.signal;
      if (signal) {
        signal.addEventListener("abort", () => {
          abortCalled = true;
          reject(new DOMException("Aborted", "AbortError"));
        });
      }
    });
  };
  const url = validateUrl("https://example.com/slow");
  const opts: FetchOptions = { fetchFn: mockFetch, fetchTimeoutMs: 50 };

  await assert.rejects(
    () => fetchUrl(url, opts),
    (err: WebFetchError) => {
      assert.ok(err.message.includes("timed out"), "error mentions timeout");
      return true;
    },
  );
  console.log("  fetchUrl (mocked) timeout ........................ PASS");
}

async function testFetchOversizedBody() {
  // Build a response that exceeds the cap when read via streaming
  const oversized = "x".repeat(150_000);
  const mockFetch = makeFetchMock(
    mockResponse(oversized, 200, { "content-type": "text/plain" }),
  );
  const url = validateUrl("https://example.com/big");
  const opts: FetchOptions = { fetchFn: mockFetch, maxContentBytes: 10_000 };

  await assert.rejects(
    () => fetchUrl(url, opts),
    (err: WebFetchError) => {
      assert.ok(err.message.includes("exceeded size cap"), "error mentions size cap");
      return true;
    },
  );
  console.log("  fetchUrl (mocked) oversized body cap ............. PASS");
}

// ---------------------------------------------------------------------------
// Error message quality
// ---------------------------------------------------------------------------

function testWebFetchErrorMessage() {
  try {
    throw new WebFetchError("https://example.com/bad", "Something went wrong");
  } catch (e) {
    assert.ok(e instanceof WebFetchError);
    assert.ok((e as WebFetchError).message.includes("web_fetch:"), "prefix");
    assert.ok((e as WebFetchError).message.includes("Something went wrong"), "reason");
    assert.ok((e as WebFetchError).message.includes("https://example.com/bad"), "URL");
    assert.strictEqual((e as WebFetchError).url, "https://example.com/bad");
  }
  console.log("  WebFetchError message format ..................... PASS");
}

// ---------------------------------------------------------------------------
// Full extraction pipeline
// ---------------------------------------------------------------------------

function testFullExtractionPipeline() {
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

  assert.strictEqual(title, "Test Pipeline");
  assert.ok(content.includes("Pipeline Test"), "heading");
  assert.ok(content.includes("**test**"), "bold in markdown");
  assert.ok(content.includes("[link]"), "link in markdown");
  assert.ok(content.includes("`code`"), "inline code");
  assert.ok(content.includes("- Item one"), "list item");
  assert.ok(content.includes("- Item two"), "list item 2");
  console.log("  Full extraction pipeline ......................... PASS");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  console.log("\nWeb Fetch contract tests\n");

  // Tool metadata
  testToolNameAndLabel();
  testDescriptionCoversCapabilities();
  testPromptGuidelinesMentionWebSearch();

  // Parameter schema
  testParameterSchemaHasUrl();
  testParameterSchemaOnlyUrl();

  // URL validation
  testValidateUrlValidHttps();
  testValidateUrlValidHttp();
  testValidateUrlAddsHttpsProtocol();
  testValidateUrlWithPath();
  testValidateUrlEmpty();
  testValidateUrlInvalidFormat();
  testValidateUrlUnsupportedProtocol();
  testValidateUrlErrorMessage();

  // Content-type helpers
  testNormalizeContentType();
  testIsBinaryContentType();
  testIsHtmlContentType();
  testIsTextContentType();

  // PDF detection
  testIsPdfContentTypeByContentType();
  testIsPdfContentTypeByUrl();
  testIsPdfContentTypeTakesPriority();
  testIsBinaryContentTypeExcludesPdf();

  // PDF extraction
  testExtractPdfContentBasic();
  testExtractPdfContentUsesInjectedFn();
  testExtractPdfContentEmptyPdf();
  testExtractPdfContentNonPdf();
  testExtractPdfContentPageLimitTruncation();
  testExtractPdfContentUnparseable();

  // HTML extraction
  testExtractHtmlTitle();
  testExtractHtmlContentFromArticle();
  testExtractHtmlContentFromMain();
  testExtractHtmlContentBodyFallback();
  testExtractHtmlNoContentWarning();
  testExtractHtmlStripScripts();

  // Markdown conversion
  testHtmlToMarkdownHeadings();
  testHtmlToMarkdownLinks();
  testHtmlToMarkdownBoldAndItalic();
  testHtmlToMarkdownCode();
  testHtmlToMarkdownCodeBlock();
  testHtmlToMarkdownLists();
  testHtmlToMarkdownImages();
  testHtmlToMarkdownEntities();

  // Plain text
  testProcessPlainText();

  // Mocked fetch
  await testFetchSuccessHtml();
  await testFetchPlainText();
  await testFetchHttpError();
  await testFetchBinaryContent();
  await testFetchPdfAllowed();
  await testFetchPdfSizeCap();
  await testFetchPdfSizeCapExceeded();
  await testFetchContentLengthCap();
  await testFetchTimeout();
  await testFetchOversizedBody();

  // Jina fallback
  await testJinaFallbackSuccess();
  await testJinaFallbackHttpError();
  await testJinaFallbackNetworkError();

  // Error message quality
  testWebFetchErrorMessage();

  // Pipeline
  testFullExtractionPipeline();

  console.log("\nAll tests PASS\n");
}

main();
