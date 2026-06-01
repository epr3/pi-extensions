import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Helpers – minimal mocks
// ---------------------------------------------------------------------------

interface NotifyCall {
  message: string;
  level: string;
}

let importNonce = 0;

function makeApi(initialName = "") {
  let storedName = initialName;
  let registeredCommand: string | null = null;
  let registeredHandler: ((args: string, ctx: Record<string, unknown>) => Promise<void>) | null =
    null;

  const notifications: NotifyCall[] = [];
  const logs: string[] = [];

  const api = {
    setSessionName(n: string) {
      storedName = n;
    },
    getSessionName() {
      return storedName;
    },
    registerCommand(
      cmd: string,
      opts: {
        handler: (args: string, ctx: Record<string, unknown>) => Promise<void>;
      },
    ) {
      registeredCommand = cmd;
      registeredHandler = opts.handler;
    },
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- mock

  function makeCtx(hasUI: boolean) {
    return {
      hasUI,
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    };
  }

  // Capture console.log
  const originalLog = console.log;
  function stubLog() {
    console.log = (...args: any[]) => {
      // eslint-disable-line @typescript-eslint/no-explicit-any -- mock
      logs.push(args.map(String).join(" "));
    };
  }
  function restoreLog() {
    console.log = originalLog;
  }

  return {
    api,
    getCommand: () => registeredCommand,
    getHandler: () => registeredHandler!,
    getStoredName: () => storedName,
    notifications,
    logs,
    makeCtx,
    stubLog,
    restoreLog,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("smoke – module loads and default export is a function", async () => {
  const mod = await import(`../index.ts?test=${++importNonce}`);
  assert.equal(typeof mod.default, "function");
});

test("register – calling extension registers 'session-name' command", async () => {
  const { api, getCommand, getHandler } = makeApi();
  const mod = await import(`../index.ts?test=${++importNonce}`);
  mod.default(api);
  assert.equal(getCommand(), "session-name");
  assert.equal(typeof getHandler(), "function");
});

test("set + UI – non-empty args sets name and notifies", async () => {
  const { api, getHandler, getStoredName, notifications, makeCtx } = makeApi();
  const mod = await import(`../index.ts?test=${++importNonce}`);
  mod.default(api);
  const handler = getHandler();

  await handler("my-session", makeCtx(true));

  assert.equal(getStoredName(), "my-session");
  assert.deepEqual(notifications, [{ message: "Session named: my-session", level: "info" }]);
});

test("set + no UI – non-empty args sets name and logs to console", async () => {
  const { api, getHandler, getStoredName, logs, makeCtx, stubLog, restoreLog } = makeApi();
  const mod = await import(`../index.ts?test=${++importNonce}`);
  mod.default(api);
  const handler = getHandler();

  stubLog();
  await handler("my-session", makeCtx(false));
  restoreLog();

  assert.equal(getStoredName(), "my-session");
  assert.deepEqual(logs, ["Session named: my-session"]);
});

test("get + existing + UI – empty args with existing name shows session name", async () => {
  const { api, getHandler, notifications, makeCtx } = makeApi("existing-name");
  const mod = await import(`../index.ts?test=${++importNonce}`);
  mod.default(api);
  const handler = getHandler();

  await handler("  ", makeCtx(true));

  assert.deepEqual(notifications, [{ message: "Session: existing-name", level: "info" }]);
});

test("get + none + UI – empty args with no name shows fallback message", async () => {
  const { api, getHandler, notifications, makeCtx } = makeApi("");
  const mod = await import(`../index.ts?test=${++importNonce}`);
  mod.default(api);
  const handler = getHandler();

  await handler("", makeCtx(true));

  assert.deepEqual(notifications, [{ message: "No session name set", level: "info" }]);
});

test("trim – surrounding whitespace is stripped before setSessionName", async () => {
  const { api, getHandler, getStoredName, notifications, makeCtx } = makeApi();
  const mod = await import(`../index.ts?test=${++importNonce}`);
  mod.default(api);
  const handler = getHandler();

  await handler("  hello world  ", makeCtx(true));

  assert.equal(getStoredName(), "hello world");
  assert.deepEqual(notifications, [{ message: "Session named: hello world", level: "info" }]);
});