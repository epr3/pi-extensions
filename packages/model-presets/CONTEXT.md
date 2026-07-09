# Model Presets

The Pi extension package that lets users switch provider, model id, and thinking level as one intentional preset.

## Language

**Atomic model preset**: A user-selectable model choice that binds provider, model id, and thinking level into one switch operation.
_Avoid_: Model selector entry, enabled model, profile.

**Model preset catalog**: The `modelPresets` settings object owned by this package that stores **Atomic model presets** as a keyed `presets` object plus an explicit `cycle` order.
_Avoid_: Presets file, enabledModels, model list.

**Preset thinking repair**: Behavior that reapplies an **Atomic model preset** thinking level after a raw Pi model selection matches that preset's provider and model id.
_Avoid_: Thinking fallback, clamp fix, auto restore.

**Coding preset set**: Initial **Model preset catalog** example optimized for coding workflows with current default, fast Codex, broad fallback, and deep-reasoning alternatives.
_Avoid_: Balanced presets, default cycle, model list.

## Relationships

- A **Model preset catalog** contains one or more **Atomic model presets**.
- **Preset thinking repair** applies only when a raw Pi model selection matches an explicit **Atomic model preset**.
- The **Coding preset set** is an example **Model preset catalog**, not hardcoded package behavior.

## Example dialogue

> **Dev:** "Can we just add a model id to enabledModels and keep thinking separate?"
> **Domain expert:** "No — an **Atomic model preset** is the unit users cycle through, so thinking level travels with the model choice."

## Flagged ambiguities

- "model selector package" could mean patching Pi's raw model cycle, config-only `enabledModels`, or a broader mode profile system; resolved: create a `model-presets` Extension package centered on **Atomic model presets**.
- "fix sticky thinking" could mean changing all raw model selections or only preset flows; resolved: **Preset thinking repair** applies only when a raw Pi model selection matches an explicit **Atomic model preset**.
- **Model preset catalog** could be a single ordered array or a merge-friendly map; resolved: use a keyed `presets` object plus explicit `cycle` array.
