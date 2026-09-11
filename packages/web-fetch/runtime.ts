// ─── Runtime knobs (test seam) ───────────────────────────────────────────────

import type { PdfExtractFn } from "./fetch.ts";

/**
 * Runtime implementations the tool uses. In production every value is
 * undefined and the real defaults apply (global `fetch`, built-in PDF
 * extractor, `os.tmpdir()` storage area). Tests override them for
 * deterministic execution through the registered tool.
 */
export interface RuntimeKnobs {
  fetchFn?: typeof globalThis.fetch;
  extractPdfFn?: PdfExtractFn;
  pdfPageLimit?: number;
  fetchTimeoutMs?: number;
  storageRoot?: string;
}

const knobs: RuntimeKnobs = {};

export function getRuntimeKnobs(): Readonly<RuntimeKnobs> {
  return knobs;
}

/** Test hook: override runtime implementations for deterministic tests. */
export function configureTestRuntime(overrides: Partial<RuntimeKnobs>): void {
  Object.assign(knobs, overrides);
}

/** Test hook: restore production defaults. */
export function resetTestRuntime(): void {
  for (const key of Object.keys(knobs) as (keyof RuntimeKnobs)[]) {
    delete knobs[key];
  }
}