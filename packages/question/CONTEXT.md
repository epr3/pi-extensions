# Pi Extensions — question

Domain language for the `packages/question` Extension package. Terms are opinionated, one sentence each; aliases under `_Avoid_`. New terms are lazy-added on first use.

## Language

**Question Extension package**: Runnable Pi `ExtensionAPI` module under `packages/question` whose default export registers the structured `question` tool.
_Avoid_: Question package, prompt plugin, ask-user extension.

**Structured question**: Prompt with a header, question text, short preset options, an automatic free-prose escape hatch, optional recommendation, and optional multi-select behavior.
_Avoid_: Confirmation prompt, plain prose ask.

**Free prose answer**: User-authored text collected when preset options are too narrow for the decision being asked.
_Avoid_: Other option, custom choice.

**Recommended option**: Option marked as the suggested answer so agent workflows can present a default while leaving the user in control.
_Avoid_: Default value, selected choice.

**Non-interactive fallback**: Text response emitted when Pi cannot show interactive UI, preserving the question for callers instead of blocking.
_Avoid_: CLI mode, headless error.

## Relationships

- **Question Extension package** registers one `question` tool.
- **Structured question** contains two to four preset options plus one automatic **Free prose answer** escape hatch.
- **Recommended option** is advice, not an automatic answer.
- **Non-interactive fallback** preserves the **Structured question** as text.

## Example dialogue

> **Dev:** "Can the skill ask three design choices at once?"
> **Domain expert:** "No — ask one **Structured question** at a time and mark a **Recommended option**."

## Flagged ambiguities

- "question" previously meant any prose ask; resolved: **Structured question** means the tool-backed interaction with preset options and **Free prose answer** fallback.
- "default" implied automatic selection; resolved: use **Recommended option** because the user still chooses.
- "2-4 options" could read as soft guidance; resolved: a **Structured question** has a hard two-to-four preset-option contract, plus the automatic **Free prose answer**.
