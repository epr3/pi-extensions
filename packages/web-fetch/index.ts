import type { ExtensionAPI, ExtensionContext, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  WebFetchError,
  DEFAULT_PDF_PAGE_LIMIT,
} from "./fetch.ts";
import type { WebFetchDetails, FetchOptions, PdfExtractFn } from "./fetch.ts";
import { ArtifactStore, FileSink } from "./storage.ts";
import type { ArtifactKind } from "./storage.ts";
import { getRuntimeKnobs } from "./runtime.ts";
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

// ─── Session identity ────────────────────────────────────────────────────────

function resolveSessionId(ctx: ExtensionContext): string {
  const sid = ctx.sessionManager?.getSessionId?.();
  return typeof sid === "string" ? sid : "";
}

// ─── Converted source (per content type) ─────────────────────────────────────

interface ConvertedSource {
  kind: ArtifactKind;
  /** Converted source text — becomes the Readable artifact's content. */
  text: string;
  title?: string;
  warning?: string;
  pageCount?: number;
  truncated?: boolean;
  source: WebFetchDetails["source"];
  contentType: string;
}

function convertHtml(body: string, urlStr: string): ConvertedSource {
  const { title, content, extractionWarning } = extractHtmlContent(body, urlStr);
  if (!content.trim()) {
    throw new WebFetchError(
      urlStr,
      "Failed to extract readable content — the page may be JavaScript-rendered or empty",
    );
  }
  return {
    kind: "markdown",
    text: content,
    title,
    warning: extractionWarning,
    source: "html",
    contentType: "text/html",
  };
}

function convertPdf(
  body: string,
  urlStr: string,
  extractPdfFn: PdfExtractFn | undefined,
  pageLimit: number,
): ConvertedSource {
  const result = extractPdfContent(body, urlStr, { extractPdfFn, pageLimit });
  if (!result.text) {
    throw new WebFetchError(
      urlStr,
      "Failed to extract text from PDF — the file may be compressed, scanned, or not a valid PDF",
    );
  }
  return {
    kind: "markdown",
    text: result.text,
    pageCount: result.pageCount,
    truncated: result.truncated ?? false,
    source: "pdf",
    contentType: "application/pdf",
  };
}

function convertText(body: string, contentType: string): ConvertedSource {
  return { kind: "text", text: processPlainText(body), source: "text", contentType };
}

// ─── Extension entry point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const knobs = getRuntimeKnobs();
  const store = new ArtifactStore(knobs.storageRoot, knobs.processLiveness);

  // Lifecycle: artifacts belong to the session that created them. Leaving,
  // replacing, or shutting down the session removes them; in-session
  // navigation does not, and a reload keeps them for the continuing session.
  pi.on("session_start", (_event, ctx) => {
    store.observeSession(resolveSessionId(ctx));
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason === "reload") {
      // Same session continues under a fresh runtime; keep its artifacts but
      // stop any in-flight work from publishing stale results.
      store.abandonPending();
      return;
    }
    await store.leaveSession(resolveSessionId(ctx));
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a URL and extract readable content as Markdown or text. " +
      "Validates the URL, fetches it with a browser-like user agent, enforces a 30-second timeout " +
      "and response-size cap, and writes the response incrementally to a temporary download file for conversion. " +
      "HTML pages are converted to Markdown, PDFs up to 10MB and 50 pages are extracted, " +
      "and plain-text/Markdown responses pass through. " +
      "Each successful call also writes a Readable artifact file with the converted source " +
      "and returns its absolute path. Artifacts live only for the creating session: they are " +
      "deleted when you leave or end that session, and crash leftovers are swept each time the extension " +
      "initializes or fetches a URL. A path from an old transcript is stale — " +
      "refetch the URL to regenerate it. " +
      "Unsupported binary media types, unusable extraction, and exceeded limits produce clear errors.",
    promptSnippet: "Fetch a URL and return its content as readable Markdown",
    promptGuidelines: [
      "Use web_fetch to retrieve the full content of a web page for analysis, summarization, or fact-checking.",
      "PDFs are extracted up to 10MB and 50 pages; longer PDFs include a truncation notice and a partial artifact.",
      "Combine with web_search to first discover relevant URLs, then fetch the most promising ones.",
      "The result includes an artifact path to the converted source file, valid only for the current session — refetch the URL after leaving a session instead of reusing an old path; crash leftovers are swept when the extension next runs, not by a background service.",
      "For documentation-heavy topics, check for /llms.txt on the host before fetching individual pages.",
      "Fetching is direct only: JavaScript-only or blocked pages are not sent to any alternate service.",
    ],
    parameters,
    renderCall: renderWebFetchCall,
    renderResult: renderWebFetchResult,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const rawUrl = params.url as string;
      const url = validateUrl(rawUrl);
      const callKnobs = getRuntimeKnobs();
      const call = await store.beginCall(resolveSessionId(ctx), toolCallId, signal);

      try {
        const run = await store.ensureRunDir(call);

        // 1. Disk-backed download: stream response bytes to a temp file.
        const downloadPath = join(run.tmpDir, `${call.baseName}.download`);
        await run.registerDownload(downloadPath);
        call.downloadPath = downloadPath;
        const sink = new FileSink(downloadPath);
        call.attachSink(sink);

        const fetchOpts: FetchOptions = {
          signal,
          fetchFn: callKnobs.fetchFn,
          fetchTimeoutMs: callKnobs.fetchTimeoutMs,
          sink: (chunk) => {
            // Never keep writing into a removed run or after cancellation.
            call.assertActive();
            return sink.write(chunk);
          },
        };
        const { response } = await fetchUrl(url, fetchOpts);
        await call.closeSink();
        call.assertActive();

        // 2. Convert the downloaded source (existing bounded converters).
        const contentType = normalizeContentType(response.headers.get("content-type"));
        const urlStr = url.toString();
        const body = await readFile(downloadPath, "utf8");

        let conv: ConvertedSource;
        if (isPdfContentType(contentType, urlStr)) {
          conv = convertPdf(body, urlStr, callKnobs.extractPdfFn, callKnobs.pdfPageLimit ?? DEFAULT_PDF_PAGE_LIMIT);
        } else if (isHtmlContentType(contentType) || contentType === "") {
          conv = convertHtml(body, urlStr);
        } else if (isTextContentType(contentType)) {
          conv = convertText(body, contentType);
        } else {
          throw new WebFetchError(
            urlStr,
            `Unsupported content type "${contentType}" — the tool can only fetch HTML, plain text, and PDFs`,
          );
        }

        // 3. Finalize the Readable artifact, then release the raw download.
        const extension = conv.kind === "markdown" ? "md" : "txt";
        const artifactPath = join(run.dir, `${call.baseName}-artifact.${extension}`);
        call.artifactPath = artifactPath;
        await writeFile(artifactPath, conv.text);
        await store.settleArtifact(call, conv.kind, !conv.truncated);
        call.assertActive();
        await store.releaseDownload(call);

        // 4. Compose the dual result: plain-text content + structured details.
        const lines: string[] = [];
        if (conv.title) lines.push(`# ${conv.title}\n`);
        lines.push(`Source: ${urlStr}`);
        lines.push(`Artifact: ${artifactPath}`);
        if (conv.pageCount !== undefined) {
          const pageInfo = conv.truncated
            ? `Pages: ${conv.pageCount} (extraction limited to first ${callKnobs.pdfPageLimit ?? DEFAULT_PDF_PAGE_LIMIT} pages)`
            : `Pages: ${conv.pageCount}`;
          lines.push(pageInfo);
        }
        if (conv.truncated) {
          lines.push(
            `Warning: artifact is partial — PDF extraction limited to ${callKnobs.pdfPageLimit ?? DEFAULT_PDF_PAGE_LIMIT} of ${conv.pageCount} pages`,
          );
        }
        if (conv.warning) lines.push(`Warning: ${conv.warning}`);

        const content = `${lines.join("\n")}\n\n${conv.text}`;
        const details: WebFetchDetails = {
          url: urlStr,
          title: conv.title ?? "",
          contentType: conv.contentType,
          contentLength: content.length,
          source: conv.source,
          extractionWarning: conv.warning,
          pageCount: conv.pageCount,
          truncated: conv.truncated,
          artifactPath,
          artifactComplete: !conv.truncated,
        };
        return textResult(content, details);
      } catch (err) {
        // Remove incomplete files for this call only; never publish anything.
        await store.failCall(call);
        throw err;
      } finally {
        store.finishCall(call);
      }
    },
  });
}