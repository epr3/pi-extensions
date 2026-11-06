---
status: accepted
---

# Only Done confirms a multi-select question; Escape discards

The **Bounded question dialog** used to treat a cancelled multi-select dialog exactly like Done, so Escape returned whatever had been toggled so far as if the user had confirmed it. Now only Done is a confirmation: Escape cancels the interaction and discards every preset choice and **Free prose answer** collected so far, returning the same unconfirmed result as an empty Done (`interaction: "none"`, no labels, no free text). The alternative — returning partial selections labelled as partial — was rejected because a partial multi-selection is indistinguishable from a deliberate one at the tool boundary and would have expanded the result contract. Pi-level abort of the run additionally removes the widget and terminal input handler and rejects with a cancellation error instead of hanging or returning an unconfirmed answer.

This is an intentional compatibility change: callers that previously relied on Escape returning partial selections now receive no selection. Callers that need partial progress must press Done.