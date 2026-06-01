/**
 * Session naming example.
 *
 * Shows setSessionName/getSessionName to give sessions friendly names
 * that appear in the session selector instead of the first message.
 *
 * Usage: /session-name [name] - set or show session name
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("session-name", {
    description: "Set or show session name (usage: /session-name [new name])",
    handler: async (args, ctx) => {
      const name = args.trim();

      if (name) {
        pi.setSessionName(name);
        if (ctx.hasUI) {
          ctx.ui.notify(`Session named: ${name}`, "info");
        } else {
          console.log(`Session named: ${name}`);
        }
      } else {
        const current = pi.getSessionName();
        const message = current ? `Session: ${current}` : "No session name set";
        if (ctx.hasUI) {
          ctx.ui.notify(message, "info");
        } else {
          console.log(message);
        }
      }
    },
  });
}