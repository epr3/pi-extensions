import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir } from "node:fs/promises";

let importNonce = 0;
async function loadExtension() {
  importNonce += 1;
  const mod = await import(`../index.ts?test=${importNonce}`);
  return mod.default as (api: any) => void;
}

interface HarnessOptions {
  hasUI?: boolean;
  cwd?: string;
  systemPrompt?: string;
  contextUsage?: { tokens: number; contextWindow: number } | null;
  commands?: Array<{ name: string; source: string; path?: string }>;
  activeTools?: string[];
  allTools?: Array<{ name: string; description?: string }>;
  sessionEntries?: any[];
  sessionId?: string;
}

function createHarness(options: HarnessOptions = {}) {
  const commandHandlers = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const eventHandlers = new Map<string, (event: any, ctx: any) => void>();
  const sentMessages: Array<{ message: any; opts: any }> = [];
  const appendEntries: Array<{ type: string; data: any }> = [];
  let customCalls = 0;
  let sessionId = options.sessionId ?? "session-1";

  const api = {
    registerCommand(name: string, opts: { handler: (args: string, ctx: any) => Promise<void> }) {
      commandHandlers.set(name, opts.handler);
    },
    on(eventName: string, handler: (event: any, ctx: any) => void) {
      eventHandlers.set(eventName, handler);
    },
    getCommands() {
      return options.commands ?? [];
    },
    getActiveTools() {
      return options.activeTools ?? [];
    },
    getAllTools() {
      return options.allTools ?? [];
    },
    sendMessage(message: any, opts: any) {
      sentMessages.push({ message, opts });
    },
    appendEntry(type: string, data: any) {
      appendEntries.push({ type, data });
    },
  } as any;

  const ctx = {
    hasUI: options.hasUI ?? false,
    cwd: options.cwd ?? process.cwd(),
    getSystemPrompt: () => options.systemPrompt ?? "system prompt",
    getContextUsage: () => options.contextUsage,
    sessionManager: {
      getEntries: () => options.sessionEntries ?? [],
      getSessionId: () => sessionId,
    },
    ui: {
      async custom(cb: (tui: any, theme: any, kb: any, done: () => void) => any) {
        customCalls += 1;
        return cb(
          {},
          {
            fg: (_c: string, s: string) => s,
            bold: (s: string) => s,
          },
          null,
          () => {},
        );
      },
    },
  } as any;

  return {
    api,
    ctx,
    commandHandlers,
    eventHandlers,
    sentMessages,
    appendEntries,
    get customCalls() {
      return customCalls;
    },
    setSessionId(next: string) {
      sessionId = next;
    },
  };
}

async function withTempEnv(
  testFn: (dirs: { root: string; cwd: string; agentDir: string }) => Promise<void>,
) {
  const prev = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(path.join(os.tmpdir(), "context-ext-test-"));
  const cwd = path.join(root, "workspace", "project");
  const agentDir = path.join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await testFn({ root, cwd, agentDir });
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  }
}

test("smoke – module loads and default export is a function", async () => {
  const extension = await loadExtension();
  assert.equal(typeof extension, "function");
});

test("registers /context command and tool_result handler", async () => {
  const extension = await loadExtension();
  const h = createHarness();

  extension(h.api);

  assert.equal(typeof h.commandHandlers.get("context"), "function");
  assert.equal(typeof h.eventHandlers.get("tool_result"), "function");
});

test("tool_result tracks loaded skills only for successful read events and dedupes per session", async () => {
  const extension = await loadExtension();
  const h = createHarness({
    cwd: "/repo",
    commands: [
      { name: "skill:answer", source: "skill", path: "/skills/answer/SKILL.md" },
      { name: "context", source: "extension", path: "/ext/context/index.ts" },
    ],
  });

  extension(h.api);
  const onToolResult = h.eventHandlers.get("tool_result")!;

  onToolResult(
    { toolName: "bash", isError: false, input: { path: "/skills/answer/SKILL.md" } },
    h.ctx,
  );
  onToolResult(
    { toolName: "read", isError: true, input: { path: "/skills/answer/SKILL.md" } },
    h.ctx,
  );
  onToolResult({ toolName: "read", isError: false, input: {} }, h.ctx);
  assert.equal(h.appendEntries.length, 0);

  onToolResult(
    { toolName: "read", isError: false, input: { path: "/skills/answer/notes.md" } },
    h.ctx,
  );
  assert.equal(h.appendEntries.length, 1);
  assert.deepEqual(h.appendEntries[0], {
    type: "context:skill_loaded",
    data: { name: "answer", path: "/skills/answer/notes.md" },
  });

  onToolResult(
    { toolName: "read", isError: false, input: { path: "/skills/answer/another.md" } },
    h.ctx,
  );
  assert.equal(h.appendEntries.length, 1);

  h.setSessionId("session-2");
  onToolResult(
    { toolName: "read", isError: false, input: { path: "/skills/answer/new-session.md" } },
    h.ctx,
  );
  assert.equal(h.appendEntries.length, 2);
  assert.deepEqual(h.appendEntries[1], {
    type: "context:skill_loaded",
    data: { name: "answer", path: "/skills/answer/new-session.md" },
  });
});

test("/context without UI sends plain text context summary", { concurrency: false }, async () => {
  await withTempEnv(async ({ cwd }) => {
    const extension = await loadExtension();
    const h = createHarness({
      hasUI: false,
      cwd,
      commands: [
        { name: "context", source: "extension", path: "/ext/context.ts" },
        { name: "answer", source: "extension", path: "/ext/answer.ts" },
        { name: "skill:answer", source: "skill", path: "/skills/answer/SKILL.md" },
      ],
      contextUsage: { tokens: 120, contextWindow: 1000 },
      systemPrompt: "system prompt text",
      activeTools: ["read", "bash"],
      allTools: [
        { name: "read", description: "Read a file" },
        { name: "bash", description: "Run shell commands" },
      ],
      sessionEntries: [
        {
          type: "message",
          message: {
            role: "assistant",
            usage: { input: 10, output: 20, cacheRead: 3, cacheWrite: 2, cost: "0.25" },
          },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            usage: { input: 5, output: 7, cacheRead: 1, cacheWrite: 0, cost: { total: 0.125 } },
          },
        },
      ],
    });
    extension(h.api);

    await h.commandHandlers.get("context")!("", h.ctx);

    assert.equal(h.sentMessages.length, 1);
    const payload = h.sentMessages[0].message;
    assert.equal(payload.customType, "context");
    assert.equal(payload.display, true);
    assert.match(payload.content, /^Context/m);
    assert.match(payload.content, /Window: ~\d+ \/ 1,000 \(\d+\.\d% used, ~\d+ left\)/);
    assert.match(payload.content, /Extensions \(2\): answer\.ts, context\.ts/);
    assert.match(payload.content, /Skills \(1\): answer/);
    assert.match(payload.content, /Session: 48 tokens · \$0\.375/);
    assert.deepEqual(h.sentMessages[0].opts, { triggerTurn: false });
  });
});

test(
  "/context with UI opens custom view and does not send fallback message",
  { concurrency: false },
  async () => {
    await withTempEnv(async ({ cwd }) => {
      const extension = await loadExtension();
      const h = createHarness({
        hasUI: true,
        cwd,
        commands: [{ name: "context", source: "extension", path: "/ext/context.ts" }],
        contextUsage: { tokens: 50, contextWindow: 500 },
        activeTools: [],
        allTools: [],
        sessionEntries: [],
      });
      extension(h.api);

      await h.commandHandlers.get("context")!("", h.ctx);

      assert.equal(h.customCalls, 1);
      assert.equal(h.sentMessages.length, 0);
    });
  },
);