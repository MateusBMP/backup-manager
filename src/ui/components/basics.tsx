import { Box, Text, useAnimation } from "ink";
import Gradient from "ink-gradient";
import type { ReactNode } from "react";
import { useApp } from "../context.js";
import { SPINNER, statusColor, statusIcon } from "../theme.js";

export function Spinner({ label, color }: { label?: string; color?: string }) {
  const { theme } = useApp();
  const { frame } = useAnimation({ interval: 80 });
  return (
    <Text>
      <Text color={color ?? theme.accent}>{SPINNER[frame % SPINNER.length]}</Text>
      {label ? ` ${label}` : ""}
    </Text>
  );
}

/** A dot that pulses while something runs. */
export function Pulse({ color }: { color?: string }) {
  const { theme } = useApp();
  const { frame } = useAnimation({ interval: 400 });
  return <Text color={color ?? theme.info}>{frame % 2 === 0 ? "●" : "○"}</Text>;
}

export function GradientText({ children }: { children: string }) {
  const { theme } = useApp();
  if (!theme.color) return <Text bold>{children}</Text>;
  return (
    <Gradient colors={theme.gradient}>
      <Text bold>{children}</Text>
    </Gradient>
  );
}

export function StatusText({ status, label }: { status: string; label?: string }) {
  const { theme } = useApp();
  return (
    <Text color={statusColor(theme, status)}>{`${statusIcon(status)} ${label ?? status}`}</Text>
  );
}

export function Badge({ children, color }: { children: string; color?: string }) {
  const { theme } = useApp();
  if (!theme.color) return <Text>[{children}]</Text>;
  return (
    <Text backgroundColor={color ?? theme.accent} color="black">
      {` ${children} `}
    </Text>
  );
}

export function ProgressBar({
  value,
  width,
  color,
}: {
  value: number;
  width: number;
  color?: string;
}) {
  const { theme } = useApp();
  const ratio = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const filled = Math.round(ratio * width);
  return (
    <Text>
      <Text color={color ?? theme.accent}>{"█".repeat(filled)}</Text>
      <Text color={theme.muted}>{"░".repeat(Math.max(0, width - filled))}</Text>
    </Text>
  );
}

/** Rounded panel with the title drawn into the top border. */
export function Panel({
  title,
  width,
  height,
  focused = false,
  right,
  children,
  flexGrow,
}: {
  title: string;
  width: number;
  height?: number;
  focused?: boolean;
  right?: string;
  children: ReactNode;
  flexGrow?: number;
}) {
  const { theme } = useApp();
  const color = focused ? theme.focus : theme.border;
  const label = ` ${title} `;
  const extra = right ? ` ${right} ` : "";
  const fill = Math.max(0, width - 3 - label.length - extra.length - 1);
  return (
    <Box flexDirection="column" width={width} height={height} flexGrow={flexGrow} flexShrink={0}>
      <Text wrap="truncate-end">
        <Text color={color}>╭─</Text>
        <Text bold color={focused ? theme.accent : undefined}>
          {label}
        </Text>
        <Text color={color}>{"─".repeat(fill)}</Text>
        <Text color={theme.muted}>{extra}</Text>
        <Text color={color}>─╮</Text>
      </Text>
      <Box
        borderStyle="round"
        borderTop={false}
        borderColor={color}
        paddingX={1}
        flexDirection="column"
        flexGrow={1}
        width={width}
        overflow="hidden"
      >
        {children}
      </Box>
    </Box>
  );
}

export function KeyHints({ hints }: { hints: { key: string; label: string }[] }) {
  const { theme } = useApp();
  return (
    <Text wrap="truncate-end">
      {hints.map((h, i) => (
        <Text key={`${h.key}-${h.label}`}>
          {i > 0 ? "  " : " "}
          <Text color={theme.accent} bold>
            {h.key}
          </Text>
          <Text color={theme.muted}>{` ${h.label}`}</Text>
        </Text>
      ))}
    </Text>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  const { theme } = useApp();
  return <Text color={theme.muted}>{children}</Text>;
}

/** One line that teaches the button bar where Ctrl-S may not reach (Termius, XOFF). */
export function FormTip() {
  return <Muted>Ctrl+↓ (or Alt+↓) reaches the buttons below; Ctrl-S also saves.</Muted>;
}

export function ErrorLine({ children }: { children: ReactNode }) {
  const { theme } = useApp();
  return <Text color={theme.error}>✘ {children}</Text>;
}

/** Fixed-width cell: pads or truncates so columns line up. */
export function cell(text: string, width: number, align: "left" | "right" = "left"): string {
  if (width <= 0) return "";
  const t = text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
  return align === "right" ? t.padStart(width) : t.padEnd(width);
}
