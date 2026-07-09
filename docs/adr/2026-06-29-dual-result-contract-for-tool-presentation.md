# Use a Dual Result Contract for Tool Presentation

Tool UX improvements should keep each tool's plain-text `content` stable as the model-readable contract while adding structured `details` where user-facing renderers or session state need richer data. This rejects text-only rendering because packages like `lsp` and `todo` would keep reparsing display strings, and rejects details-first output because it would make existing model/tool-call behavior brittle; the trade-off is a small amount of duplicated text-plus-data shaping inside each package.
