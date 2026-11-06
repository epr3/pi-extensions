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

**Scrollable option label**: A wrapped preset-option label whose complete text remains available within the **Display budget**.
_Avoid_: Truncated answer, expanded option.

**Focused preset option**: The one preset option receiving keyboard navigation and confirmation, distinct from options already chosen in a multi-select **Structured question**.
_Avoid_: Selected option, current row.

**Question confirmation**: The deliberate act of submitting a **Structured question** — Done in multi-select, the focused answer item otherwise — and the only way an answer is returned.
_Avoid_: Answer, submit, accept.

**Question cancellation**: Ending a **Structured question** without confirming, discarding any partial multi-selection and **Free prose answer** collected so far instead of returning them as an answer.
_Avoid_: Dismissal, partial answer, timeout.

**Question abort**: Pi-level interruption of a running **Structured question** that ends the interaction with a cancellation error rather than an answer.
_Avoid_: Failed question, broken dialog.

**Option identity**: The opaque token a **Bounded question dialog** reports for the answer item the user confirmed, so a selection maps back to its preset option or control without parsing formatted display text.
_Avoid_: Option value, display string, option index.

## Relationships

- **Question Extension package** registers one `question` tool.
- **Question confirmation** is the only source of a returned answer; **Question cancellation** never returns a partial selection, and **Question abort** returns an error instead of an answer.
- **Question cancellation** and **Question abort** both release the widget and terminal input handler they used, so a later **Structured question** stays usable.
- **Structured question** contains two to four preset options plus one automatic **Free prose answer** escape hatch.
- **Recommended option** is advice, not an automatic answer.
- **Non-interactive fallback** preserves the **Structured question** as text.
- **Bounded question dialog** presents a **Structured question** within a **Display budget**.
- **Bounded question dialog** is verified by tests that bound rendered line count and line width for oversized **Structured question** inputs.
- **Bounded question dialog** may truncate displayed question text, but it renders every **Scrollable option label** in full and keeps every preset answer and the **Free prose answer** selectable.
- **Free prose answer** collection uses a short bounded title derived from the **Structured question** rather than the full prompt text; a supplied header is a **Structured question** header, not an exemption, so an oversized one is capped the same way.
- Multi-select **Structured question** rendering uses a count-only selected-answer summary instead of appending selected labels to the dialog title.
- **Structured question** preset options have distinct labels; duplicate labels are rejected as an actionable error, while distinct labels whose formatted displays collide stay selectable because **Bounded question dialog** reports **Option identity**.

## Example dialogue

> **Dev:** "Can the skill ask three design choices at once?"
> **Domain expert:** "No — ask one **Structured question** at a time and mark a **Recommended option**."

## Flagged ambiguities

- Escape could confirm partial multi-selections, discard them, or be refused; resolved: only **Question confirmation** returns an answer, so Escape is a **Question cancellation** that discards partial selections and free prose (an intentional compatibility change).
- A **Question abort** could return an empty answer, hang, or fail; resolved: it cleans up and ends with a cancellation error, because an unconfirmed answer is indistinguishable from a confirmed one.

- "question" previously meant any prose ask; resolved: **Structured question** means the tool-backed interaction with preset options and **Free prose answer** fallback.
- "default" implied automatic selection; resolved: use **Recommended option** because the user still chooses.
- "2-4 options" could read as soft guidance; resolved: a **Structured question** has a hard two-to-four preset-option contract, plus the automatic **Free prose answer**.
- "available display" was fuzzy; resolved: use **Display budget** for the terminal-space constraint and **Bounded question dialog** for the package-owned overflow-safe renderer.
- Long prompt overflow could be handled by scrolling all content, truncating all content, or keeping answers accessible; resolved: cap displayed prompt text and keep answers selectable through scrolling.
- Answers could be recognized by their formatted display string or by an item token; resolved: use **Option identity** so colliding displays and control text cannot be confused with each other.
- Duplicate preset labels could be accepted, silently deduplicated, or rejected; resolved: reject them with an actionable error, accepting the compatibility break for previously accepted inputs.
- Free-prose collection could reuse the full prompt as editor title; resolved: use a short bounded title so choosing **Free prose answer** cannot reintroduce the same display overflow. A caller-supplied header is bounded too — a long one cannot bypass the **Display budget**.
- Header and option rows could compete for the same **Display budget** by assuming the header occupies its budget at some other width; resolved: the **Bounded question dialog** measures header and summary lines at the render width and gives only the remaining lines to the option viewport, so the focused answer stays visible.
- Flicker could be accepted only by manual repro, terminal snapshots, or component invariants; resolved: first prove the **Bounded question dialog** with tests that bound rendered line count and line width.
- Multi-select chosen labels could remain unbounded in the title, be hidden, or be summarized; resolved: show a count-only summary so no selected label is partially displayed and long labels cannot exceed the **Display budget**.
- Long preset answers could be truncated, shown in an unbounded dialog, or wrapped within the **Display budget**; resolved: use **Scrollable option label** rendering, with Up/Down scrolling label lines before moving to the adjacent option at its boundary.