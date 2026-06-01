import type { AgentTypeConfig } from "./types.ts";

const BUILTIN_TYPES = {
  "general-purpose": {
    name: "general-purpose",
    displayName: "General Purpose",
    isReadOnly: false,
    promptMode: "append",
    source: "builtin",
  },
  explore: {
    name: "explore",
    displayName: "Explore",
    isReadOnly: true,
    promptMode: "replace",
    source: "builtin",
  },
  plan: {
    name: "plan",
    displayName: "Plan",
    isReadOnly: true,
    promptMode: "replace",
    source: "builtin",
  },
} as const satisfies Record<string, AgentTypeConfig>;

const customTypes = new Map<string, AgentTypeConfig>();

export function setCustomTypeConfigs(configs: AgentTypeConfig[]): void {
  customTypes.clear();
  for (const config of configs) {
    customTypes.set(config.name.toLowerCase(), config);
  }
}

export function resolveAgentType(type: string): { config: AgentTypeConfig; fallback: boolean; resolvedType: string } {
  const normalized = type.toLowerCase().trim();
  const entry = BUILTIN_TYPES[normalized as keyof typeof BUILTIN_TYPES];
  if (entry) {
    return { config: entry, fallback: false, resolvedType: entry.name };
  }

  const custom = customTypes.get(normalized);
  if (custom) {
    return { config: custom, fallback: false, resolvedType: custom.name };
  }

  return { config: BUILTIN_TYPES["general-purpose"], fallback: true, resolvedType: "general-purpose" };
}

export function getBuiltinTypeNames(): string[] {
  return Object.keys(BUILTIN_TYPES);
}

export function getAllTypeNames(): string[] {
  const names = [...Object.keys(BUILTIN_TYPES), ...customTypes.keys()];
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

export function getTypeConfig(name: string): AgentTypeConfig | undefined {
  const normalized = name.toLowerCase();
  return BUILTIN_TYPES[normalized as keyof typeof BUILTIN_TYPES] ?? customTypes.get(normalized);
}
