/**
 * Diagnostics-request confidence — Vitest.
 *
 * Exercises lsp_diagnostics end-to-end at the registered-tool boundary against
 * the fake Language server, covering the confidence contract:
 *   - current: a publish correlated with the opened document version
 *   - pending: no publish since the last open/saved-file synchronization
 *   - uncertain: publishes that cannot be correlated (no document version)
 * A wait budget (diagnosticsDelayMs) bounds the wait; it is never treated as
 * evidence that the diagnostics are current.
 */

import { afterEach, describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { startWorkspace, type Workspace } from "./harness.ts";
import type { DiagnosticsStatus } from "../client.ts";
import type { LspNavigationDetails } from "../render-result.ts";

function detailsOf(
  ws: Workspace,
  toolResult: string | { text: string; details: Record<string, unknown> },
) {
  if (typeof toolResult === "string")
    throw new Error("expected structured details on diagnostics result");
  return toolResult.details as LspNavigationDetails;
}

describe("lsp_diagnostics confidence", () => {
  let ws: Workspace;
  afterEach(async () => {
    await ws?.dispose();
  });

  it("reports current, version-correlated diagnostics once the server publishes", async () => {
    // Publish delay must sit comfortably inside the wait budget: the budget
    // starts when the tool call does, the publish when the server answers.
    ws = startWorkspace({ publishMode: "versioned", publishDelayMs: 10, diagnosticsDelayMs: 300 });
    const sample = ws.writeSample("function alpha() {}\n// FIXME alpha is broken\n");

    const result = await ws.tool("lsp_diagnostics").run({ file: sample });
    const details = detailsOf(ws, result);

    expect(details.resultKind).toBe("diagnostics");
    expect(details.confidence).toBe("current");
    expect(details.sinceVersion).toBe(1);
    const diags = details.diagnostics as Array<Record<string, unknown>>;
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      severity: "error",
      file: sample,
      line: 2,
      column: 4,
    });
    expect(String(diags[0]!.message)).toContain("synthetic error");
    expect(result.text).toContain("error");
    expect(result.text).toContain("synthetic error");
  });

  it("treats a quiet server as pending, never as a clean file", async () => {
    ws = startWorkspace({ publishMode: "silent" });
    const sample = ws.writeSample("function alpha() {}\n");

    const result = await ws.tool("lsp_diagnostics").run({ file: sample });
    const details = detailsOf(ws, result);

    expect(details.resultKind).toBe("diagnostics");
    expect(details.confidence).toBe("pending");
    expect(details.diagnostics).toEqual([]);
    expect(result.text).toContain("not available yet");
    expect(result.text).not.toContain("no diagnostics");
  });

  it("treats a publish later than the budget as pending until it truly arrives", async () => {
    // Publish at 80ms, budget 10ms: the wait expires first, so the delay alone
    // must not be reported as a current result.
    ws = startWorkspace({ publishMode: "versioned", publishDelayMs: 80, diagnosticsDelayMs: 10 });
    const sample = ws.writeSample("function alpha() {}\n");

    const expired = await ws.tool("lsp_diagnostics").run({ file: sample });
    expect(detailsOf(ws, expired).confidence).toBe("pending");

    // A genuinely longer budget resolves early once the publish arrives.
    const client = await ws.client();
    const t0 = Date.now();
    await client.waitForDiagnostics(pathToFileURL(sample).href, 2000);
    const elapsed = Date.now() - t0;
    const status: DiagnosticsStatus = client.getDiagnostics(pathToFileURL(sample).href);
    expect(status.state).toBe("current");
    expect(status.sinceVersion).toBe(1);
    expect(elapsed).toBeLessThan(2000); // resolved early, not by budget expiry
  });

  it("reports current, correlated diagnostics after an earlier stale publish", async () => {
    // The server publishes for the previous state first (stale version), then
    // catches up with the opened document version inside the wait budget.
    ws = startWorkspace({
      publishMode: "stale-then-current",
      publishDelayMs: 30,
      diagnosticsDelayMs: 300,
    });
    const sample = ws.writeSample("function alpha() {}\n// FIXME alpha is broken\n");

    const first = await ws.tool("lsp_diagnostics").run({ file: sample });
    const firstDetails = detailsOf(ws, first);
    expect(firstDetails.confidence).toBe("current");
    expect(firstDetails.sinceVersion).toBe(1);
    expect((firstDetails.diagnostics as unknown[]).length).toBe(1);

    // Saved edit: the stale publish still carries the old error for version 1,
    // so only the correlated version-2 publish may be reported as clean.
    ws.writeSample("function alpha() {}\nfunction beta() {}\n");
    const second = await ws.tool("lsp_diagnostics").run({ file: sample });
    const secondDetails = detailsOf(ws, second);
    expect(secondDetails.confidence).toBe("current");
    expect(secondDetails.sinceVersion).toBe(2);
    expect(secondDetails.diagnostics).toEqual([]);
    expect(second.text).toBe("no diagnostics");
  });

  it("waits out the budget for a lagging server, then keeps its uncertainty", async () => {
    const budget = 200;
    ws = startWorkspace({
      publishMode: "stale-only",
      publishDelayMs: 10,
      diagnosticsDelayMs: budget,
    });
    const sample = ws.writeSample("function alpha() {}\n// FIXME alpha is broken\n");
    // First call opens the document at version 1; the lagging server answers
    // for version 0, so even the open is uncertain.
    const opened = await ws.tool("lsp_diagnostics").run({ file: sample });
    expect(detailsOf(ws, opened).confidence).toBe("uncertain");

    // Saved edit: the lagging server re-publishes the state it analyzed before
    // (version 1, one error) and never reaches the current version 2.
    ws.writeSample("function alpha() {}\n// FIXME alpha is broken\n// FIXME beta is broken\n");

    const t0 = Date.now();
    const result = await ws.tool("lsp_diagnostics").run({ file: sample });
    const elapsed = Date.now() - t0;
    const details = detailsOf(ws, result);

    // An uncorrelated publish is not the answer: the wait runs to the budget
    // and then reports the uncertainty, keeping the observed items.
    expect(elapsed).toBeGreaterThanOrEqual(budget * 0.75);
    expect(elapsed).toBeLessThan(budget + 2000);
    expect(details.confidence).toBe("uncertain");
    expect(details.sinceVersion).toBe(1);
    const diags = details.diagnostics as Array<Record<string, unknown>>;
    expect(diags).toHaveLength(1);
    expect(String(diags[0]!.message)).toContain("FIXME alpha is broken");
    expect(result.text).toContain("freshness could not be established");
  });

  it("gives up the wait as soon as a versionless server publishes", async () => {
    // A server that never versions its publishes cannot be correlated, so the
    // remaining budget must not be spent waiting for a result that cannot come.
    const budget = 2000;
    ws = startWorkspace({
      publishMode: "unversioned",
      publishDelayMs: 10,
      diagnosticsDelayMs: budget,
    });
    const sample = ws.writeSample("function alpha() {}\n// FIXME alpha is broken\n");

    const t0 = Date.now();
    const result = await ws.tool("lsp_diagnostics").run({ file: sample });
    const elapsed = Date.now() - t0;
    const details = detailsOf(ws, result);

    expect(elapsed).toBeLessThan(budget / 2);
    expect(details.confidence).toBe("uncertain");
    expect(details.sinceVersion).toBeNull();
    expect((details.diagnostics as unknown[]).length).toBe(1);
    expect(result.text).toContain("freshness could not be established");
  });

  it("marks unversioned server responses uncertain, even when they report items", async () => {
    ws = startWorkspace({ publishMode: "unversioned", diagnosticsDelayMs: 300 });
    const sample = ws.writeSample("function alpha() {}\n// FIXME alpha is broken\n");

    const result = await ws.tool("lsp_diagnostics").run({ file: sample });
    const details = detailsOf(ws, result);

    expect(details.confidence).toBe("uncertain");
    expect(details.sinceVersion).toBeNull();
    const diags = details.diagnostics as Array<Record<string, unknown>>;
    expect(diags).toHaveLength(1);
    expect(String(diags[0]!.message)).toContain("synthetic error");
    expect(result.text).toContain("synthetic error");
    expect(result.text).toContain("freshness could not be established");
    expect(result.text).toContain("may not reflect the latest saved contents");
  });

  it("never reports an unversioned empty set as a clean file", async () => {
    ws = startWorkspace({ publishMode: "unversioned", diagnosticsDelayMs: 300 });
    const sample = ws.writeSample("function alpha() {}\n");

    const result = await ws.tool("lsp_diagnostics").run({ file: sample });
    const details = detailsOf(ws, result);

    expect(details.confidence).toBe("uncertain");
    expect(details.diagnostics).toEqual([]);
    expect(result.text).toContain("freshness could not be established");
    expect(result.text).not.toMatch(/^no diagnostics$/m);
  });

  it("re-reports current, updated diagnostics after a saved edit", async () => {
    ws = startWorkspace({ publishMode: "versioned", diagnosticsDelayMs: 300 });
    const sample = ws.writeSample("function alpha() {}\n// FIXME alpha is broken\n");

    const before = await ws.tool("lsp_diagnostics").run({ file: sample });
    const beforeDetails = detailsOf(ws, before);
    expect(beforeDetails.confidence).toBe("current");
    expect((beforeDetails.diagnostics as unknown[]).length).toBe(1);

    // Saved edit removes the marker; the next request synchronizes first.
    ws.writeSample("function alpha() {}\nfunction beta() {}\n");

    const after = await ws.tool("lsp_diagnostics").run({ file: sample });
    const afterDetails = detailsOf(ws, after);
    expect(afterDetails.confidence).toBe("current");
    expect(afterDetails.sinceVersion).toBe(2); // didOpen was version 1
    expect(afterDetails.diagnostics).toEqual([]);
    expect(after.text).toBe("no diagnostics");
  });

  it("stays pending for a quiet server even after a saved edit", async () => {
    ws = startWorkspace({ publishMode: "silent" });
    const sample = ws.writeSample("function alpha() {}\n");
    await ws.tool("lsp_diagnostics").run({ file: sample });

    ws.writeSample("function alpha() {}\n// FIXME beta is broken\n");
    const result = await ws.tool("lsp_diagnostics").run({ file: sample });
    const details = detailsOf(ws, result);

    expect(details.confidence).toBe("pending");
    expect(details.diagnostics).toEqual([]);
    expect(result.text).toContain("not available yet");
  });
});