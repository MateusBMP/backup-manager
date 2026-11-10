import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { ConfirmOptions, Toast } from "../context.js";
import type { Theme } from "../theme.js";

export function Modal({
  theme,
  width,
  columns,
  rows,
  title,
  children,
  danger,
}: {
  theme: Theme;
  width: number;
  columns: number;
  rows: number;
  title: string;
  children: ReactNode;
  danger?: boolean;
}) {
  const w = Math.min(width, columns - 4);
  return (
    <Box
      position="absolute"
      top={Math.max(1, Math.floor(rows / 4))}
      left={Math.max(0, Math.floor((columns - w) / 2))}
      width={w}
    >
      <Box
        borderStyle="double"
        borderColor={danger ? theme.error : theme.accent}
        flexDirection="column"
        paddingX={2}
        paddingY={0}
        width={w}
        backgroundColor={theme.color ? "#0f172a" : undefined}
      >
        <Text bold color={danger ? theme.error : theme.accent}>
          {title}
        </Text>
        {children}
      </Box>
    </Box>
  );
}

export function ConfirmBody({
  theme,
  options,
  choice,
}: {
  theme: Theme;
  options: ConfirmOptions;
  choice: boolean;
}) {
  return (
    <Box flexDirection="column">
      <Box marginY={1}>
        <Text>{options.message}</Text>
      </Box>
      <Box gap={2}>
        <Text inverse={choice} color={options.danger ? theme.error : theme.accent}>
          {` ${options.confirmLabel ?? "Yes"} `}
        </Text>
        <Text inverse={!choice}> Cancel </Text>
        <Text color={theme.muted}>y/n · ←→ · ⏎</Text>
      </Box>
    </Box>
  );
}

const HELP: [string, string][] = [
  ["↑↓ / j k", "move in lists"],
  ["g G · Home End", "first / last"],
  ["PgUp PgDn", "page"],
  ["⏎", "open / select"],
  ["Esc", "back"],
  ["Ctrl/Alt + ← → ↓", "zones: sidebar · content · buttons (↑ back)"],
  ["←→ ⏎ (buttons)", "pick and press a button: save, add, run…"],
  ["Tab", "switch sidebar / content (next field in forms)"],
  ["1–9", "jump to a menu entry"],
  ["n · e · s", "new backup · environments · service"],
  ["Ctrl-S", "save a form (or its save button)"],
  ["?", "this help"],
  ["q", "quit (jobs keep running)"],
];

export function HelpBody({ theme }: { theme: Theme }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {HELP.map(([key, label]) => (
        <Box key={key}>
          <Box width={18}>
            <Text color={theme.accent} bold>
              {key}
            </Text>
          </Box>
          <Text>{label}</Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text color={theme.muted}>
          Backups started here run detached: closing the UI or SSH does not stop them.
        </Text>
      </Box>
      <Text color={theme.muted}>press any key to close</Text>
    </Box>
  );
}

export function Toasts({ theme, toasts, now }: { theme: Theme; toasts: Toast[]; now: number }) {
  if (toasts.length === 0) return null;
  const color = {
    info: theme.info,
    success: theme.success,
    warning: theme.warning,
    error: theme.error,
  };
  const icon = { info: "ℹ", success: "✔", warning: "⚠", error: "✘" };
  return (
    <Box position="absolute" bottom={1} right={1} flexDirection="column" alignItems="flex-end">
      {toasts.map((t) => (
        <Box key={t.id} borderStyle="round" borderColor={color[t.kind]} paddingX={1}>
          <Text color={color[t.kind]} dimColor={now - t.createdAt > 2400}>
            {`${icon[t.kind]} ${t.text}`}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

export function TooSmall({
  theme,
  columns,
  rows,
}: {
  theme: Theme;
  columns: number;
  rows: number;
}) {
  return (
    <Box
      flexDirection="column"
      width={columns}
      height={rows}
      alignItems="center"
      justifyContent="center"
    >
      <Text color={theme.warning}>Terminal too small</Text>
      <Text color={theme.muted}>{`${columns}×${rows} — needs at least 60×16`}</Text>
      <Text color={theme.muted}>resize, or press q to quit</Text>
    </Box>
  );
}
