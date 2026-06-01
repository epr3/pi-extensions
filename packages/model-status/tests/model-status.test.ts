import test from "node:test";
import assert from "node:assert/strict";

let importNonce = 0;
async function loadExtension() {
  importNonce += 1;
  const mod = await import(`../index.ts?test=${importNonce}`);
  return mod.default as (api: any) => void;
}

function createHarness() {
  const eventHandlers = new Map<string, (event: any, ctx: any) => void>();
  const notifications: Array<{ message: string; level: string }> = [];
  const statusEntries: Array<{ key: string; value: string }> = [];
  const logCalls: string[] = [];

  const api = {
    on(eventName: string, handler: (event: any, ctx: any) => void) {
      eventHandlers.set(eventName, handler);
    },
  } as any;

  const ctx = {
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      setStatus(key: string, value: string) {
        statusEntries.push({ key, value });
      },
    },
  } as any;

  return { api, ctx, eventHandlers, notifications, statusEntries, logCalls };
}

/** Suppress console.log output during tests and capture calls. */
function withCapturedLog(fn: (logCalls: string[]) => Promise<void>) {
  const original = console.log;
  const calls: string[] = [];
  console.log = (...args: any[]) => {
    calls.push(args.join(" "));
  };
  return fn(calls).finally(() => {
    console.log = original;
  });
}

test("smoke – module loads and default export is a function", async () => {
  const extension = await loadExtension();
  assert.equal(typeof extension, "function");
});

test("registers model_select event handler", async () => {
  const extension = await loadExtension();
  const h = createHarness();
  extension(h.api);

  assert.equal(h.eventHandlers.has("model_select"), true);
  assert.equal(typeof h.eventHandlers.get("model_select"), "function");
});

test("non-restore source – notifies, sets status, and logs", async () => {
  const extension = await loadExtension();
  const h = createHarness();
  extension(h.api);

  const handler = h.eventHandlers.get("model_select")!;

  await withCapturedLog(async (logCalls) => {
    await handler(
      {
        model: { provider: "openai", id: "gpt-4o" },
        previousModel: { provider: "anthropic", id: "claude-3" },
        source: "user",
      },
      h.ctx,
    );

    // notify called once with formatted provider/id
    assert.equal(h.notifications.length, 1);
    assert.equal(h.notifications[0].message, "Model: openai/gpt-4o");
    assert.equal(h.notifications[0].level, "info");

    // status set with robot emoji + model id
    assert.equal(h.statusEntries.length, 1);
    assert.equal(h.statusEntries[0].key, "model");
    assert.equal(h.statusEntries[0].value, "🤖 gpt-4o");

    // log has expected format
    assert.equal(logCalls.length, 1);
    assert.match(logCalls[0], /\[model_select\] anthropic\/claude-3 → openai\/gpt-4o \(user\)/);
  });
});

test("restore source – suppresses notify but still sets status and logs", async () => {
  const extension = await loadExtension();
  const h = createHarness();
  extension(h.api);

  const handler = h.eventHandlers.get("model_select")!;

  await withCapturedLog(async (logCalls) => {
    await handler(
      {
        model: { provider: "anthropic", id: "claude-sonnet-4" },
        previousModel: undefined,
        source: "restore",
      },
      h.ctx,
    );

    // notify NOT called for restore source
    assert.equal(h.notifications.length, 0);

    // status still set
    assert.equal(h.statusEntries.length, 1);
    assert.equal(h.statusEntries[0].key, "model");
    assert.equal(h.statusEntries[0].value, "🤖 claude-sonnet-4");

    // log still called
    assert.equal(logCalls.length, 1);
    assert.match(logCalls[0], /\[model_select\] none → anthropic\/claude-sonnet-4 \(restore\)/);
  });
});

test("no previousModel – logs 'none' as previous identifier", async () => {
  const extension = await loadExtension();
  const h = createHarness();
  extension(h.api);

  const handler = h.eventHandlers.get("model_select")!;

  await withCapturedLog(async (logCalls) => {
    await handler(
      {
        model: { provider: "openai", id: "gpt-4o-mini" },
        previousModel: undefined,
        source: "user",
      },
      h.ctx,
    );

    assert.equal(logCalls.length, 1);
    assert.match(logCalls[0], /\[model_select\] none → openai\/gpt-4o-mini \(user\)/);
  });
});

test("status text uses model.id only (not provider/id)", async () => {
  const extension = await loadExtension();
  const h = createHarness();
  extension(h.api);

  const handler = h.eventHandlers.get("model_select")!;

  await handler(
    {
      model: { provider: "google", id: "gemini-2.5-pro" },
      previousModel: undefined,
      source: "user",
    },
    h.ctx,
  );

  assert.equal(h.statusEntries.length, 1);
  assert.equal(h.statusEntries[0].value, "🤖 gemini-2.5-pro");
});