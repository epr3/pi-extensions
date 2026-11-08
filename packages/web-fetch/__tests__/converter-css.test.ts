import { describe, expect, it, vi } from "vitest";
import { convertHtmlToMarkdown } from "../converter.ts";

describe("HTML conversion stylesheet diagnostics", () => {
  it("does not emit CSS parsing errors for discarded styles", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = convertHtmlToMarkdown(
        "<html><head><style>}</style></head><body><p>Readable content</p></body></html>",
        "https://example.com/",
      );
      expect(result.markdown).toContain("Readable content");
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});