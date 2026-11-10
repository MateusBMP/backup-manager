import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { formatAge, formatBytes, formatDateTime, formatDuration } from "../../core/format.js";
import { cell, Muted, Panel, StatusText } from "../components/basics.js";
import { ScrollList, ScrollView } from "../components/ScrollList.js";
import { useApp, useHints, useScreenActive, useSessionState } from "../context.js";
import { usePolling } from "../hooks/usePolling.js";
import { isDown, isUp, isZoneKey, useListNav } from "../keys.js";

const FILTERS = ["all", "complete", "partial", "incomplete"] as const;

export function Backups({ envName }: { envName?: string }) {
  const { services, config, width, height, navigate, theme } = useApp();
  const active = useScreenActive();
  const envs = config?.environments ?? [];
  const [envIndex, setEnvIndex] = useSessionState(
    `backups:env:${envName ?? ""}`,
    Math.max(
      0,
      envs.findIndex((e) => e.name === envName),
    ),
  );
  const [filter, setFilter] = useSessionState("backups:filter", 0);
  const selection = useSessionState(`backups:index:${envIndex}:${filter}`, 0);
  const env = envs[Math.min(envIndex, envs.length - 1)];
  const status = FILTERS[filter];
  const backups = usePolling(
    () =>
      config && env
        ? services.backups(config, env.name, status === "all" ? {} : { status })
        : Promise.resolve([]),
    3000,
    [config, env?.name, status],
  );
  const list = backups.data ?? [];
  const nav = useListNav(list.length, {
    isActive: active,
    state: selection,
    onSelect: (i) => {
      const b = list[i];
      if (b && env) navigate({ name: "backup-detail", env: env.name, id: b.id });
    },
  });
  const shiftEnv = (delta: number) =>
    setEnvIndex((i) => (i + delta + envs.length) % Math.max(1, envs.length));
  const nextFilter = () => setFilter((f) => (f + 1) % FILTERS.length);
  useHints(
    [
      { key: "⏎", label: "details", run: () => nav.select() },
      { key: "←→", label: "environment", run: () => shiftEnv(1) },
      { key: "f", label: `filter: ${status}`, run: nextFilter },
    ],
    [status],
  );
  useInput(
    (input, key) => {
      if (isZoneKey(key)) return;
      if (key.leftArrow) shiftEnv(-1);
      else if (key.rightArrow) shiftEnv(1);
      else if (input === "f") nextFilter();
    },
    { isActive: active },
  );
  const total = list.reduce((s, b) => s + b.size, 0);
  return (
    <Panel
      title="Backups"
      width={width}
      height={height}
      focused={active}
      right={`${list.length} · ${formatBytes(total)}`}
    >
      <Box marginBottom={1}>
        <Text wrap="truncate-end">
          {envs.map((e, i) => (
            <Text
              key={e.name}
              inverse={i === envIndex}
              color={i === envIndex ? theme.accent : theme.muted}
            >
              {` ${e.name} `}
            </Text>
          ))}
          <Text color={theme.muted}>{`   filter: ${status}`}</Text>
        </Text>
      </Box>
      {envs.length === 0 ? (
        <Muted>No environments yet.</Muted>
      ) : (
        <ScrollList
          items={list}
          index={nav.index}
          height={height - 4}
          empty={backups.loading ? "loading…" : "no backups"}
          render={(b) => (
            <Text wrap="truncate-end">
              <StatusText status={b.status} label={cell(b.status, 11)} />
              {` ${cell(b.id, 18)}`}
              {cell(formatBytes(b.size), 10, "right")}
              <Text color={theme.muted}>
                {cell(
                  `  ${b.itemCount} items${b.failedCount ? `, ${b.failedCount} failed` : ""}`,
                  22,
                )}
              </Text>
              <Text color={theme.muted}>{formatAge(b.createdAt)}</Text>
            </Text>
          )}
        />
      )}
    </Panel>
  );
}

export function BackupDetail({ envName, id }: { envName: string; id: string }) {
  const { services, config, width, height, theme } = useApp();
  const active = useScreenActive();
  const [offset, setOffset] = useState(0);
  const backup = usePolling(
    () => (config ? services.backup(config, envName, id) : Promise.resolve(null)),
    0,
    [config, envName, id],
  );
  useHints([{ key: "↑↓", label: "scroll" }]);
  const b = backup.data;
  const lines: React.ReactNode[] = [];
  if (b) {
    const m = b.manifest;
    lines.push(
      <Text>
        <Text color={theme.muted}>{cell("status", 12)}</Text>
        <StatusText status={b.status} />
      </Text>,
      <Text>
        <Text color={theme.muted}>{cell("created", 12)}</Text>
        {formatDateTime(b.createdAt)}
        <Text color={theme.muted}>{`  (${formatAge(b.createdAt)})`}</Text>
      </Text>,
      <Text>
        <Text color={theme.muted}>{cell("size", 12)}</Text>
        {formatBytes(b.size)}
      </Text>,
      <Text wrap="truncate-end">
        <Text color={theme.muted}>{cell("path", 12)}</Text>
        {b.dir}
      </Text>,
    );
    if (m?.trigger || m?.jobId) {
      lines.push(
        <Text>
          <Text color={theme.muted}>{cell("trigger", 12)}</Text>
          {`${m.trigger ?? "—"}${m.jobId ? `  · job ${m.jobId}` : ""}`}
        </Text>,
      );
    }
    lines.push(
      <Text> </Text>,
      <Text bold color={theme.accent}>
        Items
      </Text>,
    );
    if (!m)
      lines.push(<Text color={theme.warning}>No manifest: this backup was interrupted.</Text>);
    for (const item of m?.items ?? []) {
      lines.push(
        <Text wrap="truncate-end">
          <StatusText status={item.status} label={cell(`${item.kind} ${item.name}`, 26)} />
          {cell(formatBytes(item.size), 10, "right")}
          <Text
            color={theme.muted}
          >{`  ${cell(formatDuration(item.durationMs), 8)} ${item.detail ?? ""}`}</Text>
        </Text>,
      );
      if (item.file)
        lines.push(
          <Text
            color={theme.muted}
            wrap="truncate-end"
          >{`    ${item.file}  sha256 ${item.sha256?.slice(0, 16)}…`}</Text>,
        );
      if (item.error)
        lines.push(<Text color={theme.error} wrap="truncate-end">{`    ✘ ${item.error}`}</Text>);
      for (const w of item.warnings ?? [])
        lines.push(<Text color={theme.warning} wrap="truncate-end">{`    ! ${w}`}</Text>);
    }
  }
  const viewHeight = height - 2;
  useInput(
    (input, key) => {
      const max = Math.max(0, lines.length - viewHeight);
      if (isUp(input, key)) setOffset((o) => Math.max(0, o - 1));
      else if (isDown(input, key)) setOffset((o) => Math.min(max, o + 1));
      else if (key.pageUp) setOffset((o) => Math.max(0, o - viewHeight));
      else if (key.pageDown) setOffset((o) => Math.min(max, o + viewHeight));
      else if (input === "g" || key.home) setOffset(0);
      else if (input === "G" || key.end) setOffset(max);
    },
    { isActive: active },
  );
  return (
    <Panel title={`Backup · ${envName} · ${id}`} width={width} height={height} focused={active}>
      {backup.loading && !b ? (
        <Muted>loading…</Muted>
      ) : !b ? (
        <Text color={theme.error}>backup not found</Text>
      ) : (
        <ScrollView lines={lines} height={viewHeight} offset={offset} />
      )}
    </Panel>
  );
}
