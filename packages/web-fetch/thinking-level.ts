// ─── Extraction thinking level: vocabulary, resolution, adaptation ──────────

import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";

/** Pi's settings-level thinking vocabulary, including explicit `off`. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const EXTRACTION_THINKING_SETTING = "webFetch.extractionModel.thinkingLevel";

/** True when `value` is a valid Pi thinking level (exact match, no trimming). */
export function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Warning about a configured Extraction thinking preference that could not be
 * used as written. Belongs in tool-result `details` and UI notifications —
 * never in extraction answer prose.
 */
export interface ExtractionThinkingWarning {
  /** Pi settings path that holds the problematic value. */
  setting: string;
  type: "malformed" | "clamped";
  /** Raw configured value (or requested level) for diagnostics. */
  reference: string;
  requested?: string;
  effective?: string;
}

export interface ExtractionThinkingRequest {
  /** Explicit request, or absent when omitted or malformed (behaves as absent). */
  requested?: ModelThinkingLevel;
  warnings: ExtractionThinkingWarning[];
}

/**
 * Validate a raw `thinkingLevel` setting.
 *
 * Omission returns no request and no warning. A malformed value warns and
 * behaves as absent, so the existing raw completion path is preserved.
 */
export function resolveExtractionThinking(raw: unknown): ExtractionThinkingRequest {
  if (raw === undefined) return { warnings: [] };
  if (isThinkingLevel(raw)) return { requested: raw, warnings: [] };
  return {
    warnings: [
      {
        setting: EXTRACTION_THINKING_SETTING,
        type: "malformed",
        reference: JSON.stringify(raw),
      },
    ],
  };
}

export interface ExtractionThinkingPlan {
  /**
   * Effective level to send through Pi's provider-neutral reasoning interface.
   * Present only for an explicit preference; `"off"` means an explicit
   * preference (or a clamped unsupported one) with no usable reasoning.
   */
  effective?: ModelThinkingLevel;
  warnings: ExtractionThinkingWarning[];
}

/**
 * Adapt an explicit requested level to the selected model's capabilities
 * through Pi's `clampThinkingLevel`. A valid but unsupported level — including
 * every level on a non-reasoning model — clamps and reports requested vs
 * effective. Model selection is never changed to honor a preference.
 */
export function planExtractionThinking(
  model: Model<Api>,
  request: ExtractionThinkingRequest,
): ExtractionThinkingPlan {
  const warnings = [...request.warnings];
  if (request.requested === undefined) return { warnings };

  const effective = clampThinkingLevel(model, request.requested);
  if (effective !== request.requested) {
    warnings.push({
      setting: EXTRACTION_THINKING_SETTING,
      type: "clamped",
      reference: request.requested,
      requested: request.requested,
      effective,
    });
  }
  return { effective, warnings };
}

/** Shared human-readable description of a thinking warning's cause. */
export function thinkingWarningSummary(w: ExtractionThinkingWarning): string {
  return w.type === "malformed"
    ? "is malformed"
    : `requested "${w.requested}"; effective "${w.effective}"`;
}