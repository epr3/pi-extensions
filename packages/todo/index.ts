import type { AgentToolResult, ExtensionAPI, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

function textResult(text: string, details?: Record<string, unknown>): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: "text" as const, text }], details: details ?? {} };
}

/**
 * Todo extension. A persistent checklist so the agent can break an issue into
 * steps (or a plan into slices) and track progress. Pi omits the TodoWrite
 * facility Claude Code provides; this restores it.
 *
 * State lives in tool-result `details` (the documented branch-safe pattern) and
 * is reconstructed from the session branch on session_start, so it survives
 * turns, reloads, and tree navigation.
 */

export type Status = "pending" | "in_progress" | "completed";
export type Item = { content: string; status: Status };

const writeParams = Type.Object({
  todos: Type.Array(
    Type.Object({
      content: Type.String({ description: "What the step is" }),
      status: StringEnum(["pending", "in_progress", "completed"] as const),
    }),
    { description: "The full list (replaces the previous one)" },
  ),
});

const readParams = Type.Object({});

function summary(items: Item[]): string {
  const done = items.filter((t) => t.status === "completed").length;
  return `${done}/${items.length} done`;
}

function fmt(items: Item[]): string {
  const mark = { completed: "[x]", in_progress: "[~]", pending: "[ ]" } as const;
  return items.map((t) => `${mark[t.status]} ${t.content}`).join("\n") || "(empty)";
}

// ─── Tool presentation ──────────────────────────────────────────────────────

/**
 * Render the Todo tool call row.
 * todo_write shows item count and active/done summary;
 * todo_read shows "read-only".
 */
export function renderTodoCall(
  args: Record<string, unknown>,
  theme: Theme,
): Text {
  const isWrite = "todos" in args;
  const items = (isWrite ? (args.todos as Item[]) : []) ?? [];
  const done = items.filter((i) => i.status === "completed").length;
  const active = items.filter((i) => i.status === "in_progress").length;
  const part = isWrite
    ? `${items.length} item${items.length !== 1 ? "s" : ""}` +
      (done || active ? ` (${done ? `${done} done` : ""}${done && active ? ", " : ""}${active ? `${active} active` : ""})` : "")
    : "read-only";
  const text =
    theme.fg("toolTitle", theme.bold("Todo")) +
    theme.fg("muted", `  ${part}`);
  return new Text(text, 0, 0);
}

/**
 * Render the Todo tool result row.
 *
 * Collapsed: compact done/total summary with warning if multiple in_progress.
 * Expanded: full styled checklist with distinct pending/in_progress/completed
 * markers plus a warning line for invalid workflow state.
 *
 * Falls back to plain text content when structured details are absent.
 */
export function renderTodoResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  _ctx: unknown,
): Component {
  const items = (result.details as Record<string, unknown>)?.items as Item[] | undefined;
  if (!items || items.length === 0) {
    const text = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return new Text(theme.fg("toolOutput", text), 0, 0);
  }

  const done = items.filter((i) => i.status === "completed").length;
  const active = items.filter((i) => i.status === "in_progress").length;
  const total = items.length;

  if (!options.expanded) {
    // Collapsed: compact summary
    const summary = `${done}/${total} done`;
    const warning = active > 1 ? `, ${active} in_progress` : "";
    const color = active > 1 ? "warning" : done === total ? "success" : "accent";
    const prefix = active > 1 ? "⚠ " : done === total ? "✓ " : "";
    return new Text(theme.fg(color, `${prefix}${summary}${warning}`), 0, 0);
  }

  // Expanded: full styled checklist
  const lines = items.map((item) => {
    const marker = item.status === "completed" ? "✓" : item.status === "in_progress" ? "◐" : " ";
    const color =
      item.status === "completed" ? "success" : item.status === "in_progress" ? "accent" : "dim";
    return theme.fg(color, `${marker}  ${item.content}`);
  });

  if (active > 1) {
    lines.push(theme.fg("warning", `⚠ Warning: ${active} items in_progress`));
  }

  return new Text(lines.join("\n"), 0, 0);
}

export default function (pi: ExtensionAPI) {
  let items: Item[] = [];

  // Reconstruct from the latest todo_write result on the current branch.
  pi.on("session_start", async (_event, ctx) => {
    items = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolName === "todo_write"
      ) {
        items = (entry.message.details?.items as Item[]) ?? items;
      }
    }
  });

  pi.registerTool({
    name: "todo_write",
    label: "Write Todos",
    description:
      "Replace the todo list. Use to break an issue into steps or a plan into vertical slices, then " +
      "keep it current. Keep exactly one item in_progress at a time; mark items completed as you finish.",
    promptSnippet: "Track a checklist of steps/slices",
    promptGuidelines: [
      "Use todo_write to plan multi-step work (breaking an issue into steps or a plan into slices) and keep the list updated as you progress.",
    ],
    parameters: writeParams,
    renderCall: (args, theme) => renderTodoCall(args as Record<string, unknown>, theme),
    renderResult: renderTodoResult,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      items = (params.todos as Item[]).map((t) => ({ content: t.content, status: t.status }));
      const active = items.filter((t) => t.status === "in_progress").length;
      const text =
        `${summary(items)}\n${fmt(items)}` +
        (active > 1 ? `\n(warning: invalid workflow state — ${active} items in_progress)` : "");
      return textResult(text, { items: [...items] });
    },
  });

  pi.registerTool({
    name: "todo_read",
    label: "Read Todos",
    description: "Read the current todo list and a done/total summary.",
    parameters: readParams,
    renderCall: (args, theme) => renderTodoCall(args as Record<string, unknown>, theme),
    renderResult: renderTodoResult,
    async execute() {
      return textResult(`${summary(items)}\n${fmt(items)}`, { items: [...items] });
    },
  });
}