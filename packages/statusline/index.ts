import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classify, meter, human, configFromEnv, ZONE_COLOR, ZONE_GLYPH, ZONE_DEFAULTS } from "./zone.ts";
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
 *   checkout-service │ ⎇ feat/login │ ◑ RISKY ██████▋░░░ 65% eff · 130k/200k · 33% nom
 *   └─ dim ─────────────────────────┘ └ zone color ──┘└dim┘└zone┘ └─────── dim ───────┘
 *
 * The circle glyph shows *remaining* effective headroom (● → ◕ → ◑ → ◔); the
 * meter fills with eighth-block resolution over a dim track.
 */


// Settings: this extension reads its own top-level "statusline" key from Pi's
// settings files (global then project; project wins), inline and self-contained
// — no shared loader. Env vars override on top.
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
const config = configFromEnv(process.env, {
  effectiveLimit: Number(raw.effectiveLimit) > 0 ? Number(raw.effectiveLimit) : ZONE_DEFAULTS.effectiveLimit,
  thresholds: { ...ZONE_DEFAULTS.thresholds, ...raw.thresholds },
});
const meterWidth = Math.max(4, Math.floor(Number(raw.meterWidth) > 0 ? Number(raw.meterWidth) : 10));

function basename(p: string | undefined): string {
  if (!p) return "";
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] ?? "";
}

const pct = (f: number) => `${Math.round(f * 100)}%`;

export default function (pi: ExtensionAPI) {
  let branch = "";

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
      segments.push(dim("○ awaiting context"));
      ctx.ui.setStatus("dumb-zone", segments.join(sep));
      return;
    }

    const { zone, fracEff, fracNom } = classify(usage.tokens, window, config);
    const zoned = (t: string) => theme.fg(ZONE_COLOR[zone], t);
    const m = meter(fracEff, meterWidth);

    segments.push(
      zoned(`${ZONE_GLYPH[zone]} ${zone.toUpperCase()}`) +
        ` ${zoned(m.filled)}${dim(m.track)} ` +
        zoned(pct(fracEff)) +
        dim(` eff · ${human(usage.tokens)}/${human(window)} · ${pct(fracNom)} nom`),
    );

    ctx.ui.setStatus("dumb-zone", segments.join(sep));
  }

  pi.on("session_start", async (_event, ctx) => {
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
