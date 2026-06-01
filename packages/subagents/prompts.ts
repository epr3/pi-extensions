import type { AgentTypeConfig } from "./types.ts";

function buildEnvBlock(cwd: string): string {
  const lines = [`- Working directory: ${cwd}`, `- Platform: ${process.platform}`];
  return lines.join("\n");
}

function buildSubagentBridge(taskDescription: string): string {
  return [
    "--- Subagent Task ---",
    taskDescription,
    "",
    "Guidelines:",
    "- Use the appropriate tools for your task",
    "- Be concise and direct",
    "- Do not use emojis",
    "- Report absolute paths when referencing files",
    "- Focus on the specific task, do not add extraneous work",
  ].join("\n");
}

function buildReadOnlyRules(allowOutsideCwd: boolean): string {
  const rules = [
    "You are a read-only agent. You MUST NOT modify any files.",
    "Use dedicated read/search tools (read, grep, find, ls).",
    "Report absolute paths in your findings.",
    "Return concise task-relevant results, not full transcripts.",
  ];
  if (!allowOutsideCwd) {
    rules.push("Prefer reading files under the working directory. Do not read files outside the working directory.");
  }
  return rules.join("\n");
}

export function buildAppendPrompt(
  parentSystemPrompt: string,
  taskDescription: string,
  bridge: string,
): string {
  return [parentSystemPrompt, "", bridge].join("\n");
}

export function buildReplacePrompt(
  config: AgentTypeConfig,
  taskDescription: string,
  cwd: string,
  allowOutsideCwd: boolean,
  parentContext?: string,
): string {
  if (config.promptBody) {
    const parts: string[] = [config.promptBody, "", "Task:", taskDescription];
    if (parentContext) {
      parts.push("", "Parent session context:", parentContext);
    }
    return parts.join("\n");
  }

  const parts: string[] = [
    `You are a ${config.displayName} agent for the Pi coding assistant.`,
    "",
    "Environment:",
    buildEnvBlock(cwd),
    "",
  ];

  if (config.isReadOnly) {
    parts.push(buildReadOnlyRules(allowOutsideCwd));
    parts.push("");
  }

  if (parentContext) {
    parts.push("Parent session context:");
    parts.push(parentContext);
    parts.push("");
  }

  parts.push("Your task:");
  parts.push(taskDescription);
  parts.push("");
  parts.push("Respond with analysis, plans, or findings based on your task.");
  parts.push("Be concise. Use absolute paths. Do not use emojis.");

  return parts.join("\n");
}

export function buildPrompt(
  config: AgentTypeConfig,
  taskDescription: string,
  options: {
    parentSystemPrompt?: string;
    parentContext?: string;
    cwd: string;
    allowOutsideCwd: boolean;
    inheritContext: boolean;
  },
): string {
  if (config.promptMode === "append") {
    const bridge = buildSubagentBridge(taskDescription);
    const parent = options.inheritContext ? (options.parentSystemPrompt ?? "") : "";
    return buildAppendPrompt(parent, taskDescription, bridge);
  }

  const context = options.inheritContext ? options.parentContext : undefined;
  return buildReplacePrompt(config, taskDescription, options.cwd, options.allowOutsideCwd, context);
}
