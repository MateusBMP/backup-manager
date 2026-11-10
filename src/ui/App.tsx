import { Box, Text, useApp as useInkApp, useInput, useWindowSize } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfigMissingError } from "../core/config/load.js";
import type { Config } from "../core/config/schema.js";
import { ConfigConflictError } from "../core/config/store.js";
import type { ServiceStatus } from "../core/service/manager.js";
import type { Services } from "../core/services.js";
import { Footer, Header, SIDEBAR_WIDTH, Sidebar, TabBar, WIDE } from "./components/Frame.js";
import { ConfirmBody, HelpBody, Modal, Toasts, TooSmall } from "./components/Overlay.js";
import {
  type AppContextValue,
  type ConfirmOptions,
  type KeyHint,
  Provider,
  type Toast,
  type ToastKind,
  useApp as useAppCtx,
} from "./context.js";
import { usePolling } from "./hooks/usePolling.js";
import { isDown, isUp, isZoneKey } from "./keys.js";
import { MENU, menuIndex, type Route } from "./router.js";
import { Screen } from "./screens/index.js";
import { makeTheme, type Theme } from "./theme.js";

export interface AppProps {
  services: Services;
  /** Fixed terminal size (tests); defaults to the live window size. */
  size?: { columns: number; rows: number };
  initialRoute?: Route;
  theme?: Theme;
  /** Poll intervals in ms (tests shorten them). */
  intervals?: { service?: number; jobs?: number };
}

type ModalState =
  | { kind: "confirm"; options: ConfirmOptions; resolve: (ok: boolean) => void; choice: boolean }
  | { kind: "help" }
  | null;

type Zone = "sidebar" | "content" | "actions";

export function App(props: AppProps) {
  const { services } = props;
  const window = useWindowSize();
  const size = props.size ?? { columns: window.columns || 100, rows: window.rows || 30 };
  const theme = useMemo(() => props.theme ?? makeTheme(), [props.theme]);
  const ink = useInkApp();

  const [config, setConfig] = useState<Config | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const mtime = useRef<number | null>(null);
  const [stack, setStack] = useState<Route[]>([props.initialRoute ?? { name: "dashboard" }]);
  const route = stack[stack.length - 1] as Route;
  const [focus, setFocus] = useState<Zone>("content");
  const [actionIndex, setActionIndexState] = useState(0);
  // Mirrored in a ref: keys that arrive in one chunk (slow SSH links) see each other's moves.
  const actionRef = useRef(0);
  const setActionIndex = (i: number) => {
    actionRef.current = i;
    setActionIndexState(i);
  };
  const [sidebarIndex, setSidebarIndex] = useState(0);
  const [captures, setCaptures] = useState<string[]>([]);
  const [hints, setHints] = useState<KeyHint[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [modal, setModal] = useState<ModalState>(null);
  const toastId = useRef(0);
  const backHandler = useRef<(() => boolean) | null>(null);
  const memory = useRef(new Map<string, unknown>()).current;
  const setBackHandler = useCallback((handler: (() => boolean) | null) => {
    backHandler.current = handler;
  }, []);
  const [now, setNow] = useState(Date.now());

  const toast = useCallback((text: string, kind: ToastKind = "info") => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-3), { id, text, kind, createdAt: Date.now() }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3000).unref?.();
  }, []);

  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 300);
    return () => clearInterval(timer);
  }, [toasts.length]);

  const reload = useCallback(async () => {
    try {
      const loaded = await services.load();
      setConfig(loaded.config);
      mtime.current = loaded.mtimeMs;
      setConfigError(null);
    } catch (error) {
      if (error instanceof ConfigMissingError) {
        setConfig(null);
        mtime.current = null;
        setConfigError(null);
        setStack([{ name: "onboarding" }]);
      } else {
        setConfigError((error as Error).message);
      }
    } finally {
      setReady(true);
    }
  }, [services]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(
    async (next: Config, message = "saved") => {
      try {
        const saved = await services.save(next, mtime.current);
        mtime.current = saved.mtimeMs;
        setConfig(next);
        setConfigError(null);
        toast(message, "success");
        return true;
      } catch (error) {
        if (error instanceof ConfigConflictError) {
          toast("config.json changed on disk; reloaded it, re-apply your change", "warning");
          await reload();
        } else {
          toast((error as Error).message.split("\n").slice(0, 2).join(" "), "error");
        }
        return false;
      }
    },
    [services, toast, reload],
  );

  const navigate = useCallback((next: Route, options: { replace?: boolean } = {}) => {
    setStack((s) => (options.replace ? [...s.slice(0, -1), next] : [...s, next].slice(-20)));
    setFocus("content");
  }, []);

  const back = useCallback(() => {
    setStack((s) =>
      s.length > 1
        ? s.slice(0, -1)
        : s[0]?.name === "dashboard" || s[0]?.name === "onboarding"
          ? s
          : [{ name: "dashboard" }],
    );
  }, []);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) =>
        setModal({ kind: "confirm", options, resolve, choice: !options.danger }),
      ),
    [],
  );

  const setCapture = useCallback((owner: string, active: boolean) => {
    setCaptures((c) =>
      active ? (c.includes(owner) ? c : [...c, owner]) : c.filter((o) => o !== owner),
    );
  }, []);

  const service = usePolling<ServiceStatus | null>(
    () => services.service.status().catch(() => null),
    props.intervals?.service ?? 5000,
  );
  const running = usePolling(
    async () =>
      config
        ? (await services.jobs(config, 20)).filter(
            (j) => j.status === "running" || j.status === "queued",
          ).length
        : 0,
    props.intervals?.jobs ?? 2000,
    [config],
  );

  const captured = captures.length > 0;
  const wide = size.columns >= WIDE;
  const current = menuIndex(route);

  // Esc and the "back" button: let the screen step back first, then leave it.
  const goBack = () => {
    if (backHandler.current?.()) return;
    if (stack.length > 1) back();
    else if (wide && config) {
      setSidebarIndex(current);
      setFocus("sidebar");
    }
  };
  const globals: KeyHint[] = [
    { key: "ctrl+←↓→", label: "zones" },
    // Screens that declare their own Esc button (forms: cancel) don't get a second one.
    ...(stack.length > 1 && !hints.some((h) => h.key === "esc")
      ? [{ key: "esc", label: "back", run: goBack }]
      : []),
    { key: "?", label: "help", run: () => setModal({ kind: "help" }) },
    { key: "q", label: "quit", run: () => ink.exit() },
  ];
  const buttons = [...hints, ...globals].filter((h) => h.run);
  const selectedAction = Math.min(actionIndex, Math.max(0, buttons.length - 1));

  const closeModal = (result?: boolean) => {
    if (modal?.kind === "confirm") modal.resolve(result ?? false);
    setModal(null);
  };

  useInput(
    (input, key) => {
      if (!modal) return;
      if (modal.kind === "help") return closeModal();
      if (input === "y") return closeModal(true);
      if (input === "n" || key.escape) return closeModal(false);
      if (isZoneKey(key)) return;
      if (key.leftArrow || key.rightArrow || key.tab)
        return setModal({ ...modal, choice: !modal.choice });
      if (key.return) return closeModal(modal.choice);
    },
    { isActive: modal !== null },
  );

  useInput(
    (input, key) => {
      if (input === "q") return ink.exit();
      if (input === "?") return setModal({ kind: "help" });
      if (!config) return;
      const item = MENU.find((m) => m.key === input || m.alias === input);
      if (item) {
        setStack([item.route]);
        setFocus("content");
        return;
      }
      if (key.tab) {
        setSidebarIndex(current);
        return setFocus((f) => (f === "content" && wide ? "sidebar" : "content"));
      }
      if (key.escape) {
        if (focus === "content") goBack();
        else if (stack.length > 1) back();
      }
    },
    { isActive: !captured && modal === null && focus !== "actions" },
  );

  // Ctrl/Alt+arrows move between zones, even while a form holds the keyboard.
  useInput(
    (_input, key) => {
      if (!isZoneKey(key)) return;
      if (key.leftArrow) {
        if (!wide || !config) return;
        setSidebarIndex(current);
        setFocus("sidebar");
      } else if (key.downArrow) {
        setActionIndex(0);
        setFocus("actions");
      } else setFocus("content");
    },
    { isActive: modal === null },
  );

  // The footer as a button bar: ←→ pick, ⏎ press, Esc/↑ back to the content.
  useInput(
    (input, key) => {
      if (isZoneKey(key)) return;
      const n = buttons.length;
      const at = Math.min(actionRef.current, n - 1);
      if (key.leftArrow || input === "h" || (key.tab && key.shift))
        setActionIndex((at - 1 + n) % n);
      else if (key.rightArrow || input === "l" || key.tab) setActionIndex((at + 1) % n);
      else if (key.escape || key.upArrow) setFocus("content");
      else if (key.return || input === " ") {
        setFocus("content");
        buttons[at]?.run?.();
      }
    },
    { isActive: focus === "actions" && modal === null && buttons.length > 0 },
  );

  useInput(
    (input, key) => {
      if (isZoneKey(key)) return;
      if (isUp(input, key)) setSidebarIndex((i) => (i - 1 + MENU.length) % MENU.length);
      else if (isDown(input, key)) setSidebarIndex((i) => (i + 1) % MENU.length);
      else if (key.return || key.rightArrow) {
        const item = MENU[sidebarIndex];
        if (item) {
          setStack([item.route]);
          setFocus("content");
        }
      }
    },
    { isActive: focus === "sidebar" && !captured && modal === null && config !== null },
  );

  const bodyHeight = size.rows - 2 - (wide ? 0 : 1);
  const contentWidth = wide ? size.columns - SIDEBAR_WIDTH - 1 : size.columns;

  const ctx: AppContextValue = {
    services,
    theme,
    config,
    configError,
    route,
    navigate,
    back,
    reload,
    save,
    toast,
    confirm,
    contentFocused: focus === "content",
    modalOpen: modal !== null,
    width: contentWidth,
    height: bodyHeight,
    setCapture,
    setHints,
    setBackHandler,
    memory,
  };

  if (size.columns < 60 || size.rows < 16) {
    return (
      <Provider value={ctx}>
        <TooSmall theme={theme} columns={size.columns} rows={size.rows} />
        <QuitOnQ />
      </Provider>
    );
  }

  return (
    <Provider value={ctx}>
      <Box flexDirection="column" width={size.columns} height={size.rows}>
        <Header
          theme={theme}
          columns={size.columns}
          service={service.data}
          envCount={config?.environments.length ?? 0}
        />
        {!wide && <TabBar theme={theme} columns={size.columns} current={current} />}
        <Box flexDirection="row" height={bodyHeight} gap={1}>
          {wide && (
            <Sidebar
              theme={theme}
              height={bodyHeight}
              selected={sidebarIndex}
              current={current}
              focused={focus === "sidebar"}
              counters={{ jobs: running.data ?? 0 }}
            />
          )}
          <Box flexDirection="column" width={contentWidth} height={bodyHeight}>
            {!ready ? (
              <Text color={theme.muted}>loading…</Text>
            ) : configError && !config ? (
              <ConfigErrorView message={configError} />
            ) : (
              <Screen route={route} />
            )}
          </Box>
        </Box>
        <Footer
          theme={theme}
          columns={size.columns}
          hints={hints}
          global={captured ? globals.slice(0, 1) : globals}
          focused={focus === "actions"}
          selected={selectedAction}
        />
        <Toasts theme={theme} toasts={toasts} now={now} />
        {modal?.kind === "help" && (
          <Modal theme={theme} width={64} columns={size.columns} rows={size.rows} title="Keys">
            <HelpBody theme={theme} />
          </Modal>
        )}
        {modal?.kind === "confirm" && (
          <Modal
            theme={theme}
            width={60}
            columns={size.columns}
            rows={size.rows}
            title={modal.options.title}
            danger={modal.options.danger}
          >
            <ConfirmBody theme={theme} options={modal.options} choice={modal.choice} />
          </Modal>
        )}
      </Box>
    </Provider>
  );
}

function QuitOnQ() {
  const ink = useInkApp();
  useInput((input) => {
    if (input === "q") ink.exit();
  });
  return null;
}

function ConfigErrorView({ message }: { message: string }) {
  const { theme, reload, setHints } = useAppCtx();
  useEffect(
    () => setHints([{ key: "r", label: "reload", run: () => void reload() }]),
    [setHints, reload],
  );
  useInput((input) => {
    if (input === "r") void reload();
  });
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={theme.error} bold>
        The config file has errors
      </Text>
      <Box marginY={1} flexDirection="column">
        {message.split("\n").map((line) => (
          <Text key={line} color={theme.error}>
            {line}
          </Text>
        ))}
      </Box>
      <Text color={theme.muted}>
        Fix the file (or restore config.json.bak) and press r to reload.
      </Text>
    </Box>
  );
}
