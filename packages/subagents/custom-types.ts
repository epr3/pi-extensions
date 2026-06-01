import fs from "node:fs/promises";
import path from "node:path";
import type { AgentTypeConfig } from "./types.ts";

const BUILTIN_NAMES = new Set(["plan", "explore", "general-purpose"]);

export interface CustomTypesLoadResult {
  configs: AgentTypeConfig[];
  errors: string[];
  discoveredFiles: string[];
}

function parseFrontmatter(raw: string): { attrs: Record<string, string>; body: string } | undefined {
  if (!raw.startsWith("---\n")) return undefined;
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) return undefined;

  const header = raw.slice(4, end).trim();
  const body = raw.slice(end + 5).trim();
  const attrs: Record<string, string> = {};

  for (const line of header.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) attrs[key] = value;
  }

  return { attrs, body };
}

function toDisplayName(name: string): string {
  return name
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

export async function loadCustomTypeConfigs(cwd: string): Promise<CustomTypesLoadResult> {
  const dir = path.join(cwd, ".pi", "agents");
  const errors: string[] = [];
  const discoveredFiles: string[] = [];
  const configs: AgentTypeConfig[] = [];

  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { configs, errors, discoveredFiles };
    }
    errors.push(`Failed to read ${dir}: ${String(err?.message ?? err)}`);
    return { configs, errors, discoveredFiles };
  }

  for (const file of entries) {
    if (!file.endsWith(".md")) continue;
    const abs = path.join(dir, file);
    discoveredFiles.push(abs);

    let text: string;
    try {
      text = await fs.readFile(abs, "utf-8");
    } catch (err: any) {
      errors.push(`Failed reading ${abs}: ${String(err?.message ?? err)}`);
      continue;
    }

    const parsed = parseFrontmatter(text);
    if (!parsed) {
      errors.push(`Invalid ${abs}: missing YAML frontmatter (---)`);
      continue;
    }

    const name = parsed.attrs.name?.trim();
    if (!name) {
      errors.push(`Invalid ${abs}: missing frontmatter field 'name'`);
      continue;
    }

    const normalizedName = name.toLowerCase();
    if (BUILTIN_NAMES.has(normalizedName)) {
      errors.push(`Invalid ${abs}: custom type '${name}' cannot override built-in type`);
      continue;
    }

    const toolsRaw = (parsed.attrs.tools ?? "read-only").trim().toLowerCase();
    if (toolsRaw !== "read-only" && toolsRaw !== "full") {
      errors.push(`Invalid ${abs}: tools must be 'read-only' or 'full', got '${toolsRaw}'`);
      continue;
    }

    const promptModeRaw = (parsed.attrs.prompt_mode ?? "replace").trim().toLowerCase();
    if (promptModeRaw !== "replace" && promptModeRaw !== "append") {
      errors.push(`Invalid ${abs}: prompt_mode must be 'replace' or 'append', got '${promptModeRaw}'`);
      continue;
    }

    if (!parsed.body) {
      errors.push(`Invalid ${abs}: prompt body is required`);
      continue;
    }

    configs.push({
      name: normalizedName,
      displayName: toDisplayName(name),
      isReadOnly: toolsRaw === "read-only",
      promptMode: promptModeRaw,
      model: parsed.attrs.model?.trim() || undefined,
      promptBody: parsed.body,
      source: "custom",
    });
  }

  return { configs, errors, discoveredFiles };
}
