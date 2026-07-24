import type {
  AgentToolResult,
  ExtensionAPI,
  Theme,
  ThemeColor,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

function textResult(
  text: string,
  details?: Record<string, unknown>,
): AgentToolResult<Record<string, unknown>> {
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

export type CurrentItemResult =
  | { currentItem: Item; currentIndex: number; activeCandidates?: undefined }
  | { currentItem: null; currentIndex: null; activeCandidates?: undefined }
  | {
      currentItem: null;
      currentIndex: null;
      activeCandidates: { content: string; status: Status; index: number }[];
    };

/**
 * Derive the current (in_progress) item from a todo list.
 *
 * - Exactly one in_progress → returns that item and its index.
 * - Zero in_progress → returns null for both currentItem and currentIndex.
 * - Multiple in_progress → returns null for both and lists active candidates.
 */
export function deriveCurrentItem(items: Item[]): CurrentItemResult {
  const active = items
    .map((item, i) => ({ content: item.content, status: item.status, index: i }))
    .filter((item) => item.status === "in_progress");

  if (active.length === 0) {
    return { currentItem: null, currentIndex: null };
  }
  if (active.length === 1) {
    return {
      currentItem: { content: active[0].content, status: active[0].status },
      currentIndex: active[0].index,
    };
  }
  return { currentItem: null, currentIndex: null, activeCandidates: active };
}

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

function fmtCurrentLine(current: CurrentItemResult): string {
  if (current.currentItem) {
    return `Current: ${current.currentItem.content}`;
  }
  if (current.activeCandidates) {
    return "Current: (multiple: see details)";
  }
  return "Current: none";
}

// ─── Tool presentation ──────────────────────────────────────────────────────

/**
 * Render the Todo tool call row.
 * todo_write shows item count and active/done summary;
 * todo_read shows "read-only".
 */
export function renderTodoCall(args: Record<string, unknown>, theme: Theme): Text {
  const isWrite = "todos" in args;
  const items = (isWrite ? (args.todos as Item[]) : []) ?? [];
  const done = items.filter((i) => i.status === "completed").length;
  const active = items.filter((i) => i.status === "in_progress").length;
  const part = isWrite
    ? `${items.length} item${items.length !== 1 ? "s" : ""}` +
      (done || active
        ? ` (${done ? `${done} done` : ""}${done && active ? ", " : ""}${active ? `${active} active` : ""})`
        : "")
    : "read-only";
  const text = theme.fg("toolTitle", theme.bold("Todo")) + theme.fg("muted", `  ${part}`);
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
    // Collapsed: compact summary with optional current-item line
    const summary = `${done}/${total} done`;
    let text: string;
    let color: ThemeColor;

    if (active > 1) {
      // Multiple in_progress — warning state, no current item
      text = `⚠ ${summary}, ${active} in_progress`;
      color = "warning";
    } else if (done === total) {
      // All done — success, no current item
      text = `✓ ${summary}`;
      color = "success";
    } else if (active === 1) {
      // Single in_progress — show current item from structured details
      const d = result.details as Record<string, unknown> | undefined;
      const currentItem = d?.currentItem as Item | null | undefined;
      text = currentItem ? `${summary} · Current: ${currentItem.content}` : summary;
      color = "accent";
    } else {
      // No in_progress items, not all done (mixed completed + pending)
      text = summary;
      color = "accent";
    }

    return new Text(theme.fg(color, text), 0, 0);
  }

  // Expanded: current-item line (from structured details) followed by full checklist
  const details = result.details as Record<string, unknown> | undefined;
  const currentItem = details?.currentItem as Item | null | undefined;
  const activeCandidates = details?.activeCandidates as
    | { content: string; status: string; index: number }[]
    | undefined;

  const lines: string[] = [];

  if (currentItem) {
    // Exactly one in_progress — show explicit current item
    lines.push(theme.fg("accent", `Current: ${currentItem.content}`));
  } else if (details && !activeCandidates) {
    // Details exist, no currentItem and no activeCandidates → zero in_progress
    lines.push(theme.fg("dim", "Current: none"));
  }
  // For multiple active (activeCandidates present), no "Current:" line is shown

  items.forEach((item) => {
    const marker = item.status === "completed" ? "✓" : item.status === "in_progress" ? "◐" : " ";
    const color =
      item.status === "completed" ? "success" : item.status === "in_progress" ? "accent" : "dim";
    lines.push(theme.fg(color, `${marker}  ${item.content}`));
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
      const current = deriveCurrentItem(items);
      const active = items.filter((t) => t.status === "in_progress").length;
      let txt = `${summary(items)}\n${fmtCurrentLine(current)}\n${fmt(items)}`;
      if (active > 1) {
        txt += `\n(warning: invalid workflow state — ${active} items in_progress)`;
      }
      return textResult(txt, { items: [...items], ...current });
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
      const current = deriveCurrentItem(items);
      const txt = `${summary(items)}\n${fmtCurrentLine(current)}\n${fmt(items)}`;
      return textResult(txt, { items: [...items], ...current });
    },
  });
}