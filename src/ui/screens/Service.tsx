import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { timezone } from "../../core/config/defaults.js";
import { formatDateTime } from "../../core/format.js";
import { nextRun } from "../../core/schedule.js";
import type { ServiceStatus } from "../../core/service/manager.js";
import { Badge, cell, Muted, Panel, Spinner } from "../components/basics.js";
import { ScrollView } from "../components/ScrollList.js";
import { useApp, useHints, useScreenActive } from "../context.js";
import { usePolling } from "../hooks/usePolling.js";
import { useListNav } from "../keys.js";

type Action = "install" | "uninstall" | "start" | "stop" | "restart" | "reload";
const ACTIONS: { action: Action; label: string; describe: string }[] = [
  {
    action: "install",
    label: "Install / update",
    describe: "write the unit, enable --now, enable linger",
  },
  { action: "start", label: "Start", describe: "systemctl --user start bkm" },
  { action: "stop", label: "Stop", describe: "systemctl --user stop bkm" },
  { action: "restart", label: "Restart", describe: "systemctl --user restart bkm" },
  { action: "reload", label: "Reload config", describe: "systemctl --user reload bkm (SIGHUP)" },
  {
    action: "uninstall",
    label: "Uninstall",
    describe: "disable --now and remove the unit (data kept)",
  },
];

function StatusPanel({ s, width }: { s: ServiceStatus | undefined | null; width: number }) {
  const { theme } = useApp();
  const row = (label: string, value: React.ReactNode) => (
    <Text wrap="truncate-end">
      <Text color={theme.muted}>{cell(label, 10)}</Text>
      {value}
    </Text>
  );
  if (!s) return <Spinner label="checking systemd…" />;
  if (!s.available)
    return (
      <Text
        color={theme.warning}
      >{`systemctl --user is unavailable: ${s.error ?? "unknown"}`}</Text>
    );
  const active = s.activeState === "active";
  return (
    <Box flexDirection="column" width={width}>
      <Box gap={1}>
        {s.installed ? (
          <Badge color={active ? theme.success : theme.warning}>
            {active ? "ACTIVE" : s.activeState.toUpperCase()}
          </Badge>
        ) : (
          <Badge color={theme.muted}>NOT INSTALLED</Badge>
        )}
        {s.outdated ? <Badge color={theme.warning}>OUTDATED</Badge> : null}
        {s.linger === false ? <Badge color={theme.warning}>NO LINGER</Badge> : null}
      </Box>
      {row("state", `${s.activeState} (${s.subState})${s.mainPid ? ` · pid ${s.mainPid}` : ""}`)}
      {row("enabled", s.enabled)}
      {row(
        "linger",
        s.linger === null
          ? "unknown"
          : s.linger
            ? "yes: runs at boot and after logout"
            : "no: stops when you log out",
      )}
      {row("unit", s.unitPath)}
      {s.outdated ? (
        <Text color={theme.warning}>
          The unit points to an old node or bkm path: choose Install / update.
        </Text>
      ) : null}
    </Box>
  );
}

export function Service() {
  const { services, config, width, height, confirm, toast, theme } = useApp();
  const active = useScreenActive();
  const status = usePolling(() => services.service.status(), 5000);
  const logs = usePolling(() => services.service.logs(200), 5000);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (action: Action) => {
    if (busy) return;
    if (action === "uninstall" || action === "stop") {
      const ok = await confirm({
        title: action === "stop" ? "Stop the service" : "Uninstall the service",
        message:
          action === "stop"
            ? "Scheduled backups stop until you start it again."
            : "Disable and remove the user unit? Config, backups and job history are kept.",
        confirmLabel: action === "stop" ? "Stop" : "Uninstall",
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(action);
    try {
      if (action === "install") {
        const r = await services.service.install({ force: status.data?.outdated });
        toast(
          r.warnings[0] ??
            (r.actions.length ? "service installed and running" : "service already up to date"),
          r.warnings.length ? "warning" : "success",
        );
      } else if (action === "uninstall") {
        await services.service.uninstall();
        toast("service removed", "success");
      } else {
        await services.service.control(action);
        toast(`${action} done`, "success");
      }
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(null);
      status.refresh();
      logs.refresh();
    }
  };
  const nav = useListNav(ACTIONS.length, {
    isActive: active,
    onSelect: (i) => void run(ACTIONS[i]!.action),
  });
  const refresh = () => {
    status.refresh();
    logs.refresh();
  };
  useHints([
    { key: "↑↓", label: "action" },
    { key: "⏎", label: "run", run: () => nav.select() },
    { key: "r", label: "refresh", run: refresh },
  ]);
  useInput((input) => input === "r" && refresh(), { isActive: active });

  const half = Math.floor(width / 2);
  const tz = config ? timezone(config) : undefined;
  const api = config?.api;
  const topHeight = 9;
  const lines = (logs.data ?? []).map((l, i) => (
    <Text
      // biome-ignore lint/suspicious/noArrayIndexKey: journal lines are positional and may repeat
      key={`${i}:${l}`}
      wrap="truncate-end"
      color={/error|fail/i.test(l) ? theme.error : /warn/i.test(l) ? theme.warning : undefined}
    >
      {l}
    </Text>
  ));
  const logHeight = Math.max(3, height - topHeight - 4);
  return (
    <Box flexDirection="column">
      <Box>
        <Panel title="Service · bkm" width={half} height={topHeight}>
          <StatusPanel s={status.data} width={half - 4} />
        </Panel>
        <Panel title="Actions" width={width - half} height={topHeight} focused={active}>
          {ACTIONS.map((a, i) => (
            <Text key={a.action} wrap="truncate-end">
              <Text color={theme.accent}>{i === nav.index && active ? "❯ " : "  "}</Text>
              <Text bold={i === nav.index}>{cell(a.label, 17)}</Text>
              {busy === a.action ? <Spinner /> : <Text color={theme.muted}>{a.describe}</Text>}
            </Text>
          ))}
        </Panel>
      </Box>
      <Panel title="Schedules & API" width={width}>
        <Text wrap="truncate-end">
          {(config?.environments ?? [])
            .filter((e) => e.schedule)
            .map((e) => {
              const n = nextRun(e.schedule, tz);
              return `${e.name} ${n ? formatDateTime(n) : "—"}`;
            })
            .join("  ·  ") || "no schedules"}
          <Text
            color={theme.muted}
          >{`   api ${api?.enabled ? `http://${api.host}:${api.port}${api.token || api.tokenFile ? " (token)" : ""}` : "disabled"}`}</Text>
        </Text>
      </Panel>
      <Panel title="journalctl --user -u bkm" width={width}>
        {lines.length ? (
          <ScrollView
            lines={lines}
            height={logHeight}
            offset={Math.max(0, lines.length - logHeight)}
          />
        ) : (
          <Muted>{logs.loading ? "loading…" : "no log lines"}</Muted>
        )}
      </Panel>
    </Box>
  );
}
