/**
 * Session todo state reconstruction tests — Vitest.
 *
 * Exercises the extension registration seam: the handlers the extension
 * subscribes to, plus the tool results those handlers make observable. Pi
 * rebuilds the agent's message history on session reload and on `/tree`
 * navigation, but only reload fires `session_start`; navigation fires
 * `session_tree` (see Pi docs `extensions.md` and `agent-session`'s branch
 * switch). Session todo state must therefore follow the active branch in both
 * cases.
 */

import { describe, it, expect } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import todoExtension, { type Item } from "../index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface FakeApi {
  tools: ToolDefinition[];
  handlers: Map<string, Handler>;
}

function makeFakeApi(): FakeApi {
  const api: FakeApi = { tools: [], handlers: new Map() };
  const fake = {
    registerTool: (tool: ToolDefinition) => api.tools.push(tool),
    on: (event: string, handler: Handler) => api.handlers.set(event, handler),
  } as unknown as ExtensionAPI;
  todoExtension(fake);
  return api;
}

/** One `message` session entry holding a `todo_write` tool result. */
function writeEntry(items: Item[]) {
  return {
    type: "message",
    id: `entry-${items.map((i) => i.content).join("-")}`,
    parentId: null,
    timestamp: 0,
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "todo_write",
      content: [{ type: "text", text: "ok" }],
      details: { items },
      isError: false,
      timestamp: 0,
    },
  };
}

/** A `session_start`/`session_tree` ctx whose branch is swappable. */
function makeCtx(branch: readonly unknown[]) {
  return { sessionManager: { getBranch: () => branch } } as unknown as Parameters<Handler>[1];
}

async function emit(api: FakeApi, event: string, payload: unknown, ctx: unknown) {
  const handler = api.handlers.get(event);
  expect(handler, `extension must subscribe to ${event}`).toBeDefined();
  await handler!(payload, ctx);
}

function readTool(api: FakeApi): ToolDefinition {
  const read = api.tools.find((t) => t.name === "todo_read");
  expect(read).toBeDefined();
  return read!;
}

async function readList(api: FakeApi): Promise<Item[]> {
  const result = await readTool(api).execute("tc");
  return (result.details as { items: Item[] }).items;
}

const branchA: Item[] = [
  { content: "Branch A step", status: "in_progress" },
  { content: "Branch A next", status: "pending" },
];
const branchB: Item[] = [
  { content: "Branch B setup", status: "completed" },
  { content: "Branch B step", status: "in_progress" },
];

describe("session todo state — reload", () => {
  it("reconstructs the latest todo_write on the current branch at session_start", async () => {
    const api = makeFakeApi();
    const branch = [
      writeEntry([{ content: "Stale earlier list", status: "pending" }]),
      writeEntry(branchA),
    ];

    await emit(api, "session_start", { type: "session_start", reason: "reload" }, makeCtx(branch));

    expect(await readList(api)).toEqual(branchA);
  });

  it("reconstructs from the branch Pi reloads, not from a previous in-memory list", async () => {
    const api = makeFakeApi();

    await emit(
      api,
      "session_start",
      { type: "session_start", reason: "startup" },
      makeCtx([writeEntry(branchA)]),
    );
    await emit(
      api,
      "session_start",
      { type: "session_start", reason: "resume", previousSessionFile: "/prev.jsonl" },
      makeCtx([writeEntry(branchB)]),
    );

    expect(await readList(api)).toEqual(branchB);
  });
});

describe("session todo state — branch navigation", () => {
  it("reloads the sibling branch's list after session_tree navigation", async () => {
    const api = makeFakeApi();
    let branch: readonly unknown[] = [writeEntry(branchA)];

    await emit(api, "session_start", { type: "session_start", reason: "startup" }, makeCtx(branch));
    expect(await readList(api)).toEqual(branchA);

    branch = [writeEntry(branchB)];
    await emit(
      api,
      "session_tree",
      { type: "session_tree", newLeafId: "b", oldLeafId: "a" },
      makeCtx(branch),
    );

    expect(await readList(api)).toEqual(branchB);
  });

  it("clears the list when navigating to a branch with no todo_write", async () => {
    const api = makeFakeApi();
    let branch: readonly unknown[] = [writeEntry(branchA)];

    await emit(api, "session_start", { type: "session_start", reason: "startup" }, makeCtx(branch));

    branch = [];
    await emit(
      api,
      "session_tree",
      { type: "session_tree", newLeafId: null, oldLeafId: "a" },
      makeCtx(branch),
    );

    expect(await readList(api)).toEqual([]);
    const text = (await readTool(api).execute("tc")).content[0] as { text: string };
    expect(text.text).toContain("(empty)");
  });

  it("reverts to the earlier list when navigating back before the latest write", async () => {
    const api = makeFakeApi();
    const earlier = [writeEntry(branchA)];
    const later = [writeEntry(branchA), writeEntry(branchB)];
    let branch: readonly unknown[] = later;

    await emit(api, "session_start", { type: "session_start", reason: "startup" }, makeCtx(branch));
    expect(await readList(api)).toEqual(branchB);

    branch = earlier;
    await emit(
      api,
      "session_tree",
      { type: "session_tree", newLeafId: "a", oldLeafId: "b" },
      makeCtx(branch),
    );

    expect(await readList(api)).toEqual(branchA);
  });
});