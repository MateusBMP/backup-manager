import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Config } from "../core/config/schema.js";
import type { Services } from "../core/services.js";
import type { Route } from "./router.js";
import type { Theme } from "./theme.js";

export type ToastKind = "info" | "success" | "warning" | "error";

export interface Toast {
  id: number;
  text: string;
  kind: ToastKind;
  createdAt: number;
}

export interface KeyHint {
  key: string;
  label: string;
  /** Makes the hint a button in the footer action bar (Ctrl/Alt+↓, then ⏎). */
  run?: () => void;
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}

export interface AppContextValue {
  services: Services;
  theme: Theme;
  config: Config | null;
  configError: string | null;
  route: Route;
  navigate(route: Route, options?: { replace?: boolean }): void;
  back(): void;
  /** Re-read config.json from disk. */
  reload(): Promise<void>;
  /** Save through the store; returns false (with a toast) on error or external edits. */
  save(next: Config, message?: string): Promise<boolean>;
  toast(text: string, kind?: ToastKind): void;
  confirm(options: ConfirmOptions): Promise<boolean>;
  /** Content pane has keyboard focus (vs. the sidebar). */
  contentFocused: boolean;
  /** A modal (confirm/help) is open; screens should not react to keys. */
  modalOpen: boolean;
  /** Content area size in cells (inside the frame). */
  width: number;
  height: number;
  setCapture(owner: string, active: boolean): void;
  setHints(hints: KeyHint[]): void;
  /** A screen-level Esc handler; return true when it consumed the key. */
  setBackHandler(handler: (() => boolean) | null): void;
  /** Per-session memory so screens keep filters/selection when you come back. */
  memory: Map<string, unknown>;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside <AppContext>");
  return ctx;
}

/** Keys reach the active screen only when the content pane is focused and no modal is open. */
export function useScreenActive(): boolean {
  const { contentFocused, modalOpen } = useApp();
  return contentFocused && !modalOpen;
}

/** While active, global shortcuts (q, e, n, …) are suspended so forms can take every key. */
export function useCaptureKeys(owner: string, active: boolean): void {
  const { setCapture } = useApp();
  useEffect(() => {
    setCapture(owner, active);
    return () => setCapture(owner, false);
  }, [owner, active, setCapture]);
}

/** useState that survives leaving and re-entering a screen (for this UI session). */
export function useSessionState<T>(
  key: string,
  initial: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  const { memory } = useApp();
  const [value, setValue] = useState<T>(() => (memory.has(key) ? (memory.get(key) as T) : initial));
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const v = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        memory.set(key, v);
        return v;
      });
    },
    [key, memory],
  );
  return [value, set];
}

/** Let a screen handle Esc first (e.g. step back in a wizard) before the global "back". */
export function useBackHandler(handler: () => boolean): void {
  const { setBackHandler } = useApp();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    setBackHandler(() => ref.current());
    return () => setBackHandler(null);
  }, [setBackHandler]);
}

/**
 * Declare the screen's keys and actions once: the footer shows them as hints and, when they
 * have `run`, as buttons. Labels refresh on `deps`; `run` always calls the latest closure.
 * `null` leaves the footer to a nested editor that declares its own.
 */
export function useHints(hints: KeyHint[] | null, deps: unknown[] = []): void {
  const { setHints } = useApp();
  const ref = useRef(hints);
  ref.current = hints;
  // biome-ignore lint/correctness/useExhaustiveDependencies: hints are recomputed from deps
  useEffect(() => {
    if (!hints) return;
    setHints(hints.map((h, i) => (h.run ? { ...h, run: () => ref.current?.[i]?.run?.() } : h)));
  }, [setHints, ...deps]);
}

export function Provider({ value, children }: { value: AppContextValue; children: ReactNode }) {
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
