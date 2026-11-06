import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  classify,
  meter,
  ZONE_COLOR,
  formatStatusSegments,
  AWAITING_CONTEXT_TEXT,
} from "./zone.ts";
import { resolveStatuslineConfig } from "./config.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Dumb-zone status line. Reports where the session sits on the context-
 * degradation cliff, rendered into Pi's footer. All judgement about *where*
 * the cliff is (and the meter math) lives in zone.ts (pure, tested); this file
 * only reads Pi state (usage, window, cwd, git branch) and themes the parts.
 *
 * Anatomy (plain Unicode, no Nerd Font needed):
 *
 *   checkout-service │ ⎇ feat/login │ ◑ RISKY ███████░░░ 70% eff · 140k/400k · 35% nom
 *   └─ dim ─────────────────────────┘ └ zone color ──┘└dim┘└zone┘ └─────── dim ───────┘
 *
 * The circle glyph shows *remaining* effective headroom (● → ◕ → ◑ → ◔); the
 * meter is a contiguous whole-cell bar over a dim track. Percentages before
 * "eff" measure the configurable Effective limit; "nom" measures the model's
 * nominal context window. See README.md for both boundaries.
 */

// Settings: this extension reads its own top-level "statusline" key from Pi's
// settings files (global then project, shallow-merged; project keys win),
// inline and self-contained — no shared loader. Env vars override on top.
function settingsKey(): Record<string, any> {
  const out: Record<string, any> = {};
  for (const f of [
    path.join(homedir(), ".pi", "agent", "settings.json"),
    path.join(process.cwd(), ".pi", "settings.json"),
  ]) {
    try {
      Object.assign(out, JSON.parse(readFileSync(f, "utf8"))["statusline"] ?? {});
    } catch {
      /* missing or malformed file: defaults stand */
    }
  }
  return out;
}

const raw = settingsKey();
const { config, meterWidth, issues: configIssues } = resolveStatuslineConfig(raw, process.env);

function basename(p: string | undefined): string {
  if (!p) return "";
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] ?? "";
}

export default function (pi: ExtensionAPI) {
  let branch = "";

  /** Surface rejected configuration once per session, with the value used instead. */
  function reportConfigIssues(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    for (const issue of configIssues) {
      ctx.ui.notify(`statusline: ${issue.message}`, "warning");
    }
  }

  async function refreshBranch() {
    try {
      const r = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { timeout: 1500 });
      branch = r.code === 0 ? r.stdout.trim() : "";
    } catch {
      branch = "";
    }
  }

  function render(ctx: ExtensionContext) {
    if (!ctx.hasUI) return; // print/json modes have no footer
    const theme = ctx.ui.theme;
    const dim = (t: string) => theme.fg("dim", t);
    const sep = dim(" │ ");

    const segments: string[] = [];
    const folder = basename(ctx.cwd);
    if (folder) segments.push(dim(folder));
    if (branch) segments.push(dim(`⎇ ${branch}`));

    const usage = ctx.getContextUsage();
    const window = ctx.model?.contextWindow ?? 0;

    if (!usage || !usage.tokens || !window) {
      segments.push(dim(AWAITING_CONTEXT_TEXT));
      ctx.ui.setStatus("dumb-zone", segments.join(sep));
      return;
    }

    const { zone, fracEff, fracNom } = classify(usage.tokens, window, config);
    const zoned = (t: string) => theme.fg(ZONE_COLOR[zone], t);
    const m = meter(fracEff, meterWidth);
    const segs = formatStatusSegments(zone, fracEff, fracNom, usage.tokens, window);

    segments.push(
      zoned(segs.glyphAndLabel) +
        ` ${zoned(m.filled)}${dim(m.track)} ` +
        zoned(segs.effPct) +
        dim(` ${segs.usageMeta}`),
    );

    ctx.ui.setStatus("dumb-zone", segments.join(sep));
  }

  pi.on("session_start", async (_event, ctx) => {
    reportConfigIssues(ctx);
    await refreshBranch();
    render(ctx);
  });
  pi.on("turn_end", async (_event, ctx) => render(ctx));
  pi.on("agent_end", async (_event, ctx) => {
    await refreshBranch(); // branch may have changed during the turn
    render(ctx);
  });
  pi.on("model_select", async (_event, ctx) => render(ctx));
  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("dumb-zone", undefined);
  });
}