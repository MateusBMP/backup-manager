import { type Key, useInput } from "ink";
import { useEffect, useState } from "react";

/** Ctrl/Alt + arrow: moves between zones (sidebar, content, button bar), never inside one. */
export const isZoneKey = (key: Key): boolean =>
  Boolean(
    (key.ctrl || key.meta) && (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow),
  );
/** Unmodified key, so Ctrl/Alt+arrows fall through to the zone handler. */
const plain = (key: Key) => !key.ctrl && !key.meta;
export const isUp = (input: string, key: Key) => plain(key) && (key.upArrow || input === "k");
export const isDown = (input: string, key: Key) => plain(key) && (key.downArrow || input === "j");

export interface ListNavOptions {
  isActive: boolean;
  /** Use an external index state (e.g. remembered across screens). */
  state?: [number, (v: number | ((p: number) => number)) => void];
  page?: number;
  initial?: number;
  onSelect?: (index: number) => void;
}

/** Vim-ish list navigation: ↑↓/jk, g/G, Home/End, PgUp/PgDn, ⏎. */
export function useListNav(count: number, options: ListNavOptions) {
  const own = useState(options.initial ?? 0);
  const [index, setIndex] = options.state ?? own;
  const page = Math.max(1, options.page ?? 10);
  useEffect(() => {
    if (index > count - 1) setIndex(Math.max(0, count - 1));
  }, [count, index, setIndex]);
  useInput(
    (input, key) => {
      if (count === 0) return;
      if (isUp(input, key)) setIndex((i) => Math.max(0, i - 1));
      else if (isDown(input, key)) setIndex((i) => Math.min(count - 1, i + 1));
      else if (key.pageUp) setIndex((i) => Math.max(0, i - page));
      else if (key.pageDown) setIndex((i) => Math.min(count - 1, i + page));
      else if (key.home || input === "g") setIndex(0);
      else if (key.end || input === "G") setIndex(count - 1);
      else if (key.return) options.onSelect?.(Math.min(index, count - 1));
    },
    { isActive: options.isActive },
  );
  const at = Math.min(index, Math.max(0, count - 1));
  /** Same as ⏎ (for a button). */
  const select = () => count > 0 && options.onSelect?.(at);
  return { index: at, setIndex, select };
}

/** Split a comma list, ignoring commas inside `{…}` glob braces. */
export function splitList(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "{") depth++;
    if (ch === "}") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
    } else current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

export const joinList = (items: readonly string[]) => items.join(", ");
