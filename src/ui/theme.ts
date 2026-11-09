/** Design tokens shared by the full-screen UI and the printed CLI output. */
const noColor = (env: NodeJS.ProcessEnv = process.env) => "NO_COLOR" in env && env.NO_COLOR !== "0";

export interface Theme {
  color: boolean;
  accent: string | undefined;
  accentAlt: string | undefined;
  success: string | undefined;
  warning: string | undefined;
  error: string | undefined;
  info: string | undefined;
  muted: string | undefined;
  border: string | undefined;
  focus: string | undefined;
  selection: string | undefined;
  /** Colors for the title gradient (cyan → magenta). */
  gradient: string[];
}

export function makeTheme(color = !noColor()): Theme {
  const c = (value: string) => (color ? value : undefined);
  return {
    color,
    accent: c("#22d3ee"),
    accentAlt: c("#d946ef"),
    success: c("#4ade80"),
    warning: c("#facc15"),
    error: c("#f87171"),
    info: c("#60a5fa"),
    muted: c("gray"),
    border: c("#475569"),
    focus: c("#22d3ee"),
    selection: c("#1e293b"),
    gradient: ["#22d3ee", "#818cf8", "#d946ef"],
  };
}

export const theme = makeTheme();

export const ICONS = {
  ok: "✔",
  warn: "!",
  fail: "✘",
  running: "●",
  schedule: "⏱",
  bullet: "•",
  pointer: "❯",
} as const;

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function statusColor(t: Theme, status: string): string | undefined {
  switch (status) {
    case "ok":
    case "success":
    case "complete":
    case "active":
      return t.success;
    case "warn":
    case "partial":
    case "queued":
    case "activating":
    case "reloading":
      return t.warning;
    case "fail":
    case "failed":
    case "incomplete":
      return t.error;
    case "running":
      return t.info;
    default:
      return t.muted;
  }
}

export function statusIcon(status: string): string {
  switch (status) {
    case "ok":
    case "success":
    case "complete":
      return ICONS.ok;
    case "warn":
    case "partial":
      return "⚠";
    case "fail":
    case "failed":
    case "incomplete":
      return ICONS.fail;
    case "running":
      return ICONS.running;
    case "queued":
      return "…";
    default:
      return "·";
  }
}
