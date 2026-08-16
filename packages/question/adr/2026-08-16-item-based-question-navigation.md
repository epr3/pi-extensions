---
status: accepted
---

# Navigate questions as items, not wrapped rows

The **Bounded question dialog** uses Up/Down to move the **Focused preset option** (or another selectable answer item) exactly once per keypress, regardless of its wrapped height. PageUp/PageDown explicitly scroll the focused **Scrollable option label** within the **Display budget**, preventing label wrapping from changing navigation cost; returning to an option starts at its first line. In multi-select, focus stays on a toggled option after redraw, while a submitted **Free prose answer** returns focus to Done. This supersedes the Up/Down row-scrolling policy in [2026-08-12-scrollable-option-labels](2026-08-12-scrollable-option-labels.md).