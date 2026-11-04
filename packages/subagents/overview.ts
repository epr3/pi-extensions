import type { Theme } from "@earendil-works/pi-coding-agent";
import { ScrollView, Text } from "@earendil-works/pi-tui";
import { overviewRowLine, type OverviewRow } from "./overview-rows.ts";

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
  }

  /** The user-visible content lines: header, rows or explicit empty state. */
  private lines(rows: readonly OverviewRow[]): string[] {
    return ["Subagent overview", ...(rows.length ? rows.map(overviewRowLine) : ["No Subagent runs to show."])];
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
