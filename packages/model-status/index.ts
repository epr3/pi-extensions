import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("model_select", async (event, ctx) => {
    const { model, previousModel, source } = event;

    // Format model identifiers
    const next = `${model.provider}/${model.id}`;
    const prev = previousModel ? `${previousModel.provider}/${previousModel.id}` : "none";

    // Show notification on change
    if (source !== "restore") {
      ctx.ui.notify(`Model: ${next}`, "info");
    }

    // Update status bar with current model
    ctx.ui.setStatus("model", `🤖 ${model.id}`);

    // Log change details (visible in debug output)
    console.log(`[model_select] ${prev} → ${next} (${source})`);
  });
}