import type { Model } from "@earendil-works/pi-ai";
import type { AgentType } from "./agents.ts";

/**
 * Pure model reference parser for exact `provider/model` strings.
 *
 * The reference format is `provider/model` where provider is the text before
 * the first slash and modelId is the remaining text after the slash. Missing
 * slash, empty provider, or empty modelId makes the reference invalid — the
 * caller treats an invalid reference as absent and falls back to the parent
 * model.
 *
 * This module has no Pi SDK dependency beyond the type-only Model import and
 * can be tested without stubs.
 */

export interface ParsedModelRef {
  provider: string;
  modelId: string;
}

/**
 * Parse an exact `provider/model` string.
 * Returns null when the string is not a valid reference (no slash, empty
 * provider, empty modelId). Leading/trailing whitespace is trimmed.
 */
export function parseModelRef(ref: string): ParsedModelRef | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) return null;
  return {
    provider: trimmed.slice(0, slash),
    modelId: trimmed.slice(slash + 1),
  };
}

/**
 * Resolve a configured default subagent model reference.
 *
 * Returns the resolved model when the reference is valid and found in the
 * registry; falls back to the parent model when the reference is absent,
 * invalid, or unresolvable.
 *
 * @param defaultModelRef - The `provider/model` string from settings, or
 *   undefined/empty when none is configured.
 * @param findModel - A lookup function (e.g. `modelRegistry.find`).
 * @param parentModel - The parent session's model, returned as fallback.
 */
export function resolveDefaultModel(
  defaultModelRef: string | undefined,
  findModel: (provider: string, modelId: string) => Model<any> | undefined,
  parentModel: Model<any> | undefined,
): Model<any> | undefined {
  if (!defaultModelRef) return parentModel;
  const parsed = parseModelRef(defaultModelRef);
  if (!parsed) return parentModel;
  return findModel(parsed.provider, parsed.modelId) ?? parentModel;
}

/**
 * Per-type model overrides keyed by AgentType. Undefined/absent means no
 * override — fall through to shared default.
 */
export type TypeModelOverrides = Record<AgentType, string | undefined>;

/**
 * Resolve the model for a subagent run, applying type-specific override
 * before the shared default before the parent model.
 *
 * Precedence:
 *   1. Type-specific override (parsed and found in registry)
 *   2. Shared default (parsed and found in registry)
 *   3. Parent model (fallback)
 *
 * Each level: unconfigured, invalid ref syntax, or unresolvable ref in
 * registry → fall through to next level.
 *
 * @param typeOverrides - Per-type model refs from settings.
 * @param type - The subagent type being launched.
 * @param sharedDefaultRef - The shared `subagents.defaultModel` ref.
 * @param findModel - A lookup function (e.g. `modelRegistry.find`).
 * @param parentModel - The parent session's model, final fallback.
 */
export function resolveTypeDefaultModel(
  typeOverrides: TypeModelOverrides,
  type: AgentType,
  sharedDefaultRef: string | undefined,
  findModel: (provider: string, modelId: string) => Model<any> | undefined,
  parentModel: Model<any> | undefined,
): Model<any> | undefined {
  const typeRef = typeOverrides[type];
  if (typeRef) {
    const parsed = parseModelRef(typeRef);
    if (parsed) {
      const found = findModel(parsed.provider, parsed.modelId);
      if (found) return found;
    }
  }
  return resolveDefaultModel(sharedDefaultRef, findModel, parentModel);
}

// ─── Warning types ────────────────────────────────────────────────────────

/**
 * Warning about a configured default subagent model reference that could not
 * be used — either because its syntax is invalid or because the provider/model
 * is not found in the model registry.
 */
export interface DefaultModelWarning {
  /** Which setting level holds the problematic reference. */
  scope: "shared" | AgentType;
  /** The raw configured value as written in settings. */
  reference: string;
  /** Why the reference could not be used. */
  type: "malformed" | "unresolvable";
}

/**
 * Check configured default model references for the current subagent type
 * and return warnings for any that are invalid or unresolvable.
 *
 * Only the current type's override and the shared default are checked —
 * other types' overrides are irrelevant for this launch.
 */
export function checkDefaultModelWarnings(
  typeRef: string | undefined,
  sharedRef: string | undefined,
  findModel: (provider: string, modelId: string) => Model<any> | undefined,
  type: AgentType,
): DefaultModelWarning[] {
  const warnings: DefaultModelWarning[] = [];

  if (typeRef) {
    const parsed = parseModelRef(typeRef);
    if (!parsed) {
      warnings.push({ scope: type, reference: typeRef, type: "malformed" });
    } else if (!findModel(parsed.provider, parsed.modelId)) {
      warnings.push({ scope: type, reference: typeRef, type: "unresolvable" });
    }
  }

  if (sharedRef) {
    const parsed = parseModelRef(sharedRef);
    if (!parsed) {
      warnings.push({ scope: "shared", reference: sharedRef, type: "malformed" });
    } else if (!findModel(parsed.provider, parsed.modelId)) {
      warnings.push({ scope: "shared", reference: sharedRef, type: "unresolvable" });
    }
  }

  return warnings;
}
