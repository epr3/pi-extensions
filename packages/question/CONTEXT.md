# Pi Extensions — question

Domain language for the `packages/question` Extension package. Terms are opinionated, one sentence each; aliases under `_Avoid_`. New terms are lazy-added on first use.

## Language

**Question Extension package**: Runnable Pi `ExtensionAPI` module under `packages/question` whose default export registers the structured `question` tool.
_Avoid_: Question package, prompt plugin, ask-user extension.

**Structured question**: Prompt with a header, question text, short preset options, an automatic free-prose escape hatch, optional recommendation, and optional multi-select behavior.
_Avoid_: Confirmation prompt, plain prose ask.

**Free prose answer**: User-authored text collected under a bounded editor title when preset options are too narrow for the decision being asked.
_Avoid_: Other option, custom choice.

**Recommended option**: Option marked as the suggested answer so agent workflows can present a default while leaving the user in control.
_Avoid_: Default value, selected choice.

**Non-interactive fallback**: Text response emitted when Pi cannot show interactive UI, preserving the question for callers instead of blocking.
_Avoid_: CLI mode, headless error.

**Display budget**: The terminal-space limit a **Structured question** must fit by bounding prompt and option rendering instead of expanding past the visible UI.
_Avoid_: Available display, screen size, terminal height.

**Bounded question dialog**: Interactive **Structured question** renderer that keeps long question text and selected-answer summaries within a **Display budget** while showing every preset-option label in full through wrapping and selection-aware scrolling.
_Avoid_: Custom select, better picker, overflow fix.

**Scrollable option label**: A wrapped preset-option label whose lines scroll with Up/Down until its boundary, where navigation continues to the adjacent option.
_Avoid_: Truncated answer, expanded option.

## Relationships

- **Question Extension package** registers one `question` tool.
- **Structured question** contains two to four preset options plus one automatic **Free prose answer** escape hatch.
- **Recommended option** is advice, not an automatic answer.
- **Non-interactive fallback** preserves the **Structured question** as text.
- **Bounded question dialog** presents a **Structured question** within a **Display budget**.
- **Bounded question dialog** is verified by tests that bound rendered line count and line width for oversized **Structured question** inputs.
- **Bounded question dialog** may truncate displayed question text, but it renders every **Scrollable option label** in full and keeps every preset answer and the **Free prose answer** selectable.
- **Free prose answer** collection uses a short bounded title derived from the **Structured question** rather than the full prompt text.
- Multi-select **Structured question** rendering uses a count-only selected-answer summary instead of appending selected labels to the dialog title.

## Example dialogue

> **Dev:** "Can the skill ask three design choices at once?"
> **Domain expert:** "No — ask one **Structured question** at a time and mark a **Recommended option**."

## Flagged ambiguities

- "question" previously meant any prose ask; resolved: **Structured question** means the tool-backed interaction with preset options and **Free prose answer** fallback.
- "default" implied automatic selection; resolved: use **Recommended option** because the user still chooses.
- "2-4 options" could read as soft guidance; resolved: a **Structured question** has a hard two-to-four preset-option contract, plus the automatic **Free prose answer**.
- "available display" was fuzzy; resolved: use **Display budget** for the terminal-space constraint and **Bounded question dialog** for the package-owned overflow-safe renderer.
- Long prompt overflow could be handled by scrolling all content, truncating all content, or keeping answers accessible; resolved: cap displayed prompt text and keep answers selectable through scrolling.
- Free-prose collection could reuse the full prompt as editor title; resolved: use a short bounded title so choosing **Free prose answer** cannot reintroduce the same display overflow.
- Flicker could be accepted only by manual repro, terminal snapshots, or component invariants; resolved: first prove the **Bounded question dialog** with tests that bound rendered line count and line width.
- Multi-select chosen labels could remain unbounded in the title, be hidden, or be summarized; resolved: show a count-only summary so no selected label is partially displayed and long labels cannot exceed the **Display budget**.
- Long preset answers could be truncated, shown in an unbounded dialog, or wrapped within the **Display budget**; resolved: use **Scrollable option label** rendering, with Up/Down scrolling label lines before moving to the adjacent option at its boundary.