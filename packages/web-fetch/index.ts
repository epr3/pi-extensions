import type {
  ExtensionAPI,
  ExtensionContext,
  AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  validateUrl,
  fetchUrl,
  isHtmlContentType,
  isTextContentType,
  isPdfContentType,
  normalizeContentType,
  processPlainText,
  extractPdfContent,
  WebFetchError,
  DEFAULT_PDF_PAGE_LIMIT,
} from "./fetch.ts";
import { convertHtmlFileToMarkdown } from "./converter.ts";
import type { WebFetchDetails, FetchOptions, PdfExtractFn } from "./fetch.ts";
import { ArtifactStore, FileSink } from "./storage.ts";
import type { ArtifactKind } from "./storage.ts";
import { getRuntimeKnobs } from "./runtime.ts";
import { renderWebFetchCall, renderWebFetchResult } from "./render.ts";
import { readWebFetchSettings } from "./settings.ts";
import {
  resolveExtractionModel,
  extractAnswer,
  resolveBudgetPolicy,
  ExtractionModelError,
} from "./extraction.ts";
import type { ExtractionResult } from "./extraction.ts";

// ─── Dual-result helper ──────────────────────────────────────────────────────

function textResult(
  text: string,
  details: WebFetchDetails,
  usage?: Usage,
): AgentToolResult<WebFetchDetails> {
  return { content: [{ type: "text" as const, text }], details, usage };
}

// ─── Parameter schema ────────────────────────────────────────────────────────

const parameters = Type.Object({
  url: Type.String({
    description: "The URL to fetch and extract content from",
  }),
  prompt: Type.String({
    description: "The extraction prompt: what the model should find or answer from the source",
  }),
});

// ─── Session identity ────────────────────────────────────────────────────────

function resolveSessionId(ctx: ExtensionContext): string {
  const sid = ctx.sessionManager?.getSessionId?.();
  return typeof sid === "string" ? sid : "";
}

function resolveModelRegistry(ctx: ExtensionContext) {
  const registry = ctx.modelRegistry;
  if (!registry) {
    throw new Error("Pi model registry is not available in the extension context.");
  }
  return registry;
}

// ─── Converted source (per content type) ─────────────────────────────────────

/** Converted source per content type. */
interface ConvertedSource {
  kind: ArtifactKind;
  /** Converted source text — becomes the Readable artifact's content.
   *  For library HTML conversion the artifact is written directly to disk and
   *  this field may be empty; use `artifactPath` and `sourceLength`.
   */
  text: string;
  title?: string;
  warning?: string;
  pageCount?: number;
  truncated?: boolean;
  source: WebFetchDetails["source"];
  contentType: string;
  /** Absolute path when the conversion wrote the artifact directly. */
  artifactPath?: string;
  /** Pre-computed source length when the text is not loaded in memory. */
  sourceLength?: number;
}

async function convertHtmlPage(
  downloadPath: string,
  artifactPath: string,
  urlStr: string,
  signal?: AbortSignal,
): Promise<ConvertedSource> {
  const { title, textChars, outputChars, extractionWarning } = await convertHtmlFileToMarkdown(
    downloadPath,
    artifactPath,
    { url: urlStr, signal },
  );
  if (textChars === 0) {
    throw new WebFetchError(
      urlStr,
      "Failed to extract readable content — the page may be JavaScript-rendered or empty",
    );
  }
  return {
    kind: "markdown",
    text: "", // artifact is on disk; not loaded into memory
    title,
    warning: extractionWarning,
    source: "html",
    contentType: "text/html",
    artifactPath,
    sourceLength: outputChars,
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

function artifactExtension(contentType: string, url: string): string {
  if (
    isPdfContentType(contentType, url) ||
    isHtmlContentType(contentType) ||
    contentType === "text/markdown" ||
    contentType === ""
  ) {
    return "md";
  }
  return "txt";
}

function validatePrompt(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("web_fetch requires a non-empty `prompt` parameter.");
  }
  return raw.trim();
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
      "Fetch a URL and return a prompt-directed answer based on the page content, " +
      "plus a Readable artifact of the converted source. Requires both a `url` and an " +
      "`prompt`. The URL is fetched directly with a browser-like user agent, enforced " +
      "30-second timeout, and response-size cap (512 KiB; 10 MiB for PDFs). HTML is converted " +
      "to whole-page Markdown: scripts and styles are removed, while tables, nested lists, " +
      "code blocks with language, navigation, reference links, and content outside an " +
      "article/main element are preserved in source order; relative links resolve against " +
      "the final URL after redirects. An explicitly configured Extraction model answers the " +
      "prompt using the converted source; only a bounded leading portion of large sources is " +
      "sent to the model. The artifact contains the full converted source (within limits) and " +
      "lives only for the creating session. A path from an old transcript is stale — refetch " +
      "the URL to regenerate it. Unsupported binary media types, unusable extraction, " +
      "exceeded limits, and missing extraction-model configuration produce clear errors.",
    promptSnippet: "Fetch a URL and answer a specific question about its content",
    promptGuidelines: [
      "Use web_fetch to retrieve a web page and get an answer to a specific question about it.",
      "Both `url` and `prompt` are required. Missing or empty prompts are rejected; there is no implicit summary.",
      "The result includes the AI extraction answer and an absolute path to a Readable artifact of the converted source, valid only for the current session.",
      "HTML is converted to whole-page Markdown: tables keep their columns, nested lists keep " +
        "their structure, code blocks keep whitespace and language, and navigation or reference " +
        "sections outside article/main elements remain in source order. Scripts and styles are " +
        "excluded. Exotic structures (colspan/rowspan spreads, definition lists, form controls) " +
        "are simplified rather than perfectly reproduced.",
      "Large sources may be truncated for the model input; the artifact remains complete unless the source itself was truncated or the PDF page limit was reached. Refetch the URL after leaving a session instead of reusing an old artifact path.",
      "PDFs are extracted up to 10MB and 50 pages; longer PDFs include a truncation notice and a partial artifact.",
      "Combine with web_search to first discover relevant URLs, then fetch the most promising ones.",
      "For documentation-heavy topics, check for /llms.txt on the host before fetching individual pages.",
      "Fetching is direct only: JavaScript-only or blocked pages are not sent to any alternate service.",
      "Configure the Extraction model in webFetch.extractionModel.provider and webFetch.extractionModel.model; project settings override global settings.",
    ],
    parameters,
    renderCall: renderWebFetchCall,
    renderResult: renderWebFetchResult,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const rawUrl = params.url as string;
      const rawPrompt = params.prompt as string;
      const url = validateUrl(rawUrl);
      const prompt = validatePrompt(rawPrompt);
      const urlStr = url.toString();

      const settings = knobs.extractionModelSettings ?? readWebFetchSettings().extractionModel;
      const registry = resolveModelRegistry(ctx);
      const resolvedModel = resolveExtractionModel(registry, settings);
      const budgetPolicy = resolveBudgetPolicy(knobs.extractionBudgetPolicy);

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

        let conv: ConvertedSource;
        const artifactPath = join(
          run.dir,
          `${call.baseName}-artifact.${artifactExtension(contentType, urlStr)}`,
        );
        call.artifactPath = artifactPath;

        if (isPdfContentType(contentType, urlStr)) {
          const body = await readFile(downloadPath, "utf8");
          conv = convertPdf(
            body,
            urlStr,
            callKnobs.extractPdfFn,
            callKnobs.pdfPageLimit ?? DEFAULT_PDF_PAGE_LIMIT,
          );
          await writeFile(artifactPath, conv.text);
        } else if (isHtmlContentType(contentType) || contentType === "") {
          // Relative links resolve against the final URL after redirects.
          const baseUrl = response.url || urlStr;
          conv = await convertHtmlPage(downloadPath, artifactPath, baseUrl, call.combinedSignal);
        } else if (isTextContentType(contentType)) {
          const body = await readFile(downloadPath, "utf8");
          conv = convertText(body, contentType);
          await writeFile(artifactPath, conv.text);
        } else {
          throw new WebFetchError(
            urlStr,
            `Unsupported content type "${contentType}" — the tool can only fetch HTML, plain text, and PDFs`,
          );
        }

        // 3. Finalize the Readable artifact, then release the raw download.
        await store.settleArtifact(call, conv.kind, !conv.truncated);
        call.assertActive();
        await store.releaseDownload(call);

        // 4. AI extraction: ask the configured model to answer the prompt using
        //    a bounded leading portion of the artifact.
        let extraction: ExtractionResult;
        try {
          extraction = await extractAnswer(
            registry,
            resolvedModel,
            {
              url: urlStr,
              title: conv.title ?? "",
              prompt,
              artifactPath,
              artifactComplete: !conv.truncated,
            },
            budgetPolicy,
            call.combinedSignal,
          );
        } catch (err) {
          if (err instanceof ExtractionModelError) {
            throw err;
          }
          // Wrap unexpected extraction failures with the artifact reference.
          throw new ExtractionModelError(
            `AI extraction failed: ${(err as Error).message}`,
            urlStr,
            artifactPath,
            !conv.truncated,
            err instanceof ExtractionModelError ? err.usage : undefined,
            err,
          );
        }
        call.assertActive();

        // 5. Compose the dual result: plain-text content + structured details.
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
        if (extraction.modelInputTruncated) {
          lines.push(
            `Warning: model input was truncated — only the first ${extraction.inputChars} characters of the source were sent to the extraction model`,
          );
        }
        if (conv.warning) lines.push(`Warning: ${conv.warning}`);
        lines.push("Answer:");

        const content = `${lines.join("\n")}\n\n${extraction.answer}`;
        const details: WebFetchDetails = {
          url: urlStr,
          title: conv.title ?? "",
          contentType: conv.contentType,
          source: conv.source,
          extractionWarning: conv.warning,
          pageCount: conv.pageCount,
          truncated: conv.truncated,
          artifactPath,
          artifactComplete: !conv.truncated,
          answer: extraction.answer,
          answerLength: extraction.answer.length,
          sourceLength: conv.sourceLength ?? conv.text.length,
          modelInputTruncated: extraction.modelInputTruncated,
          modelProvider: extraction.modelProvider,
          modelId: extraction.modelId,
        };
        return textResult(content, details, extraction.usage);
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