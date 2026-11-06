---
status: accepted
---

# Identify answers by item, not by display text

The **Bounded question dialog** reports a selection as an opaque item identity: `option:<index>` for the preset option at that position in the `options` array the caller supplied, `freeText` for the **Free prose answer** row, and `done` for the Done completion control. Formatted display text — label plus recommended marker plus description — is never used to recognize an answer. Callers map an identity back through the same `options` array, so a selection cannot be mistaken for a different answer.

This replaces the previous display-string identity, which mapped answers with `options.indexOf(display)` and recognized the Done control by comparing against its display text.

Consequences:

- Distinct labels whose formatted displays collide (for example a label of `A` marked recommended and another label of `A  (recommended)`) stay separately selectable.
- No preset option value can collide with a control, so a preset labelled `✓ Done` toggles as an option instead of finishing a multi-select question.
- Duplicate preset labels are rejected at the tool boundary with an actionable error, since two options would otherwise share `selectedLabels` text and toggle each other in multi-select. This is a compatibility change: previously accepted, and previously ambiguous in the returned `selectedLabels` and result text.
- Returning labels for valid existing inputs is unchanged, so `selectedLabels`, result text, and the dual result contract keep their shape.