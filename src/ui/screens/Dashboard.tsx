import { Box, Text, useInput } from "ink";
import type { BackupInfo } from "../../core/backup/catalog.js";
import { formatAge, formatBytes, formatDuration } from "../../core/format.js";
import type { JobRecord } from "../../core/jobs/store.js";
import type { EnvironmentSummary } from "../../core/services.js";
import { cell, Muted, Panel, ProgressBar, Spinner, StatusText } from "../components/basics.js";
import { ScrollList } from "../components/ScrollList.js";
import { useApp, useHints, useScreenActive } from "../context.js";
import { type ItemProgress, itemProgress, jobFraction } from "../hooks/useJobEvents.js";
import { usePolling } from "../hooks/usePolling.js";
import { useListNav } from "../keys.js";

export function nextLabel(date: Date | null, now = new Date()): string {
  if (!date) return "—";
  const hhmm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.getTime() - now.getTime() < 86_400_000) return hhmm;
  return `${date.getMonth() + 1}/${date.getDate()} ${hhmm}`;
}

function EnvRow({ s, width }: { s: EnvironmentSummary; width: number }) {
  const { theme } = useApp();
  const counts = [s.databases ? `${s.databases} db` : "", s.projects ? `${s.projects} proj` : ""]
    .filter(Boolean)
    .join(" · ");
  return (
    <Text wrap="truncate-end">
      <Text bold>{cell(s.name, Math.min(16, Math.max(8, width - 60)))}</Text>
      <Text color={theme.muted}>{cell(counts || "empty", 16)}</Text>
      {cell(`${s.backups} bkp`, 8, "right")}
      {cell(formatBytes(s.totalSize), 10, "right")}
      {"  "}
      {s.runningPid ? (
        <Text color={theme.info}>{cell("● running", 10)}</Text>
      ) : s.last ? (
        <StatusText
          status={s.last.status}
          label={cell(formatAge(s.last.createdAt).replace(" ago", ""), 8)}
        />
      ) : (
        <Text color={theme.muted}>{cell("— never", 10)}</Text>
      )}
      <Text color={theme.muted}>{`  ⏱ ${nextLabel(s.nextRun)}`}</Text>
    </Text>
  );
}

function RunningRow({
  job,
  items,
  width,
}: {
  job: JobRecord;
  items: ItemProgress[];
  width: number;
}) {
  const { theme } = useApp();
  const current = items.filter((i) => i.status === "running").at(-1);
  const { done, total } = jobFraction(items);
  const started = job.startedAt ? Date.now() - Date.parse(job.startedAt) : 0;
  const label = current
    ? `${current.environment} · ${current.kind} ${current.name}`
    : job.targets.map((t) => t.environment).join(", ");
  const barWidth = Math.max(6, Math.min(16, width - 60));
  return (
    <Text wrap="truncate-end">
      <Spinner />
      {` ${cell(label, Math.max(12, width - barWidth - 30))} `}
      <ProgressBar value={total ? done / total : 0} width={barWidth} />
      {` ${cell(`${done}/${total || "?"}`, 5)} `}
      <Text color={theme.muted}>{`${cell(formatDuration(started), 7)} ${job.trigger}`}</Text>
    </Text>
  );
}

function RecentRow({ b }: { b: BackupInfo }) {
  const { theme } = useApp();
  return (
    <Text wrap="truncate-end">
      <StatusText status={b.status} label={cell(b.environment, 14)} />
      {` ${cell(b.id, 19)} `}
      <Text color={theme.muted}>{cell(b.status, 10)}</Text>
      {cell(formatBytes(b.size), 10, "right")}
      <Text color={theme.muted}>{`  ${formatAge(b.createdAt)}`}</Text>
    </Text>
  );
}

export function Dashboard() {
  const { services, config, width, height, navigate, theme } = useApp();
  const active = useScreenActive();
  const summaries = usePolling(
    () => (config ? services.summaries(config) : Promise.resolve([])),
    2000,
    [config],
  );
  const jobs = usePolling(() => (config ? services.jobs(config, 30) : Promise.resolve([])), 1000, [
    config,
  ]);
  const runningJobs = (jobs.data ?? []).filter(
    (j) => j.status === "running" || j.status === "queued",
  );
  const progress = usePolling(
    () =>
      config
        ? Promise.all(
            runningJobs.map(async (j) => ({
              id: j.id,
              items: itemProgress((await services.jobEvents(config, j.id)).events),
            })),
          )
        : Promise.resolve([]),
    1000,
    [config, runningJobs.map((j) => j.id).join()],
  );
  const recent = usePolling(
    () => (config ? services.recentBackups(config, 20) : Promise.resolve([])),
    3000,
    [config],
  );
  const envs = summaries.data ?? [];
  const nav = useListNav(envs.length, {
    isActive: active,
    onSelect: (i) => {
      const env = envs[i];
      if (env) navigate({ name: "backups", env: env.name });
    },
  });
  useHints(
    [
      { key: "↑↓", label: "move" },
      { key: "⏎", label: "backups" },
      { key: "r", label: "run now" },
      { key: "n", label: "new backup" },
      { key: "e", label: "environments" },
    ],
    [],
  );
  useRunNow(active, () => envs[nav.index]?.name);

  if (!config) return null;
  if (config.environments.length === 0) {
    return (
      <Panel title="Welcome" width={width} height={height}>
        <Text>No environments yet.</Text>
        <Muted>Press e to open Environments, then a to add one.</Muted>
      </Panel>
    );
  }
  const envHeight = Math.min(envs.length || 1, Math.max(3, Math.floor((height - 9) / 2)));
  const runHeight = Math.max(1, Math.min(runningJobs.length || 1, 4));
  const recentHeight = Math.max(1, height - envHeight - runHeight - 6);
  const inner = width - 4;
  return (
    <Box flexDirection="column">
      <Panel
        title="Environments"
        width={width}
        focused={active}
        right={summaries.error ?? undefined}
      >
        <ScrollList
          items={envs}
          index={nav.index}
          height={envHeight}
          render={(s) => <EnvRow s={s} width={inner - 3} />}
          empty={summaries.loading ? "loading…" : "no environments"}
          selectable={active}
        />
      </Panel>
      <Panel
        title="Running"
        width={width}
        right={runningJobs.length ? `${runningJobs.length}` : undefined}
      >
        {runningJobs.length === 0 ? (
          <Text color={theme.muted}>idle</Text>
        ) : (
          runningJobs
            .slice(0, runHeight)
            .map((j) => (
              <RunningRow
                key={j.id}
                job={j}
                items={progress.data?.find((p) => p.id === j.id)?.items ?? []}
                width={inner}
              />
            ))
        )}
      </Panel>
      <Panel title="Recent backups" width={width}>
        {(recent.data ?? []).length === 0 ? (
          <Text color={theme.muted}>{recent.loading ? "loading…" : "no backups yet"}</Text>
        ) : (
          (recent.data ?? [])
            .slice(0, recentHeight)
            .map((b) => <RecentRow key={`${b.environment}/${b.id}`} b={b} />)
        )}
      </Panel>
    </Box>
  );
}

/** `r` starts a detached backup of the selected environment and opens its live view. */
export function useRunNow(active: boolean, envName: () => string | undefined) {
  const { services, config, navigate, toast, confirm } = useApp();
  useInput(
    (input) => {
      if (input !== "r" || !config) return;
      const name = envName();
      if (!name) return;
      void (async () => {
        if (
          !(await confirm({
            title: "Run backup now",
            message: `Back up every database and project of '${name}' now?`,
            confirmLabel: "Run",
          }))
        )
          return;
        try {
          const job = await services.startBackup(config, [{ environment: name }]);
          toast(`backup of ${name} started`, "success");
          navigate({ name: "job-live", id: job.id });
        } catch (error) {
          toast((error as Error).message, "error");
        }
      })();
    },
    { isActive: active },
  );
}
