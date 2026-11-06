import { describe, it, expect, vi, afterEach } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import path from "node:path";

const { readFileSyncMock } = vi.hoisted(() => ({ readFileSyncMock: vi.fn() }));
vi.mock("node:fs", () => ({ readFileSync: readFileSyncMock }));

const GLOBAL_SETTINGS = path.join(homedir(), ".pi", "agent", "settings.json");
function projectSettings(cwd: string): string {
  return path.join(cwd, ".pi", "settings.json");
}

/** Load the extension module against an in-memory settings filesystem. */
async function loadExtension(files: Record<string, string>, cwd = "/work/checkout-service") {
  readFileSyncMock.mockImplementation((file: string) => {
    if (file in files) return files[file];
    const error = Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), {
      code: "ENOENT",
    });
    throw error;
  });
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  vi.resetModules();
  return (await import("../index.ts")).default;
}

interface FakePi {
  handlers: Record<string, Function>;
  exec: ReturnType<typeof vi.fn>;
}

function makeFakePi(): { pi: ExtensionAPI; state: FakePi } {
  const state: FakePi = { handlers: {}, exec: vi.fn(async () => ({ code: 0, stdout: "main\n" })) };
  const pi = {
    on: (event: string, handler: Function) => {
      state.handlers[event] = handler;
    },
    exec: state.exec,
  } as unknown as ExtensionAPI;
  return { pi, state };
}

interface FakeCtx {
  ctx: any;
  notifyCalls: Array<{ message: string; type: string }>;
  statusCalls: Array<{ key: string; text: string | undefined }>;
}

function makeFakeCtx(overrides: Record<string, any> = {}): FakeCtx {
  const notifyCalls: Array<{ message: string; type: string }> = [];
  const statusCalls: Array<{ key: string; text: string | undefined }> = [];
  const ctx = {
    hasUI: true,
    cwd: "/work/checkout-service",
    model: { contextWindow: 400_000 },
    getContextUsage: () => ({ tokens: 50_000 }),
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      notify: (message: string, type: string) => notifyCalls.push({ message, type }),
      setStatus: (key: string, text: string | undefined) => statusCalls.push({ key, text }),
    },
    ...overrides,
  };
  return { ctx, notifyCalls, statusCalls };
}

async function sessionStart(extension: ReturnType<typeof loadExtension>) {
  const { pi, state } = makeFakePi();
  (await extension)(pi);
  const fake = makeFakeCtx();
  await state.handlers.session_start!({}, fake.ctx);
  return fake;
}

describe("statusline extension lifecycle", () => {
  it("wires startup, model selection, turn updates, branch refresh, shutdown, and non-UI rendering", async () => {
    const extension = await loadExtension({});
    const { pi, state } = makeFakePi();
    (await extension)(pi);
    expect(Object.keys(state.handlers).toSorted()).toEqual([
      "agent_end",
      "model_select",
      "session_shutdown",
      "session_start",
      "turn_end",
    ]);

    const fake = makeFakeCtx();
    await state.handlers.session_start!({}, fake.ctx);
    expect(state.exec).toHaveBeenCalledWith("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      timeout: 1500,
    });
    expect(lastStatus(fake.statusCalls)).toContain("⎇ main");
    fake.statusCalls.length = 0;

    fake.ctx.getContextUsage = () => ({ tokens: 200_000 });
    await state.handlers.model_select!({}, fake.ctx);
    expect(lastStatus(fake.statusCalls)).toContain("CAVEMAN");
    fake.statusCalls.length = 0;

    await state.handlers.turn_end!({}, fake.ctx);
    expect(fake.statusCalls).toHaveLength(1);
    fake.statusCalls.length = 0;

    state.exec.mockResolvedValueOnce({ code: 0, stdout: "feature/next\\n" });
    await state.handlers.agent_end!({}, fake.ctx);
    expect(lastStatus(fake.statusCalls)).toContain("feature/next");

    await state.handlers.session_shutdown!({}, fake.ctx);
    expect(fake.statusCalls.at(-1)).toEqual({ key: "dumb-zone", text: undefined });

    const nonUi = makeFakeCtx({ hasUI: false });
    await state.handlers.model_select!({}, nonUi.ctx);
    expect(nonUi.statusCalls).toEqual([]);
  });
});

function lastStatus(texts: FakeCtx["statusCalls"]): string | undefined {
  return texts[texts.length - 1]?.text;
}

function meterWidth(text: string | undefined): number {
  return (text ?? "").replace(/[^█░]/g, "").length;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("statusline extension configuration feedback", () => {
  it("stays silent and renders for a valid configuration", async () => {
    const extension = await loadExtension({
      [GLOBAL_SETTINGS]: JSON.stringify({ statusline: { meterWidth: 12 } }),
    });
    const { notifyCalls, statusCalls } = await sessionStart(extension);

    expect(notifyCalls).toEqual([]);
    expect(lastStatus(statusCalls)).toContain("SHARP");
    expect(meterWidth(lastStatus(statusCalls))).toBe(12);
  });

  it("reports every invalid setting with the value it used instead", async () => {
    const extension = await loadExtension({
      [GLOBAL_SETTINGS]: JSON.stringify({
        statusline: {
          effectiveLimit: "lots",
          meterWidth: 500,
          thresholds: { sharp: 0.9, fading: 0.5 },
        },
      }),
    });
    const { notifyCalls, statusCalls } = await sessionStart(extension);

    expect(notifyCalls).toHaveLength(3);
    for (const call of notifyCalls) {
      expect(call.type).toBe("warning");
      expect(call.message).toMatch(/^statusline: /);
      expect(call.message).toContain("— using");
    }
    expect(notifyCalls[0]!.message).toContain("effectiveLimit");
    expect(notifyCalls[1]!.message).toContain("thresholds");
    expect(notifyCalls[2]!.message).toContain("meterWidth");
    // Safely fallen back: clamped width, default ordering, 200k limit.
    expect(meterWidth(lastStatus(statusCalls))).toBe(40);
    expect(lastStatus(statusCalls)).toContain("SHARP");
  });

  it("keeps env precedence over settings for valid env values", async () => {
    vi.stubEnv("EFFECTIVE_LIMIT", "50k");
    const extension = await loadExtension({
      [GLOBAL_SETTINGS]: JSON.stringify({ statusline: { effectiveLimit: 300_000 } }),
    });
    const { notifyCalls, statusCalls } = await sessionStart(extension);

    expect(notifyCalls).toEqual([]);
    expect(lastStatus(statusCalls)).toContain("CAVEMAN"); // 50k of a 50k env limit
  });

  it("reports an invalid env value rather than silently ignoring it", async () => {
    vi.stubEnv("EFFECTIVE_LIMIT", "huge");
    const extension = await loadExtension({
      [GLOBAL_SETTINGS]: JSON.stringify({ statusline: { effectiveLimit: 300_000 } }),
    });
    const { notifyCalls, statusCalls } = await sessionStart(extension);

    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]!.message).toContain("EFFECTIVE_LIMIT");
    expect(notifyCalls[0]!.message).toContain("300000");
    expect(lastStatus(statusCalls)).toContain("SHARP"); // 300k limit, 50k used
  });

  it("lets project settings win over global settings", async () => {
    const cwd = "/work/checkout-service";
    const extension = await loadExtension(
      {
        [GLOBAL_SETTINGS]: JSON.stringify({ statusline: { meterWidth: 20 } }),
        [projectSettings(cwd)]: JSON.stringify({ statusline: { meterWidth: 6 } }),
      },
      cwd,
    );
    const { notifyCalls, statusCalls } = await sessionStart(extension);

    expect(notifyCalls).toEqual([]);
    expect(meterWidth(lastStatus(statusCalls))).toBe(6);
  });

  it("does not notify in non-UI modes", async () => {
    const extension = await loadExtension({
      [GLOBAL_SETTINGS]: JSON.stringify({ statusline: { effectiveLimit: -5 } }),
    });
    const { pi, state } = makeFakePi();
    (await extension)(pi);
    const fake = makeFakeCtx({ hasUI: false });
    await state.handlers.session_start!({}, fake.ctx);

    expect(fake.notifyCalls).toEqual([]);
    expect(fake.statusCalls).toEqual([]);
  });
});