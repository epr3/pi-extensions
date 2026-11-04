import type { Theme } from "@earendil-works/pi-coding-agent";
import { ScrollView, Text } from "@earendil-works/pi-tui";
import type { AgentRecord } from "./manager.ts";
import { reconstructBranchRuns } from "./outcome-records.ts";
import { buildOverviewRows, overviewRowLine, type OverviewRow } from "./overview-rows.ts";

/**
 * The `/subagents` overlay component — the read-only **Subagent overview**.
 *
 * Renders as a floating overlay without touching the conversation: the
 * overview complements the Compact run rows, the Launch receipts, and the
 * Attributed completions and never redelivers or mutates anything.
 *
 * The component wraps its rows in a ScrollView so the TUI layout clips and
 * scrolls long lists; input handling maps the app's select keybindings to
 * viewport scrolling and dismisses on cancel/confirm (Esc/Enter) via the
 * injected `done()`.
 */

/** Everything the overlay needs from the `ctx.ui.custom` factory arguments. */
export interface SubagentsOverviewDeps {
  theme: Theme;
  keybindings: { matches(data: string, keybinding: string): boolean };
  /** The custom component's own TUI handle — re-render after view changes. */
  requestRender: () => void;
  /** Dismisses the overlay; the overview resolves without a selection value. */
  done: () => void;
  /** The rows to show; replaceable while open (live updates). */
  rows: readonly OverviewRow[];
}

export class SubagentsOverview extends ScrollView {
  private readonly body: Text;
  private readonly deps: SubagentsOverviewDeps;

  constructor(deps: SubagentsOverviewDeps) {
    const body = new Text("", 1, 0);
    super(body, { primary: true, scrollbar: "auto" });
    this.body = body;
    this.deps = deps;
    this.setRows(deps.rows);
  }

  /** Replace the rows and rebuild the visible content. Live-update seam: a
   *  new run state can refresh an open overview without reopening it. */
  setRows(rows: readonly OverviewRow[]): void {
    this.deps.rows = rows;
    const lines = this.lines(rows);
    this.body.setText(lines.join("\n"));
    // The rows changed underneath the open component: ask the TUI to draw it
    // again, the same way scrolling does.
    this.deps.requestRender();
  }

  /** The user-visible content lines: header, rows or explicit empty state. */
  private lines(rows: readonly OverviewRow[]): string[] {
    return [
      "Subagent overview",
      ...(rows.length ? rows.map(overviewRowLine) : ["No Subagent runs to show."]),
    ];
  }

  handleInput(data: string): void {
    const kb = this.deps.keybindings;
    if (kb.matches(data, "tui.select.cancel") || kb.matches(data, "tui.select.confirm")) {
      // Read-only overview: both Esc and Enter simply dismiss.
      this.deps.done();
      return;
    }
    const page = Math.max(1, this.viewportHeight - 1);
    if (kb.matches(data, "tui.select.up")) {
      this.scrollBy(-1);
      this.deps.requestRender();
      return;
    }
    if (kb.matches(data, "tui.select.down")) {
      this.scrollBy(1);
      this.deps.requestRender();
      return;
    }
    if (kb.matches(data, "tui.select.pageUp")) {
      this.scrollBy(-page);
      this.deps.requestRender();
      return;
    }
    if (kb.matches(data, "tui.select.pageDown")) {
      this.scrollBy(page);
      this.deps.requestRender();
      return;
    }
  }

  invalidate(): void {
    this.body.invalidate();
  }
}

/**
 * What an overview updater needs from the `/subagents` command context —
 * the same structural-typing pattern the ActiveRunFooter uses for the footer:
 * enough of the command context to open the overlay and to re-read the
 * current branch's history when rows are rebuilt.
 */
export interface OverviewUIContext {
  sessionManager: { getBranch(): readonly unknown[] };
  ui: {
    custom<TResult>(
      factory: (
        tui: { requestRender(): void },
        theme: Theme,
        keybindings: { matches(data: string, keybinding: string): boolean },
        done: (result: TResult) => void,
      ) => unknown,
      options?: { overlay?: boolean; overlayOptions?: unknown },
    ): Promise<TResult>;
  };
}

/** The piece of an open overview a live update re-renders through. */
interface OverviewHandle {
  setRows(rows: readonly OverviewRow[]): void;
}

/**
 * Owner of this session's open Subagent overview. The `/subagents` command
 * opens it through a context and registers it here; after that, run lifecycle
 * events (the same transitions the footer re-renders on) rebuild the rows —
 * live current-session runs over the current branch's history, re-read so an
 * outcome persisted while the overview is open is picked up when rows are
 * next rebuilt. Updates are keyed to the owning session: deactivated at
 * session shutdown/replacement before the dying session's runs settle, so no
 * stale update can appear in the overview or pass to a successor context.
 */
export class SubagentsOverviewUpdater {
  private handle?: OverviewHandle;
  private getBranch?: () => readonly unknown[];
  private closed = false;

  /**
   * Open the overview through the given command context (TUI overlay, the
   * same presentation as before) and track it: later run lifecycle events
   * refresh the rows of this open component.
   */
  async open(ctx: OverviewUIContext, runs: readonly AgentRecord[]): Promise<void> {
    if (this.closed) return;
    this.getBranch = () => ctx.sessionManager.getBranch();
    const initialRows = () => buildOverviewRows(runs, this.branchViews());
    await ctx.ui.custom<void>(
      (tui, theme, keybindings, done) => {
        const component = new SubagentsOverview({
          theme,
          keybindings,
          requestRender: () => tui.requestRender(),
          done: () => {
            // Dismissed: later run events have nothing to refresh.
            this.handle = undefined;
            this.getBranch = undefined;
            done(undefined);
          },
          rows: initialRows(),
        });
        this.handle = component;
        return component;
      },
      { overlay: true, overlayOptions: { anchor: "center", width: "70%", maxHeight: "60%" } },
    );
  }

  /**
   * Re-render the open overview from current run state plus the branch's
   * history (re-read, so outcomes persisted since the last rebuild join the
   * rows — deduped by run id so a live run is never shown twice). No-op when
   * no overview is open for this session.
   */
  refresh(runs: readonly AgentRecord[]): void {
    if (this.closed) return;
    this.handle?.setRows(buildOverviewRows(runs, this.branchViews()));
  }

  /**
   * Session shutdown or replacement: this session's open overview stops
   * updating here — before the dying session's runs are settled, so none of
   * their transition events reach this overview and nothing passes to a
   * successor context (the next session opens and tracks its own).
   */
  deactivate(): void {
    this.closed = true;
    this.handle = undefined;
    this.getBranch = undefined;
  }

  /** Available reconstructed current-branch history for row building. */
  private branchViews() {
    return reconstructBranchRuns((this.getBranch?.() ?? []) as Parameters<
      typeof reconstructBranchRuns
    >[0]);
  }
}