/**
 * Real-Pi lifecycle smoke runner (ticket 0021).
 *
 * Starts one real `pi --mode json` process per scenario invocation against an
 * isolated agent directory, an isolated session directory, and a deterministic
 * stub model provider. Records and checks the evidence that the packages'
 * `__tests__` fake-API suites cannot produce: Pi's own extension loading,
 * session/tool/run lifecycle events, and the dual tool-result contract as Pi
 * actually stores it.
 *
 * Run by hand: `node_modules/.bin/tsx scripts/pi-smoke/run.ts` (repo root).
 * Deliberately not wired into `pnpm test` / vitest: it needs the `pi` CLI on
 * PATH and is a verification workflow, not a hermetic package test. The pure
 * evaluation helpers it uses are covered by `scripts/__tests__/pi-smoke.test.ts`.
 *
 * See scripts/pi-smoke/README.md for prerequisites, recorded results, and the
 * scenarios this workflow does not verify.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateObservations,
  parseJsonl,
  parseProbeLog,
  summarize,
  type Observations,
} from "./evaluate.ts";
import { SCENARIOS, findScenario, type Invocation, type Scenario } from "./scenarios.ts";
import { STUB_MODEL, modelsJson, startStubProvider, type StubProvider } from "./stub-provider.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const PI_BIN = process.env.PI_SMOKE_PI ?? "pi";
const TIMEOUT_MS = Number(process.env.PI_SMOKE_TIMEOUT_MS ?? 120_000);
const PI_VERSION = detectPiVersion();

/** Pi's self-reported version is part of the record; the run continues without it. */
function detectPiVersion(): string {
  const result = spawnSync(PI_BIN, ["--version"], { encoding: "utf8", timeout: 30_000 });
  if (result.error) return "unavailable";
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n")[0];
  return output || "unavailable";
}

type RunOptions = { keep: boolean; verbose: boolean };

type InvocationResult = {
  invocation: Invocation;
  index: number;
  observations: Observations;
  probeEvents: string[];
  sessionFile: string | null;
  scratchDir: string;
};

function usage(): string {
  return [
    "Usage: tsx scripts/pi-smoke/run.ts [scenario-id ...] [--keep] [--verbose] [--list]",
    "",
    "Scenarios:",
    ...SCENARIOS.map((scenario) => `  ${scenario.id.padEnd(16)} ${scenario.title}`),
  ].join("\n");
}

function fail(message: string): never {
  console.error(`pi-smoke: ${message}`);
  process.exit(1);
  throw new Error(message);
}

function childEnv(scratch: string, probeLog: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Strip ambient model/agent overrides so the run is what the scenario says.
  for (const key of [
    "PI_MODEL",
    "PI_PROVIDER",
    "PI_DEFAULT_MODEL",
    "PI_DEFAULT_PROVIDER",
    "PI_REASONING_LEVEL",
    "PI_SESSION",
  ]) {
    delete env[key];
  }
  env.HOME = path.join(scratch, "home");
  env.PI_CODING_AGENT_DIR = path.join(scratch, "agent");
  env.PI_SMOKE_LOG = probeLog;
  env.PI_SMOKE_PI_VERSION = PI_VERSION;
  env.PI_OFFLINE = "1";
  env.PI_TELEMETRY = "0";
  return env;
}

function piArgs(scenario: Scenario, invocation: Invocation, scratch: string): string[] {
  const args = [
    "--mode",
    "json",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-mcp",
    "--session-dir",
    path.join(scratch, "sessions"),
    "--session-id",
    `smoke-${scenario.id}`,
    "--model",
    STUB_MODEL,
    "-e",
    path.join(HERE, "probe.ts"),
  ];
  for (const dir of scenario.extensions) args.push("-e", path.join(REPO_ROOT, dir, "index.ts"));
  args.push("-p", invocation.prompt);
  return args;
}

function runPi(
  scenario: Scenario,
  invocation: Invocation,
  scratch: string,
  stub: StubProvider,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const probeLog = path.join(scratch, "probe-events.jsonl");
  if (existsSync(probeLog)) rmSync(probeLog);
  stub.reset(invocation.responses);

  return new Promise((resolve, reject) => {
    const child = spawn(PI_BIN, piArgs(scenario, invocation, scratch), {
      cwd: path.join(scratch, "work"),
      env: childEnv(scratch, probeLog),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`pi did not finish within ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.stdout.on("data", (part: Buffer) => (stdout += part.toString("utf8")));
    child.stderr.on("data", (part: Buffer) => (stderr += part.toString("utf8")));
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ENOENT") {
        reject(
          new Error(`pi CLI not found (${PI_BIN}). Install Pi or set PI_SMOKE_PI=/path/to/pi.`),
        );
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

function probeLogPath(scratch: string): string {
  return path.join(scratch, "probe-events.jsonl");
}

function sessionFilePath(scratch: string, scenario: Scenario): string | null {
  const dir = path.join(scratch, "sessions");
  if (!existsSync(dir)) return null;
  const match = readdirSync(dir).find((name) => name.includes(scenario.id));
  return match ? path.join(dir, match) : null;
}

function prepareScratch(scenario: Scenario, stub: StubProvider): string {
  const scratch = mkdtempSync(path.join(os.tmpdir(), `pi-smoke-${scenario.id}-`));
  mkdirSync(path.join(scratch, "agent"), { recursive: true });
  mkdirSync(path.join(scratch, "work"), { recursive: true });
  mkdirSync(path.join(scratch, "sessions"), { recursive: true });
  mkdirSync(path.join(scratch, "home"), { recursive: true });
  writeFileSync(path.join(scratch, "agent", "models.json"), modelsJson(stub.baseUrl));
  return scratch;
}

async function runScenario(scenario: Scenario, options: RunOptions): Promise<boolean> {
  const stub = await startStubProvider();
  const scratch = prepareScratch(scenario, stub);
  const results: InvocationResult[] = [];
  let ok = true;

  console.log(`\n=== ${scenario.id}: ${scenario.title}`);
  console.log(`    scratch: ${scratch}`);

  try {
    for (const [index, invocation] of scenario.invocations.entries()) {
      console.log(`\n  [run ${index + 1}/${scenario.invocations.length}] ${invocation.prompt}`);
      const { exitCode, stdout, stderr } = await runPi(scenario, invocation, scratch, stub);
      const probeText = existsSync(probeLogPath(scratch))
        ? readFileSync(probeLogPath(scratch), "utf8")
        : "";
      const probeRecords = parseProbeLog(probeText);
      const observations: Observations = {
        events: parseJsonl(stdout),
        probe: probeRecords,
        requests: stub.requests.map(({ body: _body, ...rest }) => rest),
        exitCode,
        stderr,
      };
      const probeEvents = probeRecords.map((record) => record.name);
      const sessionFile = sessionFilePath(scratch, scenario);
      results.push({
        invocation,
        index,
        observations,
        probeEvents,
        sessionFile,
        scratchDir: scratch,
      });

      const findings = evaluateObservations(observations, invocation.expectations);
      const summary = summarize(findings);
      if (summary.failed > 0) ok = false;
      console.log(
        summary.text
          .split("\n")
          .map((line) => `    ${line}`)
          .join("\n"),
      );
      console.log(
        `    Pi session events: ${observations.events.map((event) => event.type).join(" ") || "none"}`,
      );
      console.log(`    Extension events:  ${probeEvents.join(" ") || "none"}`);
      for (const request of observations.requests) {
        console.log(
          `    model request ${request.call}: roles=${request.messageRoles.join(",") || "-"} tools=${request.toolNames.length}` +
            (options.verbose ? ` [${request.toolNames.join(",")}]` : ""),
        );
      }
      if (stderr.trim()) console.log(`    stderr: ${stderr.trim().split("\n").join(" | ")}`);
    }
  } finally {
    await stub.close();
    if (options.keep) {
      console.log(`\n  kept evidence: ${scratch}`);
    } else {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  console.log(`\n  ${ok ? "PASS" : "FAIL"} ${scenario.id}`);
  return ok;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return;
  }
  if (argv.includes("--list")) {
    console.log(usage());
    return;
  }
  const options: RunOptions = {
    keep: argv.includes("--keep"),
    verbose: argv.includes("--verbose"),
  };
  const ids = argv.filter((arg) => !arg.startsWith("--"));

  const selected =
    ids.length === 0
      ? SCENARIOS
      : ids.map((id) => findScenario(id) ?? fail(`unknown scenario "${id}"\n\n${usage()}`));

  console.log(`pi-smoke: real-Pi lifecycle smoke workflows`);
  console.log(`  repo:     ${REPO_ROOT}`);
  console.log(`  pi:       ${PI_BIN} (${PI_VERSION})`);
  console.log(`  provider: deterministic stub (${STUB_MODEL}); no API credentials used`);

  let allOk = true;
  for (const scenario of selected) {
    try {
      const ok = await runScenario(scenario, options);
      allOk = allOk && ok;
    } catch (error) {
      allOk = false;
      console.error(
        `\n  FAIL ${scenario.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.log(
    `\n${allOk ? "pi-smoke: all scenarios passed" : "pi-smoke: failures reported above"}`,
  );
  process.exit(allOk ? 0 : 1);
}

await main();