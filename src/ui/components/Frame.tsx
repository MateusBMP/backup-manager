import { hostname } from "node:os";
import { Box, Text, useAnimation } from "ink";
import type { ReactNode } from "react";
import type { ServiceStatus } from "../../core/service/manager.js";
import type { KeyHint } from "../context.js";
import { MENU } from "../router.js";
import type { Theme } from "../theme.js";
import { GradientText, KeyHints } from "./basics.js";

export const SIDEBAR_WIDTH = 20;
export const WIDE = 90;

function Clock({ theme }: { theme: Theme }) {
  useAnimation({ interval: 1000 });
  const d = new Date();
  return (
    <Text
      color={theme.muted}
    >{`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`}</Text>
  );
}

function serviceLabel(theme: Theme, status: ServiceStatus | null | undefined): ReactNode {
  if (!status) return <Text color={theme.muted}>service …</Text>;
  if (!status.available) return <Text color={theme.muted}>service n/a</Text>;
  if (!status.installed) return <Text color={theme.muted}>service ○ not installed</Text>;
  const active = status.activeState === "active";
  return (
    <Text>
      <Text color={theme.muted}>service </Text>
      <Text color={active ? theme.success : theme.warning}>{active ? "●" : "○"}</Text>
      <Text
        color={theme.muted}
      >{` ${status.activeState}${status.outdated ? " (outdated)" : ""}`}</Text>
    </Text>
  );
}

export function Header({
  theme,
  columns,
  service,
  envCount,
}: {
  theme: Theme;
  columns: number;
  service: ServiceStatus | null | undefined;
  envCount: number;
}) {
  return (
    <Box width={columns} justifyContent="space-between" paddingX={1}>
      <Box>
        <Text color={theme.accent}>▓▒░ </Text>
        <GradientText>backup-manager</GradientText>
        <Text color={theme.accentAlt}> ░▒▓</Text>
      </Box>
      <Box gap={1}>
        {columns >= 110 && <Text color={theme.muted}>{hostname().slice(0, 24)}</Text>}
        {columns >= 110 && <Text color={theme.border}>·</Text>}
        {serviceLabel(theme, service)}
        <Text color={theme.border}>·</Text>
        <Text color={theme.muted}>{`${envCount} env${envCount === 1 ? "" : "s"}`}</Text>
        <Text color={theme.border}>·</Text>
        <Clock theme={theme} />
      </Box>
    </Box>
  );
}

export function Sidebar({
  theme,
  height,
  selected,
  current,
  focused,
  counters,
}: {
  theme: Theme;
  height: number;
  selected: number;
  current: number;
  focused: boolean;
  counters: Record<string, number>;
}) {
  return (
    <Box
      flexDirection="column"
      width={SIDEBAR_WIDTH}
      height={height}
      borderStyle="round"
      borderColor={focused ? theme.focus : theme.border}
      paddingX={1}
      flexShrink={0}
    >
      {MENU.map((item, i) => {
        const isCurrent = i === current;
        const isSelected = focused && i === selected;
        const count = counters[item.route.name];
        const badge = count ? ` ${count}` : "";
        const label = `${isCurrent ? "●" : " "} ${item.label}`.slice(
          0,
          SIDEBAR_WIDTH - 4 - badge.length,
        );
        return (
          <Text key={item.label} wrap="truncate-end">
            <Text
              color={isCurrent ? theme.accent : undefined}
              bold={isCurrent}
              inverse={isSelected}
            >
              {label.padEnd(SIDEBAR_WIDTH - 4 - badge.length)}
            </Text>
            {badge ? <Text color={theme.info}>{badge}</Text> : null}
          </Text>
        );
      })}
    </Box>
  );
}

export function TabBar({
  theme,
  columns,
  current,
}: {
  theme: Theme;
  columns: number;
  current: number;
}) {
  return (
    <Box width={columns} paddingX={1}>
      <Text wrap="truncate-end">
        {MENU.map((item, i) => (
          <Text
            key={item.label}
            color={i === current ? theme.accent : theme.muted}
            bold={i === current}
            inverse={i === current}
          >
            {` ${item.key} ${item.label} `}
          </Text>
        ))}
      </Text>
    </Box>
  );
}

/**
 * The key-hint line. Focused (Ctrl/Alt+↓) it becomes a button bar: only hints with `run`
 * are shown, as `[ label ]`, and `selected` indexes into those buttons.
 */
export function Footer({
  theme,
  columns,
  hints,
  global,
  focused = false,
  selected = 0,
}: {
  theme: Theme;
  columns: number;
  hints: KeyHint[];
  global: KeyHint[];
  focused?: boolean;
  selected?: number;
}) {
  if (!focused)
    return (
      <Box width={columns}>
        <KeyHints hints={[...hints, ...global]} />
        <Text color={theme.muted}> </Text>
      </Box>
    );
  const buttons = [...hints, ...global].filter((h) => h.run);
  return (
    <Box width={columns}>
      <Text wrap="truncate-end">
        {buttons.map((b, i) => (
          <Text key={`${b.key}-${b.label}`}>
            {" "}
            <Text
              color={i === selected ? theme.focus : theme.accent}
              inverse={i === selected}
              bold={i === selected}
            >{`[ ${b.label} ]`}</Text>
          </Text>
        ))}
        <Text color={theme.muted}>{"  ←→ pick  ⏎ press  esc back"}</Text>
      </Text>
    </Box>
  );
}
