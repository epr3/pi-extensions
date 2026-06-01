import fs from "node:fs/promises";
import path from "node:path";
import type { SubagentSettings } from "./types.ts";

export const DEFAULT_SETTINGS: SubagentSettings = {
  maxConcurrency: 4,
  maxQueueSize: 16,
  recordTtlMs: 600_000,
  defaultBackground: false,
  allowCustomSubagents: false,
  allowNestedSubagents: false,
  maxSubagentDepth: 1,
  allowOutsideCwdDefault: false,
  saveTranscriptsDefault: false,
};

export interface SettingsLoadResult {
  settings: SubagentSettings;
  errors: string[];
  sourcePath: string;
}

function asInt(value: unknown, key: string, min: number, errors: string[]): number | undefined {
  if (!Number.isInteger(value)) {
    errors.push(`Invalid ${key}: expected integer, got ${String(value)}`);
    return undefined;
  }
  if ((value as number) < min) {
    errors.push(`Invalid ${key}: expected >= ${min}, got ${String(value)}`);
    return undefined;
  }
  return value as number;
}

function asBool(value: unknown, key: string, errors: string[]): boolean | undefined {
  if (typeof value !== "boolean") {
    errors.push(`Invalid ${key}: expected boolean, got ${String(value)}`);
    return undefined;
  }
  return value;
}

export async function loadSettings(cwd: string): Promise<SettingsLoadResult> {
  const sourcePath = path.join(cwd, ".pi", "subagents.json");
  const errors: string[] = [];
  const settings: SubagentSettings = { ...DEFAULT_SETTINGS };

  let raw: unknown;
  try {
    const text = await fs.readFile(sourcePath, "utf-8");
    raw = JSON.parse(text);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { settings, errors, sourcePath };
    }
    errors.push(`Failed to read ${sourcePath}: ${String(err?.message ?? err)}`);
    return { settings, errors, sourcePath };
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push(`Invalid ${sourcePath}: expected JSON object`);
    return { settings, errors, sourcePath };
  }

  const obj = raw as Record<string, unknown>;

  const maxConcurrency = asInt(obj.maxConcurrency, "maxConcurrency", 1, errors);
  if (maxConcurrency !== undefined) settings.maxConcurrency = maxConcurrency;

  const maxQueueSize = asInt(obj.maxQueueSize, "maxQueueSize", 0, errors);
  if (maxQueueSize !== undefined) settings.maxQueueSize = maxQueueSize;

  const recordTtlMs = asInt(obj.recordTtlMs, "recordTtlMs", 1_000, errors);
  if (recordTtlMs !== undefined) settings.recordTtlMs = recordTtlMs;

  const defaultBackground = asBool(obj.defaultBackground, "defaultBackground", errors);
  if (defaultBackground !== undefined) settings.defaultBackground = defaultBackground;

  const allowCustomSubagents = asBool(obj.allowCustomSubagents, "allowCustomSubagents", errors);
  if (allowCustomSubagents !== undefined) settings.allowCustomSubagents = allowCustomSubagents;

  const allowNestedSubagents = asBool(obj.allowNestedSubagents, "allowNestedSubagents", errors);
  if (allowNestedSubagents !== undefined) settings.allowNestedSubagents = allowNestedSubagents;

  const maxSubagentDepth = asInt(obj.maxSubagentDepth, "maxSubagentDepth", 1, errors);
  if (maxSubagentDepth !== undefined) settings.maxSubagentDepth = maxSubagentDepth;

  const allowOutsideCwdDefault = asBool(obj.allowOutsideCwdDefault, "allowOutsideCwdDefault", errors);
  if (allowOutsideCwdDefault !== undefined) settings.allowOutsideCwdDefault = allowOutsideCwdDefault;

  const saveTranscriptsDefault = asBool(obj.saveTranscriptsDefault, "saveTranscriptsDefault", errors);
  if (saveTranscriptsDefault !== undefined) settings.saveTranscriptsDefault = saveTranscriptsDefault;

  return { settings, errors, sourcePath };
}
