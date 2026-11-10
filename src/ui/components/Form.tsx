import { Box, Text, useInput } from "ink";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useApp, useCaptureKeys } from "../context.js";
import { isZoneKey } from "../keys.js";
import { cell } from "./basics.js";
import { TextField } from "./TextField.js";

export type FieldValue = string | boolean;
export type Values = Record<string, FieldValue>;

export type Field =
  | {
      kind: "text" | "password" | "number";
      key: string;
      label: string;
      placeholder?: string;
      hint?: ReactNode;
      error?: string;
    }
  | {
      kind: "select";
      key: string;
      label: string;
      options: { label: string; value: string }[];
      hint?: ReactNode;
      error?: string;
    }
  | { kind: "toggle"; key: string; label: string; hint?: ReactNode; error?: string }
  | {
      kind: "action";
      key: string;
      label: string;
      /** Text shown after the label (e.g. a path). */
      detail?: string;
      onPress(): void;
      onDelete?(): void;
      hint?: ReactNode;
      error?: string;
    }
  | { kind: "heading"; key: string; label: string };

export interface FormProps {
  id: string;
  fields: Field[];
  values: Values;
  onChange(values: Values): void;
  /** Called with the latest values (which may be newer than the last render). */
  onSubmit(values: Values): void;
  onCancel(): void;
  isActive: boolean;
  labelWidth?: number;
  width: number;
  /** Rows available; the form scrolls to keep the focused field visible. */
  height?: number;
  initialFocus?: string;
}

const focusable = (f: Field) => f.kind !== "heading";

/**
 * Keyboard form: Tab/↓ next, Shift-Tab/↑ previous, Space/←→ toggles and cycles selects,
 * ⏎ on an action presses it (on a text field it moves next), `d`/Delete on an action
 * deletes, Ctrl-S saves, Esc cancels.
 */
export function Form(props: FormProps) {
  const { theme } = useApp();
  const { fields, values, isActive } = props;
  // Several keys may arrive before the parent re-renders; merge into the latest values.
  const latest = useRef(values);
  latest.current = values;
  const onChange = (next: Values) => {
    latest.current = next;
    props.onChange(next);
  };
  const set = (key: string, value: FieldValue) => onChange({ ...latest.current, [key]: value });
  const focusables = fields.filter(focusable);
  const [focusKey, setFocusKey] = useState(props.initialFocus ?? focusables[0]?.key ?? "");
  useCaptureKeys(props.id, isActive);

  useEffect(() => {
    if (!focusables.some((f) => f.key === focusKey) && focusables[0])
      setFocusKey(focusables[0].key);
  }, [focusables, focusKey]);

  const at = Math.max(
    0,
    focusables.findIndex((f) => f.key === focusKey),
  );
  const current = focusables[at];
  const move = (delta: number) => {
    const next = focusables[(at + delta + focusables.length) % focusables.length];
    if (next) setFocusKey(next.key);
  };

  useInput(
    (input, key) => {
      if (isZoneKey(key)) return;
      if (key.ctrl && input === "s") return props.onSubmit(latest.current);
      if (key.escape) return props.onCancel();
      if (key.tab) return move(key.shift ? -1 : 1);
      if (key.downArrow) return move(1);
      if (key.upArrow) return move(-1);
      if (!current) return;
      if (
        current.kind === "toggle" &&
        (input === " " || key.leftArrow || key.rightArrow || key.return)
      ) {
        set(current.key, !latest.current[current.key]);
      } else if (current.kind === "select" && (input === " " || key.leftArrow || key.rightArrow)) {
        const options = current.options;
        const i = options.findIndex((o) => o.value === latest.current[current.key]);
        const next = options[(i + (key.leftArrow ? -1 : 1) + options.length) % options.length];
        if (next) set(current.key, next.value);
      } else if (current.kind === "action" && key.return) {
        current.onPress();
      } else if (current.kind === "action" && current.onDelete && (input === "d" || key.delete)) {
        current.onDelete();
      } else if (key.return) {
        move(1);
      }
    },
    { isActive },
  );

  const labelWidth =
    props.labelWidth ?? Math.min(22, Math.max(10, ...fields.map((f) => f.label.length + 1)));
  const inputWidth = Math.max(10, props.width - labelWidth - 4);
  const rows: { node: ReactNode; lines: number }[] = [];
  let focusRow = 0;
  for (const field of fields) {
    const focused = isActive && field.key === focusKey && focusable(field);
    if (focused) focusRow = rows.length;
    if (field.kind === "heading") {
      const gap = rows.length ? 1 : 0;
      rows.push({
        lines: 1 + gap,
        node: (
          <Box key={field.key} marginTop={gap} flexShrink={0}>
            <Text bold color={theme.accent}>
              {field.label}
            </Text>
          </Box>
        ),
      });
      continue;
    }
    const marker = <Text color={theme.accent}>{focused ? "❯ " : "  "}</Text>;
    let control: ReactNode;
    if (field.kind === "toggle") {
      const on = Boolean(values[field.key]);
      control = (
        <Text color={on ? theme.success : theme.muted} inverse={focused}>
          {on ? "● on" : "○ off"}
        </Text>
      );
    } else if (field.kind === "select") {
      const option = field.options.find((o) => o.value === values[field.key]);
      control = focused ? (
        <Text>
          <Text inverse>{option?.label ?? "—"}</Text>
          <Text color={theme.muted}>{"  ◂ ▸"}</Text>
        </Text>
      ) : (
        <Text>{option?.label ?? "—"}</Text>
      );
    } else if (field.kind === "action") {
      control = (
        <Text wrap="truncate-end" color={focused ? theme.accent : undefined}>
          {field.detail ?? ""}
        </Text>
      );
    } else {
      control = (
        <TextField
          value={String(values[field.key] ?? "")}
          onChange={(v) => set(field.key, field.kind === "number" ? v.replace(/[^0-9]/g, "") : v)}
          focus={focused}
          mask={field.kind === "password"}
          placeholder={field.placeholder}
          width={inputWidth}
        />
      );
    }
    const extra = field.error ? (
      <Text color={theme.error} wrap="truncate-end">
        ✘ {field.error}
      </Text>
    ) : field.hint && focused ? (
      typeof field.hint === "string" ? (
        <Text color={theme.muted} wrap="truncate-end">
          {field.hint}
        </Text>
      ) : (
        field.hint
      )
    ) : null;
    rows.push({
      lines: extra ? 2 : 1,
      node: (
        <Box key={field.key} flexDirection="column" flexShrink={0}>
          <Box height={1}>
            {marker}
            <Text bold={focused} color={field.kind === "action" ? theme.info : undefined}>
              {cell(field.label, labelWidth)}
            </Text>
            <Box flexGrow={1}>{control}</Box>
          </Box>
          {extra ? (
            <Box marginLeft={labelWidth + 2} height={1} overflow="hidden">
              {extra}
            </Box>
          ) : null}
        </Box>
      ),
    });
  }
  const height = props.height;
  const total = rows.reduce((s, r) => s + r.lines, 0);
  if (!height || total <= height)
    return <Box flexDirection="column">{rows.map((r) => r.node)}</Box>;

  // Window by lines: keep the focused row visible, leaving room for the ↑/↓ markers.
  const budget = Math.max(1, height - 2);
  let start = focusRow;
  let used = rows[focusRow]?.lines ?? 1;
  while (
    start > 0 &&
    used + (rows[start - 1]?.lines ?? 1) <= Math.ceil(budget / 3) + (rows[focusRow]?.lines ?? 1)
  ) {
    start--;
    used += rows[start]?.lines ?? 1;
  }
  let end = focusRow + 1;
  while (end < rows.length && used + (rows[end]?.lines ?? 1) <= budget) {
    used += rows[end]?.lines ?? 1;
    end++;
  }
  while (start > 0 && used + (rows[start - 1]?.lines ?? 1) <= budget) {
    start--;
    used += rows[start]?.lines ?? 1;
  }
  return (
    <Box flexDirection="column">
      <Text color={theme.muted}>{start > 0 ? "  ↑ more" : " "}</Text>
      {rows.slice(start, end).map((r) => r.node)}
      <Text color={theme.muted}>{end < rows.length ? "  ↓ more" : " "}</Text>
    </Box>
  );
}
