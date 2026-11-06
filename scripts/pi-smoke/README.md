# pi-smoke — real-Pi lifecycle smoke workflows

Runs a **real Pi process** with this repo's Extension packages loaded, and checks
what the package-owned fake-`ExtensionAPI` suites cannot show: Pi's own extension
loading, session/tool/run lifecycle event order, the dual tool-result contract as
Pi actually stores it, and session-branch reuse.

Established by ticket 0021 (`.scratch/extension-improvements/issues/`): "Establish
a real-Pi lifecycle smoke workflow". The workflow supplements the deterministic
package suites; it does not replace them, and it is **not** a CI gate.

## Real runtime evidence vs. stubbed services

| Real (runtime evidence)                                                                                      | Stubbed or absent                                                             |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| The `pi` CLI process: extension loader (jiti), tool registration and schemas, agent/turn loop, tool executor | The model service — a local OpenAI chat-completions stub (`stub-provider.ts`) |
| Pi's session store and JSONL session files (branch entries, tool results, details)                           | API credentials — none are read or needed                                     |
| Pi's own `--mode json` session event stream (`turn_start` … `agent_settled`)                                 | Network — `PI_OFFLINE=1`, no outbound calls attempted                         |
| Extension lifecycle dispatch, observed by a probe extension Pi loads (`probe.ts`)                            | Language servers, Subagent child models, TUI rendering                        |
| Tool call → execution → result → follow-up turn, including `content` + `details`                             | Sampling/model choice — responses are scripted per scenario                   |

The extension code under test is unmodified and runs inside Pi. These are _not_
the package fakes: `packages/*/__tests__` fake the `ExtensionAPI` object, while
this workflow fakes only the model endpoint.

## Prerequisites

- The **`pi` CLI on `PATH`**. Recorded with `1.5.0 (Pi-Bolt 1.1.0, darwin-arm64, JIT off)`
  on macOS 27.0.1, Node `v22.22.3`. Override the binary with `PI_SMOKE_PI=/path/to/pi`.
- A monorepo checkout with `node_modules` installed (the runner uses the root
  `tsx` dev dependency). No `pnpm install` is needed inside `scripts/pi-smoke`.
- No credentials and no network access. The runner points `PI_CODING_AGENT_DIR`
  and `HOME` at a fresh OS temp directory, so your `~/.pi/agent` settings,
  extensions, sessions, and credentials are never used.

## Setup the runner performs per scenario

1. Creates `$TMPDIR/pi-smoke-<scenario>-*/` with `agent/`, `work/`, `sessions/`, `home/`.
2. Writes `agent/models.json` registering a `smoke` provider that points at the
   loopback stub (`http://127.0.0.1:<ephemeral>/v1`, `api: openai-completions`,
   dummy key). The stub binds port `0`, so concurrent runs do not collide.
3. Runs, from `work/`:

   ```sh
   pi --mode json --no-extensions --no-skills --no-prompt-templates --no-context-files --no-mcp \
      --session-dir <scratch>/sessions --session-id smoke-<scenario> \
      --model smoke/smoke-model \
      -e scripts/pi-smoke/probe.ts -e packages/<pkg>/index.ts … \
      -p "<prompt>"
   ```

   `--no-extensions` plus explicit `-e` paths keeps the run to exactly the
   packages a scenario names. Each model request is answered from the scenario's
   scripted plan, so tool calls and text replies are deterministic.

4. Evaluates the recorded evidence (see below) and prints one finding per check.

## Commands

```sh
# All scenarios (repo root)
node_modules/.bin/tsx scripts/pi-smoke/run.ts

# One scenario, keeping the evidence directory for inspection
node_modules/.bin/tsx scripts/pi-smoke/run.ts tool-call --keep

# Add the tool names Pi advertised on each request
node_modules/.bin/tsx scripts/pi-smoke/run.ts --verbose

node_modules/.bin/tsx scripts/pi-smoke/run.ts --list   # scenario ids
PI_SMOKE_TIMEOUT_MS=180000 node_modules/.bin/tsx scripts/pi-smoke/run.ts
```

Deterministic unit tests for the harness's own parsing and pass/fail logic (no
Pi, no network):

```sh
node_modules/.bin/vitest run scripts/__tests__/pi-smoke.test.ts
```

Kept evidence (`--keep`) contains `probe-events.jsonl` (extension lifecycle
events) and `sessions/*.jsonl` (Pi session entries). Nothing is written into the
repository. The workflow is deliberately absent from `pnpm test`, `verify:ext`
and the root `coverage` roll-up: it needs the `pi` CLI, and a missing runtime must
read as "not run", never as a green check.

## Scenarios

| id               | What it exercises                                      | Evidence asserted                                                                                                                                                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension-load` | All nine Extension packages load in one Pi process.    | Exit 0, no `Failed to load extension` on stderr, `session_start`/`session_shutdown` from the probe, and every package's tools present on the model request (`todo_write`, `todo_read`, `question`, `Agent`, `stop_subagent`, `get_subagent_result`, `lsp_definition`, `lsp_diagnostics`, `web_fetch`, `web_search`). |
| `tool-call`      | A scripted model tool call runs `todo_write` for real. | `turn_start → tool_execution_start → tool_execution_end → turn_end → agent_settled`, two turns, probe `tool_call`/`tool_result`, the tool result keeps plain-text `content` **and** `details.items`/`details.currentIndex`, and the follow-up request carries a `tool` message.                                      |
| `session-reuse`  | Two Pi processes share one session id.                 | Each process reports `session_start`/`session_shutdown`; the second process's first request replays `system,user,assistant,tool`, i.e. the earlier branch survives across processes.                                                                                                                                 |

## Recorded results

Run on 2026-11-06 with `pi 1.5.0 (Pi-Bolt 1.1.0, darwin-arm64, JIT off)` and
Node `v22.22.3`, from a clean worktree (`--keep` evidence inspected, then removed):

| Scenario         | Result                                      |
| ---------------- | ------------------------------------------- |
| `extension-load` | PASS — 7/7 checks                           |
| `tool-call`      | PASS — 8/8 checks                           |
| `session-reuse`  | PASS — 2/2 (first run) and 4/4 (second run) |

Observed details worth keeping in mind when reading other investigations:

- The model request carried **23 tools**: six Pi built-ins (`read`, `bash`,
  `edit`, `write`, `grep`, `find`) plus 17 from this repo (`todo_write`,
  `todo_read`, `question`, `Agent`, `stop_subagent`, `get_subagent_result`, the
  nine `lsp_*` tools, `web_fetch`, `web_search`). `statusline`,
  `model-compaction` and `model-presets` contribute event handlers, commands and
  UI, not tools, so their presence is shown by `extension-load` loading cleanly
  rather than by a tool name.
- Extension lifecycle order in a headless run: `probe_loaded → session_start →
resources_discover → input → before_agent_start → agent_start → turn_start →
… → agent_before_settle → agent_settled → session_shutdown`. `project_trust`
  did not fire: the run happens in a fresh temp cwd, non-interactively.
- `session_shutdown` fires with `reason: "quit"` after the prompt finishes; the
  process still exits 0.
- A tool result stored in the session keeps the dual contract, e.g.
  `content: [{type:"text",text:"0/1 done\nCurrent: smoke step\n[~] smoke step"}]`
  and `details: {items: […], currentItem: …, currentIndex: 0}`.
- A reused session replays its prior branch into the next process's request as
  `system,user,assistant,tool,assistant,user`. `session_start.reason` is
  `"startup"` for **both** processes, so startup-vs-resume is _not_ distinguishable
  from that event in this workflow; use the replayed request or the session file.
- stderr carries one expected warning per first run:
  `Warning: No project session found with id 'smoke-<scenario>'; creating a new session with that id.`

## Proof the checks can fail (negative controls)

- Raising a bogus expectation (`lsp_nonexistent_tool` in the `extension-load`
  tool set) drops that scenario to 6/7 and names the miss:
  `✗ extension tools reach the model request — missing lsp_nonexistent_tool (request 1); saw request 1: read,bash,…`.
  The scenario data was reverted after the check.
- `PI_SMOKE_PI=/nonexistent/pi` fails the run with
  `FAIL tool-call: pi CLI not found (/nonexistent/pi). Install Pi or set PI_SMOKE_PI=/path/to/pi.`
  and exit code 1.
- `scripts/__tests__/pi-smoke.test.ts` includes contradictory-evidence cases
  (wrong exit code, absent events, wrong tool, missing `details` key, missing
  role, stderr load failure) so the evaluator cannot pass by construction.

## Not verified by this workflow

These need a different driver or scenario and must stay unverified until then:

- **TUI behaviour** — the `statusline` footer and its freshness across
  startup/selection/branch/shutdown, `question` dialog interaction (`Done`,
  `Escape`, abort cleanup), Subagent overlays. `--mode json` has no UI; this
  needs a pty/tmux driver feeding real keystrokes and reading the rendered screen.
- **Interactive input paths** — key handling, `input` interception, `ui_prompt_*`.
- **Model-driven behaviour** — thinking-level clamping, model selection/preset
  cycling UI, provider-specific quirks: the stub model has no real thinking
  support and model choice is scripted.
- **Model-aware compaction lifecycle (ticket 0022)** — no real-Pi evidence is
  claimed for success, failure, continuation, or session transitions. The current
  smoke runner has no compaction scenario: it does not configure the model-aware
  extension's `turn_end` threshold, force a Pi compaction, or record the compact
  callbacks/session-compaction events. Its scripted model replies and normal
  turns therefore cannot establish any of those outcomes. Deterministic package
  tests exercise the extension's fake-`ExtensionAPI` callbacks, guard/retry,
  continuation decision, and absence of continuation on failure, but those are
  simulated evidence only. Do not infer a lifecycle defect from this coverage
  gap; add a scenario that captures real Pi events/session entries before
  changing extension behavior.
- **Subagents** — child sessions, stop/completion races, result bounding. The
  stub provider could serve child sessions, but that path is untested here.
- **LSP** — server start/retry and diagnostics confidence need a real language
  server on `PATH`.
- **Network lifecycle** — `web_fetch`/`web_search` timeouts, cancellation, cleanup:
  these runs never reach the network.
- **Project configuration** — project `.pi/settings.json`, `AGENTS.md`, skills and
  prompt templates are disabled in these runs, so configuration precedence and
  trust paths are not exercised.
- **Other Pi versions / platforms** — only the recorded version was exercised.

No lifecycle defect is claimed from missing coverage; only from smoke evidence.

## Extending

- Add a scenario to `scenarios.ts` (`id`, `title`, `extensions`, optional
  `reuseSession`, and per-invocation `prompt`, `responses`, `expectations`).
- Expectation kinds: `exit`, `event`, `eventOrder`, `probe`, `requestTools`,
  `requestRoles`, `stderrExcludes`, `toolResult` (see `evaluate.ts`).
- Add an event to `EVENTS` in `probe.ts` when the next investigation needs one.
- Record what the run actually produced (`--keep`, then read
  `probe-events.jsonl` and `sessions/*.jsonl`) before writing assertions; keep
  expected values independent of the implementation under test.
- Stub responses are streaming `openai-completions` chunks; extend
  `stub-provider.ts` for new shapes (errors, usage, thinking) rather than
  special-casing Pi.