import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

/**
 * Terminal presentation for a Subagent run. The renderer is deliberately a
 * thin box around ordinary themed lines: identity in the top border, status
 * and activity/result in the body. It is split into a top and a body so a Pi
 * tool row can render the call (top) and its streaming/final result (body)
 * without drawing two separate boxes.
 */

function topBorder(theme: Theme, title: string, width: number): string {
  const inner = Math.max(1, width - 2);
  if (width < 5) return truncateToWidth(`╭${"─".repeat(inner)}╮`, width);
  const maxTitle = Math.max(0, inner - 2);
  const fitted = truncateToWidth(` ${title} `, maxTitle);
  const fill = Math.max(0, inner - 1 - visibleWidth(fitted));
  return (
    theme.fg("borderAccent", "╭") +
    theme.fg("border", "─") +
    fitted +
    theme.fg("border", "─".repeat(fill)) +
    theme.fg("borderAccent", "╮")
  );
}

function bottomBorder(theme: Theme, width: number): string {
  const inner = Math.max(1, width - 2);
  return (
    theme.fg("borderAccent", "╰") +
    theme.fg("border", "─".repeat(inner)) +
    theme.fg("borderAccent", "╯")
  );
}

function contentLine(theme: Theme, line: string, width: number): string {
  const inner = Math.max(1, width - 2);
  const contentWidth = Math.max(1, inner - 2);
  if (width < 5) return truncateToWidth(line, width);
  const pad = Math.max(0, contentWidth - visibleWidth(line));
  return theme.fg("border", "│") + " " + line + " ".repeat(pad) + " " + theme.fg("border", "│");
}

function wrapBody(body: string, width: number): string[] {
  const contentWidth = Math.max(1, Math.max(1, width - 2) - 2);
  return new Text(body, 0, 0).render(contentWidth);
}

/** The call half of a tool row: a titled top border only. */
export class SubagentCardTop implements Component {
  constructor(
    private readonly theme: Theme,
    private readonly title: string,
    private readonly header?: string,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const top = topBorder(this.theme, this.title, width);
    if (!this.header) return [top];
    return [
      top,
      ...wrapBody(this.header, width).map((line) => contentLine(this.theme, line, width)),
    ];
  }
}

/** The result half of a tool row: framed body lines plus the closing border. */
export class SubagentCardBody implements Component {
  constructor(
    private readonly theme: Theme,
    private readonly body: string,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    return [
      ...wrapBody(this.body, width).map((line) => contentLine(this.theme, line, width)),
      bottomBorder(this.theme, width),
    ];
  }
}

/** A complete card, used for standalone custom messages. */
export class SubagentCard implements Component {
  private readonly top: SubagentCardTop;
  private readonly body: SubagentCardBody;

  constructor(theme: Theme, title: string, body: string) {
    this.top = new SubagentCardTop(theme, title);
    this.body = new SubagentCardBody(theme, body);
  }

  invalidate(): void {
    this.top.invalidate();
    this.body.invalidate();
  }

  render(width: number): string[] {
    return [...this.top.render(width), ...this.body.render(width)];
  }
}