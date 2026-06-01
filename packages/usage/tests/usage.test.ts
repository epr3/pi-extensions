import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Mock: prevent real network calls throughout all tests
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("Network disabled in tests");
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let importNonce = 0;

/** Pass-through theme — strips ANSI formatting for deterministic assertions. */
function makeTheme() {
  return {
    fg(_color: string, text: string) {
      return text;
    },
    bold(text: string) {
      return text;
    },
  };
}

/** Create a mock ExtensionAPI that captures registered commands. */
function makeApi() {
  const commands = new Map<
    string,
    { description: string; handler: (args: string, ctx: any) => Promise<void> }
  >();
  const api = {
    registerCommand(
      name: string,
      opts: {
        description: string;
        handler: (args: string, ctx: any) => Promise<void>;
      },
    ) {
      commands.set(name, opts);
    },
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- mock
  return { api, commands };
}

/**
 * Create a mock context.
 * When hasUI=true, ui.custom captures the component and optionally waits
 * for the async load() to settle before resolving.
 */
function makeCtx(options: { hasUI?: boolean; modelRegistry?: any; awaitLoad?: boolean } = {}) {
  const notifications: Array<{ message: string; level: string }> = [];
  let capturedComponent: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any -- mock
  let doneCalled = false;
  const awaitLoad = options.awaitLoad ?? true;

  const ctx = {
    hasUI: options.hasUI ?? false,
    modelRegistry: options.modelRegistry ?? {},
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      async custom(cb: any) {
        // eslint-disable-line @typescript-eslint/no-explicit-any -- mock
        const tui = { requestRender() {} };
        const theme = makeTheme();
        capturedComponent = cb(tui, theme, null, () => {
          doneCalled = true;
        });
        if (awaitLoad) {
          // Give the async load() time to settle
          await new Promise((r) => setTimeout(r, 300));
        }
      },
    },
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- mock

  return {
    ctx,
    notifications,
    getComponent: () => capturedComponent,
    wasDoneCalled: () => doneCalled,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("smoke – module loads and default export is a function", async () => {
  const mod = await import(`../index.ts?test=${++importNonce}`);
  assert.equal(typeof mod.default, "function");
});

test("register – calling extension registers 'usage' command with description", async () => {
  const { api, commands } = makeApi();
  const mod = await import(`../index.ts?test=${++importNonce}`);
  mod.default(api);

  assert.equal(commands.has("usage"), true);
  const cmd = commands.get("usage")!;
  assert.equal(cmd.description, "Show AI provider usage statistics");
  assert.equal(typeof cmd.handler, "function");
});

test("handler no-UI – calls notify with error message", async () => {
  const { api, commands } = makeApi();
  const mod = await import(`../index.ts?test=${++importNonce}`);
  mod.default(api);
  const handler = commands.get("usage")!.handler;

  const { ctx, notifications } = makeCtx({ hasUI: false });
  await handler("", ctx);

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].message, "Usage requires interactive mode");
  assert.equal(notifications[0].level, "error");
});

test("handler with UI – creates component via ui.custom", async () => {
  const { api, commands } = makeApi();
  const mod = await import(`../index.ts?test=${++importNonce}`);
  mod.default(api);
  const handler = commands.get("usage")!.handler;

  const { ctx, getComponent } = makeCtx({ hasUI: true, modelRegistry: {} });
  await handler("", ctx);

  const component = getComponent();
  assert.ok(component, "ui.custom should have created a component");
  assert.equal(typeof component.handleInput, "function");
  assert.equal(typeof component.render, "function");
  assert.equal(typeof component.dispose, "function");
  assert.equal(typeof component.invalidate, "function");
});

test("component – render shows Loading... before load completes", async () => {
  const { api, commands } = makeApi();
  const mod = await import(`../index.ts?test=${++importNonce}`);
  mod.default(api);
  const handler = commands.get("usage")!.handler;

  // awaitLoad=false: ui.custom returns immediately without waiting for load()
  const { ctx, getComponent } = makeCtx({
    hasUI: true,
    modelRegistry: {},
    awaitLoad: false,
  });
  await handler("", ctx);

  const component = getComponent();
  assert.ok(component);

  // Render synchronously — load() hasn't settled yet
  const lines = component.render(60);
  assert.ok(lines.length > 0);
  const joined = lines.join("\n");
  assert.match(joined, /Loading\.\.\./);
});

test("component – render shows AI Usage header and footer after load settles", async () => {
  const { api, commands } = makeApi();
  const mod = await import(`../index.ts?test=${++importNonce}`);
  mod.default(api);
  const handler = commands.get("usage")!.handler;

  const { ctx, getComponent } = makeCtx({ hasUI: true, modelRegistry: {} });
  await handler("", ctx);

  const component = getComponent();
  assert.ok(component);

  const lines = component.render(60);
  const joined = lines.join("\n");
  assert.match(joined, /AI Usage/);
  assert.match(joined, /Press any key to close/);
});

test("component – render shows at least one provider after load settles", async () => {
  const { api, commands } = makeApi();
  const mod = await import(`../index.ts?test=${++importNonce}`);
  mod.default(api);
  const handler = commands.get("usage")!.handler;

  const { ctx, getComponent } = makeCtx({ hasUI: true, modelRegistry: {} });
  await handler("", ctx);

  const component = getComponent();
  const lines = component.render(60);
  const joined = lines.join("\n");

  // Copilot with "No token" error is not filtered — always appears.
  // Other providers may also appear if credentials exist on the host.
  const hasProvider =
    joined.includes("Claude") ||
    joined.includes("Copilot") ||
    joined.includes("Gemini") ||
    joined.includes("Codex") ||
    joined.includes("Antigravity") ||
    joined.includes("Kiro") ||
    joined.includes("z.ai") ||
    joined.includes("nanoGPT");
  assert.ok(hasProvider, `Expected at least one provider in render output:\n${joined}`);
});

test("component – handleInput triggers done (onClose) callback", async () => {
  const { api, commands } = makeApi();
  const mod = await import(`../index.ts?test=${++importNonce}`);
  mod.default(api);
  const handler = commands.get("usage")!.handler;

  const { ctx, getComponent, wasDoneCalled } = makeCtx({ hasUI: true, modelRegistry: {} });
  await handler("", ctx);

  const component = getComponent();
  assert.ok(!wasDoneCalled(), "done should not be called before handleInput");

  component.handleInput("q");

  assert.ok(wasDoneCalled(), "done should be called after handleInput");
});

test("component – dispose and invalidate do not throw", async () => {
  const { api, commands } = makeApi();
  const mod = await import(`../index.ts?test=${++importNonce}`);
  mod.default(api);
  const handler = commands.get("usage")!.handler;

  const { ctx, getComponent } = makeCtx({ hasUI: true, modelRegistry: {} });
  await handler("", ctx);

  const component = getComponent();
  assert.doesNotThrow(() => component.invalidate());
  assert.doesNotThrow(() => component.dispose());
});

// Restore fetch after all tests
test("cleanup – restore global fetch", () => {
  globalThis.fetch = realFetch;
});