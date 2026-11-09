import { Box, Text } from "ink";
import { type ReactNode, useRef } from "react";
import { useApp } from "../context.js";

/** Keeps `index` visible inside a window of `height` rows; returns the first visible row. */
export function useWindowOffset(index: number, height: number, total: number): number {
  const offset = useRef(0);
  const h = Math.max(1, height);
  if (index < offset.current) offset.current = index;
  if (index >= offset.current + h) offset.current = index - h + 1;
  offset.current = Math.max(0, Math.min(offset.current, Math.max(0, total - h)));
  return offset.current;
}

function Scrollbar({ height, offset, total }: { height: number; offset: number; total: number }) {
  const { theme } = useApp();
  if (total <= height) return null;
  const size = Math.max(1, Math.round((height / total) * height));
  const start = Math.min(
    height - size,
    Math.round((offset / Math.max(1, total - height)) * (height - size)),
  );
  return (
    <Box flexDirection="column" width={1} marginLeft={1}>
      {Array.from({ length: height }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed positional gutter
        <Text key={i} color={i >= start && i < start + size ? theme.accent : theme.border}>
          {i >= start && i < start + size ? "┃" : "│"}
        </Text>
      ))}
    </Box>
  );
}

/** Virtualized single-line rows with a selection and a scrollbar gutter. */
export function ScrollList<T>({
  items,
  index,
  height,
  render,
  empty,
  selectable = true,
}: {
  items: readonly T[];
  index: number;
  height: number;
  render: (item: T, selected: boolean, i: number) => ReactNode;
  empty?: ReactNode;
  selectable?: boolean;
}) {
  const { theme } = useApp();
  const h = Math.max(1, height);
  const offset = useWindowOffset(index, h, items.length);
  if (items.length === 0)
    return (
      <Box height={1}>
        {typeof empty === "string" ? <Text color={theme.muted}>{empty}</Text> : empty}
      </Box>
    );
  const visible = items.slice(offset, offset + h);
  return (
    <Box flexDirection="row">
      <Box flexDirection="column" flexGrow={1}>
        {visible.map((item, i) => {
          const at = offset + i;
          const selected = selectable && at === index;
          return (
            <Box key={at}>
              <Text color={theme.accent}>{selected ? "❯ " : "  "}</Text>
              <Box flexGrow={1}>{render(item, selected, at)}</Box>
            </Box>
          );
        })}
      </Box>
      <Scrollbar height={Math.min(h, items.length)} offset={offset} total={items.length} />
    </Box>
  );
}

/**
 * Scrollable block of one-row lines using `overflow="hidden"` + `contentOffsetY`;
 * the caller owns `offset` (e.g. to follow a live log).
 */
export function ScrollView({
  lines,
  height,
  offset,
}: {
  lines: ReactNode[];
  height: number;
  offset: number;
}) {
  const h = Math.max(1, height);
  const max = Math.max(0, lines.length - h);
  const y = Math.max(0, Math.min(offset, max));
  return (
    <Box flexDirection="row" height={h}>
      <Box flexDirection="column" flexGrow={1} height={h} overflow="hidden" contentOffsetY={y}>
        {lines.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
          <Box key={i} height={1} flexShrink={0}>
            {line}
          </Box>
        ))}
      </Box>
      <Scrollbar height={h} offset={y} total={lines.length} />
    </Box>
  );
}
