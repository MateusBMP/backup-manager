import { Text, useInput, usePaste } from "ink";
import { useRef, useState } from "react";
import { useApp } from "../context.js";
import { isZoneKey } from "../keys.js";

export interface TextFieldProps {
  value: string;
  onChange(value: string): void;
  focus: boolean;
  mask?: boolean;
  placeholder?: string;
  width?: number;
}

/** Controlled single-line input: ←→, Home/End, Ctrl-A/E, Ctrl-U, Backspace/Delete, paste. */
export function TextField({ value, onChange, focus, mask, placeholder, width }: TextFieldProps) {
  const { theme } = useApp();
  // Keys can arrive faster than React re-renders, so edits apply to the live value in a ref
  // rather than to the (possibly stale) props of the last render.
  const live = useRef({ value, cursor: value.length, emitted: value });
  if (value !== live.current.emitted) {
    live.current = { value, cursor: Math.min(live.current.cursor, value.length), emitted: value };
  }
  const [, rerender] = useState(0);
  const commit = (next: string, cursor: number) => {
    const changed = next !== live.current.value;
    live.current = { value: next, cursor, emitted: changed ? next : live.current.emitted };
    if (changed) onChange(next);
    rerender((n) => n + 1);
  };
  const insert = (text: string) => {
    const clean = text.replace(/[\r\n]+/g, " ");
    if (!clean) return;
    const { value: v, cursor } = live.current;
    const at = Math.min(cursor, v.length);
    commit(v.slice(0, at) + clean + v.slice(at), at + clean.length);
  };

  useInput(
    (input, key) => {
      const { value: v, cursor } = live.current;
      const at = Math.min(cursor, v.length);
      if (isZoneKey(key)) return;
      if (key.leftArrow) commit(v, Math.max(0, at - 1));
      else if (key.rightArrow) commit(v, Math.min(v.length, at + 1));
      else if (key.home || (key.ctrl && input === "a")) commit(v, 0);
      else if (key.end || (key.ctrl && input === "e")) commit(v, v.length);
      else if (key.ctrl && input === "u") commit(v.slice(at), 0);
      else if (key.backspace || key.delete) {
        if (at > 0) commit(v.slice(0, at - 1) + v.slice(at), at - 1);
      } else if (
        input &&
        !key.ctrl &&
        !key.meta &&
        !key.tab &&
        !key.return &&
        !key.escape &&
        !key.upArrow &&
        !key.downArrow
      ) {
        insert(input);
      }
    },
    { isActive: focus },
  );
  usePaste(insert, { isActive: focus });

  const cursor = live.current.cursor;
  value = live.current.value;
  const shown = mask ? "•".repeat(value.length) : value;
  const max = width && width > 1 ? width - 1 : Number.POSITIVE_INFINITY;
  const at = Math.min(cursor, shown.length);
  const start =
    shown.length > max ? Math.max(0, Math.min(at - Math.floor(max / 2), shown.length - max)) : 0;
  const visible = shown.slice(start, start + max);
  const rel = at - start;

  if (!focus) {
    if (!value) return <Text color={theme.muted}>{placeholder ?? ""}</Text>;
    return <Text wrap="truncate-end">{visible}</Text>;
  }
  if (!value && placeholder) {
    return (
      <Text>
        <Text inverse>{placeholder[0] ?? " "}</Text>
        <Text color={theme.muted}>{placeholder.slice(1)}</Text>
      </Text>
    );
  }
  return (
    <Text>
      {visible.slice(0, rel)}
      <Text inverse>{visible[rel] ?? " "}</Text>
      {visible.slice(rel + 1)}
    </Text>
  );
}
