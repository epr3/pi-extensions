import fs from "node:fs/promises";
import path from "node:path";
import type { SubagentRun } from "./types.ts";

function safeTimestamp(ts: number): string {
  return new Date(ts).toISOString().replaceAll(":", "-");
}

export async function writeTranscript(cwd: string, run: SubagentRun, prompt: string): Promise<string> {
  const dir = path.join(cwd, ".pi", "subagents", "runs");
  await fs.mkdir(dir, { recursive: true });

  const filename = `${safeTimestamp(run.startedAt)}-${run.id}.md`;
  const fullPath = path.join(dir, filename);

  const lines: string[] = [
    `# Subagent Transcript ${run.id}`,
    "",
    "## Metadata",
    `- ID: ${run.id}`,
    `- Requested type: ${run.requestedType}`,
    `- Resolved type: ${run.type}`,
    `- Status: ${run.status}`,
    `- Model: ${run.model ?? "(default)"}`,
    `- Started: ${new Date(run.startedAt).toISOString()}`,
    `- Completed: ${run.completedAt ? new Date(run.completedAt).toISOString() : "(in-progress)"}`,
    `- Turn count: ${run.turnCount}`,
    `- Was limited: ${run.wasLimited}`,
  ];

  if (run.error) lines.push(`- Error: ${run.error}`);
  if (run.stopReason) lines.push(`- Stop reason: ${run.stopReason}`);

  lines.push("", "## Prompt", "", prompt, "", "## Result", "", run.result ?? "(no output)");

  if (run.partialOutput && run.partialOutput !== run.result) {
    lines.push("", "## Partial Output", "", run.partialOutput);
  }

  await fs.writeFile(fullPath, `${lines.join("\n")}\n`, "utf-8");
  return fullPath;
}
