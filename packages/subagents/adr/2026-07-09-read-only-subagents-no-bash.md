# Keep Read-Only Subagents Off Bash

Read-only `explore` subagents get no `bash`, even for search. Dedicated read/search/list tools (`read`, `grep`, `find`, `ls` plus granted read-only extras) enforce the read-only boundary. Shell allowlist revisitable later if Pi SDK exposes safe wrapper.

(Updated 2026-11-01: the `plan` type named in the original text was never shipped — the package's only read-only built-in is `explore`.)