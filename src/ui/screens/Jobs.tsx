import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { formatAge, formatBytes, formatDateTime, formatDuration } from "../../core/format.js";
import type { JobEvent } from "../../core/jobs/events.js";
import type { JobRecord } from "../../core/jobs/store.js";
import { cell, Muted, Panel, Pulse, Spinner, StatusText } from "../components/basics.js";
import { ScrollList, ScrollView } from "../components/ScrollList.js";
import { useApp, useHints, useScreenActive, useSessionState } from "../context.js";
import { itemProgress, useJobEvents } from "../hooks/useJobEvents.js";
import { usePolling } from "../hooks/usePolling.js";
import { isDown, isUp, useListNav } from "../keys.js";

const isActiveJob = (j: JobRecord) => j.status === "running" || j.status === "queued";
const elapsed = (j: JobRecord) =>
  j.startedAt
    ? (j.finishedAt ? Date.parse(j.finishedAt) : Date.now()) - Date.parse(j.startedAt)
    : 0;

function useKill() {
  const { services, config, confirm, toast } = useApp();
  return (job: JobRecord | undefined) => {
    if (!job || !config || !isActiveJob(job)) return;
    void (async () => {
      const ok = await confirm({
        title: "Stop job",
        message: `Stop job ${job.id} (${job.targets.map((t) => t.environment).join(", ")})? The unfinished backup is discarded.`,
        confirmLabel: "Stop",
        danger: true,
      });
      if (!ok) return;
      toast(
        (await services.killJob(config, job.id)) ? "stop signal sent" : "job is not running",
        "info",
      );
    })();
  };
}

export function Jobs() {
  const { services, config, width, height, navigate, theme } = useApp();
  const active = useScreenActive();
  const jobs = usePolling(() => (config ? services.jobs(config, 100) : Promise.resolve([])), 1000, [
    config,
  ]);
  const list = jobs.data ?? [];
  const kill = useKill();
  const nav = useListNav(list.length, {
    isActive: active,
    state: useSessionState("jobs:index", 0),
    onSelect: (i) => {
      const j = list[i];
      if (j) navigate({ name: "job-live", id: j.id });
    },
  });
  useHints([
    { key: "⏎", label: "follow", run: () => nav.select() },
    { key: "x", label: "stop", run: () => kill(list[nav.index]) },
  ]);
  useInput((input) => input === "x" && kill(list[nav.index]), { isActive: active });
  return (
    <Panel
      title="Jobs"
      width={width}
      height={height}
      focused={active}
      right={`${list.filter(isActiveJob).length} running`}
    >
      <ScrollList
        items={list}
        index={nav.index}
        height={height - 2}
        empty={jobs.loading ? "loading…" : "no jobs yet; press n to start a backup"}
        render={(j) => (
          <Text wrap="truncate-end">
            {j.status === "running" ? (
              <Spinner label={cell("running", 9)} color={theme.info} />
            ) : (
              <StatusText status={j.status} label={cell(j.status, 9)} />
            )}
            {` ${cell(j.id, 21)}`}
            <Text color={theme.muted}>{cell(j.trigger, 9)}</Text>
            {cell(j.targets.map((t) => t.environment).join(", "), 18)}
            <Text
              color={theme.muted}
            >{`${cell(formatAge(j.createdAt), 9)} ${formatDuration(elapsed(j))}`}</Text>
            {j.error ? <Text color={theme.error}>{`  ${j.error}`}</Text> : null}
          </Text>
        )}
      />
    </Panel>
  );
}

function eventLine(e: JobEvent, theme: ReturnType<typeof useApp>["theme"]): React.ReactNode {
  const time = new Date(e.ts).toLocaleTimeString([], { hour12: false });
  const t = <Text color={theme.muted}>{`${time} `}</Text>;
  switch (e.type) {
    case "log": {
      const color =
        e.level === "error" ? theme.error : e.level === "warn" ? theme.warning : undefined;
      return (
        <Text wrap="truncate-end">
          {t}
          <Text color={color}>{`${e.environment ? `[${e.environment}] ` : ""}${e.message}`}</Text>
        </Text>
      );
    }
    case "item-start":
      return (
        <Text wrap="truncate-end">
          {t}
          {`[${e.environment}] ${e.kind} ${e.name} started (${e.index}/${e.total})`}
        </Text>
      );
    case "item-done":
      return (
        <Text wrap="truncate-end">
          {t}
          <Text color={e.status === "success" ? theme.success : theme.error}>
            {`[${e.environment}] ${e.kind} ${e.name} ${e.status === "success" ? `done, ${formatBytes(e.size)} in ${formatDuration(e.durationMs)}` : `failed: ${e.error ?? ""}`}`}
          </Text>
        </Text>
      );
    case "backup-done":
      return (
        <Text wrap="truncate-end">
          {t}
          <StatusText
            status={e.status}
            label={`[${e.environment}] backup ${e.backupId ?? ""} ${e.status}`}
          />
        </Text>
      );
    case "job-done":
      return (
        <Text wrap="truncate-end">
          {t}
          <StatusText status={e.status} label={`job ${e.status}${e.error ? `: ${e.error}` : ""}`} />
        </Text>
      );
    default:
      return null;
  }
}

export function JobLive({ id }: { id: string }) {
  const { services, config, width, height, theme } = useApp();
  const active = useScreenActive();
  const job = usePolling(() => (config ? services.job(config, id) : Promise.resolve(null)), 1000, [
    config,
    id,
  ]);
  const events = useJobEvents(services, config, id);
  const kill = useKill();
  const [offset, setOffset] = useState<number | null>(null); // null = follow the tail
  const j = job.data;
  const items = itemProgress(events);
  const logLines = events.filter((e) => e.type !== "item-progress").map((e) => eventLine(e, theme));
  const itemRows = Math.min(items.length, Math.max(2, Math.floor((height - 8) / 2)));
  const logHeight = Math.max(3, height - itemRows - 9);
  const max = Math.max(0, logLines.length - logHeight);
  useHints([
    { key: "↑↓", label: "scroll log" },
    { key: "G", label: "follow", run: () => setOffset(null) },
    { key: "x", label: "stop", run: () => kill(j ?? undefined) },
  ]);
  useInput(
    (input, key) => {
      const at = offset ?? max;
      if (input === "x") kill(j ?? undefined);
      else if (isUp(input, key)) setOffset(Math.max(0, at - 1));
      else if (isDown(input, key)) setOffset(at + 1 >= max ? null : at + 1);
      else if (key.pageUp) setOffset(Math.max(0, at - logHeight));
      else if (key.pageDown) setOffset(at + logHeight >= max ? null : at + logHeight);
      else if (input === "g" || key.home) setOffset(0);
      else if (input === "G" || key.end) setOffset(null);
    },
    { isActive: active },
  );
  if (!j)
    return (
      <Panel title={`Job ${id}`} width={width} height={height}>
        {job.loading ? <Muted>loading…</Muted> : <Text color={theme.error}>job not found</Text>}
      </Panel>
    );
  const running = isActiveJob(j);
  return (
    <Box flexDirection="column">
      <Panel title={`Job · ${j.id}`} width={width} focused={active} right={j.trigger}>
        <Box gap={2}>
          {running ? <Pulse /> : null}
          <StatusText status={j.status} />
          <Text>{j.targets.map((t) => t.environment).join(", ")}</Text>
          <Text
            color={theme.muted}
          >{`started ${j.startedAt ? formatDateTime(j.startedAt) : "—"} · ${formatDuration(elapsed(j))}`}</Text>
          {j.pid ? (
            <Text color={theme.muted}>{`pid ${j.pid}${j.detached ? " (detached)" : ""}`}</Text>
          ) : null}
        </Box>
        {j.error ? <Text color={theme.error}>{`✘ ${j.error}`}</Text> : null}
        {items.slice(-itemRows).map((i) => (
          <Text key={`${i.environment}/${i.kind}/${i.name}`} wrap="truncate-end">
            {i.status === "running" ? <Spinner /> : <StatusText status={i.status} label="" />}
            {` ${cell(`${i.environment} · ${i.kind} ${i.name}`, Math.max(20, width - 40))} `}
            <Text color={theme.muted}>
              {i.status === "running"
                ? `${formatBytes(i.bytes)}${i.files !== undefined ? ` · ${i.files} files` : ""}`
                : i.status === "failed"
                  ? (i.error ?? "failed")
                  : `${formatBytes(i.size ?? 0)} · ${formatDuration(i.durationMs ?? 0)}`}
            </Text>
          </Text>
        ))}
      </Panel>
      <Panel
        title="Log"
        width={width}
        right={offset === null ? "following" : "paused · G to follow"}
      >
        {logLines.length === 0 ? (
          <Muted>waiting for output…</Muted>
        ) : (
          <ScrollView lines={logLines} height={logHeight} offset={offset ?? max} />
        )}
      </Panel>
    </Box>
  );
}
