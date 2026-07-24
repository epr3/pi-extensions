import type { ExtensionAPI, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  validateUrl,
  fetchUrl,
  extractHtmlContent,
  isHtmlContentType,
  isTextContentType,
  isPdfContentType,
  normalizeContentType,
  processPlainText,
  extractPdfContent,
  tryJinaFallback,
  WebFetchError,
} from "./fetch.ts";
import type { WebFetchDetails, FetchOptions } from "./fetch.ts";
import { renderWebFetchCall, renderWebFetchResult } from "./render.ts";

// ─── Dual-result helper ──────────────────────────────────────────────────────

function textResult(text: string, details: WebFetchDetails): AgentToolResult<WebFetchDetails> {
  return { content: [{ type: "text" as const, text }], details };
}

// ─── Parameter schema ────────────────────────────────────────────────────────

const parameters = Type.Object({
  url: Type.String({
    description: "The URL to fetch and extract content from",
  }),
});

// ─── Extension entry point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a URL and extract readable content as Markdown. " +
      "Validates the URL, fetches it with a browser-like user agent, enforces a timeout " +
      "and response-size cap, and converts HTML pages into clean Markdown by extracting " +
      "article-like content rather than raw page chrome. " +
      "Detects and extracts text from PDFs (up to 10MB, 50 pages). " +
      "For JavaScript-rendered or extraction-resistant HTML pages, automatically falls back " +
      "to Jina Reader for better markdown extraction. " +
      "Plain-text responses pass through as-is. " +
      "Unsupported binary media types produce a clear error. " +
      "Short or incomplete extraction produces an actionable warning.",
    promptSnippet: "Fetch a URL and return its content as readable Markdown",
    promptGuidelines: [
      "Use web_fetch to retrieve the full content of a web page for analysis, summarization, or fact-checking.",
      "PDFs are extracted up to 10MB and 50 pages; longer PDFs include a truncation notice.",
      "Combine with web_search to first discover relevant URLs, then fetch the most promising ones.",
      "If a page returns very little content, it may rely on JavaScript — try a different source or an LLM-friendly alternative like /llms.txt.",
      "Jina Reader fallback is attempted automatically for pages that appear extraction-resistant.",
      "For documentation-heavy topics, check for /llms.txt on the host before fetching individual pages.",
    ],
    parameters,
    renderCall: renderWebFetchCall,
    renderResult: renderWebFetchResult,
    async execute(_toolCallId, params, _signal) {
      const rawUrl = params.url as string;

      // 1. Validate URL
      const url = validateUrl(rawUrl);

      // 2. Fetch with caps and timeout (PDFs get a larger size cap)
      const fetchOpts: FetchOptions = { signal: _signal };
      const { response, body } = await fetchUrl(url, fetchOpts);

      // 3. Determine content type and extract
      const contentType = normalizeContentType(response.headers.get("content-type"));
      const urlStr = url.toString();

      // 3a. PDF detection and extraction
      if (isPdfContentType(contentType, urlStr)) {
        const result = extractPdfContent(body, urlStr, {
          extractPdfFn: fetchOpts.extractPdfFn,
          pageLimit: fetchOpts.pdfPageLimit,
        });

        const { text, pageCount, truncated } = result;
        if (!text) {
          throw new WebFetchError(
            urlStr,
            "Failed to extract text from PDF — the file may be compressed, scanned, or not a valid PDF",
          );
        }

        const header = `Source: ${urlStr}`;
        const pageInfo = `Pages: ${pageCount}${truncated ? ` (extraction limited to first ${fetchOpts.pdfPageLimit ?? 50} pages)` : ""}`;
        const resultText = `${header}\n${pageInfo}\n\n${text}`;

        return textResult(resultText, {
          url: urlStr,
          title: "",
          contentType: "application/pdf",
          contentLength: resultText.length,
          source: "pdf",
          pageCount,
          truncated,
        });
      }

      // 3b. HTML extraction with optional Jina fallback
      if (isHtmlContentType(contentType) || contentType === "") {
        const { title, content, extractionWarning } = extractHtmlContent(body, urlStr);

        // Try Jina Reader fallback for short/dynamic pages
        if (!fetchOpts.disableFallback && (content.length < 100 || extractionWarning)) {
          const fallbackContent = await tryJinaFallback(urlStr, {
            fetchFn: fetchOpts.fetchFn,
            signal: _signal,
          });

          if (fallbackContent) {
            const resultText = `# ${title || "Extracted via Jina Reader"}\n\nSource: ${urlStr} (Jina Reader fallback)\n\n${fallbackContent}`;

            return textResult(resultText, {
              url: urlStr,
              title: title || "",
              contentType: "text/markdown",
              contentLength: resultText.length,
              source: "fallback",
              extractionWarning: extractionWarning
                ? `${extractionWarning}; content retrieved via Jina Reader fallback`
                : undefined,
            });
          }
        }

        const resultText = title
          ? `# ${title}\n\nSource: ${urlStr}\n\n${content}`
          : `Source: ${urlStr}\n\n${content}`;

        return textResult(resultText, {
          url: urlStr,
          title,
          contentType: contentType || "text/html",
          contentLength: resultText.length,
          source: "html",
          extractionWarning,
        });
      }

      // 3c. Plain-text pass-through
      if (isTextContentType(contentType)) {
        const text = processPlainText(body);
        const resultText = `Source: ${urlStr}\n\n${text}`;

        return textResult(resultText, {
          url: urlStr,
          title: "",
          contentType,
          contentLength: resultText.length,
          source: "text",
        });
      }

      // 3d. Fallback: try as text
      const text = processPlainText(body);
      const resultText = `Source: ${urlStr}\n\n${text}`;

      return textResult(resultText, {
        url: urlStr,
        title: "",
        contentType: contentType || "text/plain",
        contentLength: resultText.length,
        source: "text",
      });
    },
  });
}