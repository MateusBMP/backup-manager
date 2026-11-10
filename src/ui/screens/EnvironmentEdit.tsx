import { Box, Text } from "ink";
import { useState } from "react";
import {
  effectiveRetention,
  envBackupDir,
  findEnvironment,
  timezone,
} from "../../core/config/defaults.js";
import { ConfigSchema, type Environment } from "../../core/config/schema.js";
import { formatDateTime } from "../../core/format.js";
import { describeSchedule, nextRuns, scheduleError } from "../../core/schedule.js";
import { ErrorLine, FormTip, Panel } from "../components/basics.js";
import { type Field, Form, type Values } from "../components/Form.js";
import { useApp, useHints, useScreenActive } from "../context.js";
import { DatabaseEdit } from "./DatabaseEdit.js";
import { issuesToErrors, opt, optInt } from "./forms.js";
import { ProjectEdit } from "./ProjectEdit.js";

type Mode =
  | { kind: "env" }
  | { kind: "project"; index: number | null }
  | { kind: "database"; index: number | null };

function SchedulePreview({ schedule, tz }: { schedule: string; tz: string }) {
  const { theme } = useApp();
  if (!schedule.trim())
    return <Text color={theme.muted}>empty = manual only · e.g. "30 3 * * *" (03:30 daily)</Text>;
  const error = scheduleError(schedule.trim(), tz);
  if (error) return <Text color={theme.error}>✘ {error}</Text>;
  const runs = nextRuns(schedule.trim(), 3, tz);
  return (
    <Text>
      <Text color={theme.success}>{`✔ ${describeSchedule(schedule.trim())}`}</Text>
      <Text
        color={theme.muted}
      >{` · next ${runs.map((d) => formatDateTime(d)).join(", ")} (${tz})`}</Text>
    </Text>
  );
}

export function EnvironmentEdit({
  envName,
  onboarding,
}: {
  envName?: string;
  onboarding?: boolean;
}) {
  const { config, width, height, save, back, navigate, confirm, services, toast } = useApp();
  const active = useScreenActive();
  const original = config && envName ? findEnvironment(config, envName) : undefined;
  const [draft, setDraft] = useState<Environment>(() =>
    structuredClone(original ?? { name: "", projects: [], databases: [] }),
  );
  const [values, setValues] = useState<Values>({
    name: original?.name ?? "",
    schedule: original?.schedule ?? "",
    backupDir: original?.backupDir ?? "",
    keepLast:
      original?.retention?.keepLast !== undefined ? String(original.retention.keepLast) : "",
    keepDays:
      original?.retention?.keepDays !== undefined ? String(original.retention.keepDays) : "",
  });
  const [mode, setMode] = useState<Mode>({ kind: "env" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string[]>([]);
  const cancel = () => (onboarding ? undefined : back());
  useHints(
    mode.kind === "env"
      ? [
          { key: "tab/↑↓", label: "field" },
          { key: "⏎", label: "open" },
          { key: "d", label: "remove item" },
          { key: "ctrl-s", label: "save", run: () => void submit(values) },
          ...(onboarding ? [] : [{ key: "esc", label: "cancel", run: cancel }]),
        ]
      : null,
    [mode.kind],
  );
  if (!config) return null;
  const tz = timezone(config);

  const build = (values: Values): Environment => {
    const keepLast = optInt(values.keepLast);
    const keepDays = optInt(values.keepDays);
    const retention =
      keepLast !== undefined || keepDays !== undefined
        ? {
            ...(keepLast !== undefined ? { keepLast } : {}),
            ...(keepDays !== undefined ? { keepDays } : {}),
          }
        : undefined;
    const env: Environment = {
      ...draft,
      name: String(values.name).trim(),
      projects: draft.projects,
      databases: draft.databases,
    };
    delete env.schedule;
    delete env.backupDir;
    delete env.retention;
    const schedule = opt(values.schedule);
    const backupDir = opt(values.backupDir);
    if (schedule) env.schedule = schedule;
    if (backupDir) env.backupDir = backupDir;
    if (retention) env.retention = retention;
    return env;
  };

  const submit = async (current: Values) => {
    const env = build(current);
    const index = original ? config.environments.indexOf(original) : config.environments.length;
    const environments = [...config.environments];
    environments[index] = env;
    const parsed = ConfigSchema.safeParse({ ...config, environments });
    if (!parsed.success) {
      const e = issuesToErrors(parsed.error, (p) => {
        if (p[0] !== "environments" || p[1] !== index) return null;
        if (p[2] === "retention") return typeof p[3] === "string" ? p[3] : "keepLast";
        return typeof p[2] === "string" && ["name", "schedule", "backupDir"].includes(p[2])
          ? p[2]
          : null;
      });
      setErrors(e.fields);
      setGeneral(e.general.map((g) => g.replace(`environments[${index}].`, "")));
      return;
    }
    setErrors({});
    setGeneral([]);
    if (!(await save(parsed.data, original ? `saved ${env.name}` : `added ${env.name}`))) return;
    if (onboarding) {
      const install = await confirm({
        title: "Install the service?",
        message: env.schedule
          ? "Install the user-level systemd service now so the schedule runs automatically (no sudo)?"
          : "Install the user-level systemd service now (no sudo)? It runs schedules and serves the API.",
        confirmLabel: "Install",
      });
      if (install) {
        try {
          const r = await services.service.install();
          toast(
            r.warnings[0] ?? "service installed and started",
            r.warnings.length ? "warning" : "success",
          );
        } catch (error) {
          toast((error as Error).message, "error");
        }
      }
      navigate({ name: "dashboard" }, { replace: true });
      return;
    }
    back();
  };

  const removeProject = async (i: number) => {
    const p = draft.projects[i];
    if (!p) return;
    const users = draft.databases.filter(
      (d) => d.source.type === "laravel" && d.source.project === p.name,
    );
    if (users.length) {
      toast(
        `'${p.name}' is used by database ${users.map((u) => `'${u.name}'`).join(", ")}`,
        "warning",
      );
      return;
    }
    if (
      await confirm({
        title: "Remove project",
        message: `Remove project '${p.name}' from this environment?`,
        confirmLabel: "Remove",
        danger: true,
      })
    ) {
      setDraft({ ...draft, projects: draft.projects.filter((_, j) => j !== i) });
    }
  };
  const removeDatabase = async (i: number) => {
    const d = draft.databases[i];
    if (!d) return;
    if (
      await confirm({
        title: "Remove database",
        message: `Remove database '${d.name}' from this environment?`,
        confirmLabel: "Remove",
        danger: true,
      })
    ) {
      setDraft({ ...draft, databases: draft.databases.filter((_, j) => j !== i) });
    }
  };

  if (mode.kind === "project") {
    return (
      <ProjectEdit
        env={{ ...draft, name: String(values.name) }}
        index={mode.index}
        isActive={active}
        onCancel={() => setMode({ kind: "env" })}
        onApply={(env) => {
          setDraft({ ...draft, projects: env.projects, databases: env.databases });
          setMode({ kind: "env" });
        }}
      />
    );
  }
  if (mode.kind === "database") {
    return (
      <DatabaseEdit
        env={{ ...draft, name: String(values.name) }}
        index={mode.index}
        isActive={active}
        onCancel={() => setMode({ kind: "env" })}
        onApply={(env) => {
          setDraft({ ...draft, databases: env.databases });
          setMode({ kind: "env" });
        }}
      />
    );
  }

  const inherited = effectiveRetention(config, { name: "", projects: [], databases: [] });
  const defaultDir = String(values.name).trim()
    ? envBackupDir(config, { name: String(values.name).trim(), projects: [], databases: [] })
    : "<backupDir>/<name>";
  const fields: Field[] = [
    {
      kind: "text",
      key: "name",
      label: "Name",
      placeholder: "production",
      error: errors.name,
      hint: "lowercase letters, digits, - and _",
    },
    {
      kind: "text",
      key: "schedule",
      label: "Schedule",
      placeholder: "30 3 * * *",
      error: errors.schedule,
      hint: <SchedulePreview schedule={String(values.schedule)} tz={tz} />,
    },
    {
      kind: "text",
      key: "backupDir",
      label: "Backup dir",
      placeholder: defaultDir,
      error: errors.backupDir,
      hint: "leave empty for the default",
    },
    {
      kind: "number",
      key: "keepLast",
      label: "Keep last",
      placeholder: `inherit (${inherited.keepLast})`,
      error: errors.keepLast,
      hint: "newest complete backups to keep; 0 disables",
    },
    {
      kind: "number",
      key: "keepDays",
      label: "Keep days",
      placeholder: `inherit (${inherited.keepDays})`,
      error: errors.keepDays,
      hint: "keep backups younger than N days; 0 disables",
    },
    { kind: "heading", key: "h-projects", label: `Projects (${draft.projects.length})` },
    ...draft.projects.map(
      (p, i): Field => ({
        kind: "action",
        key: `project-${i}`,
        label: p.name,
        detail: `${p.path}  ·  ${p.include.join(", ")}`,
        onPress: () => setMode({ kind: "project", index: i }),
        onDelete: () => void removeProject(i),
      }),
    ),
    {
      kind: "action",
      key: "add-project",
      label: "+ Add project",
      detail: "a Laravel project whose storage is archived",
      onPress: () => setMode({ kind: "project", index: null }),
    },
    { kind: "heading", key: "h-databases", label: `Databases (${draft.databases.length})` },
    ...draft.databases.map(
      (d, i): Field => ({
        kind: "action",
        key: `database-${i}`,
        label: d.name,
        detail:
          d.source.type === "laravel"
            ? `from ${d.source.project}/.env`
            : `${d.source.schemas.join(", ")} @ ${d.source.socket ?? d.source.host ?? "localhost"}`,
        onPress: () => setMode({ kind: "database", index: i }),
        onDelete: () => void removeDatabase(i),
      }),
    ),
    {
      kind: "action",
      key: "add-database",
      label: "+ Add database",
      detail: "dumped with mariadb-dump",
      onPress: () => setMode({ kind: "database", index: null }),
    },
  ];
  return (
    <Panel
      title={
        onboarding
          ? "First environment"
          : original
            ? `Environment · ${original.name}`
            : "New environment"
      }
      width={width}
      height={height}
      focused={active}
      right={onboarding ? "step 2 of 2" : undefined}
    >
      <Form
        id="environment-edit"
        fields={fields}
        values={values}
        onChange={setValues}
        onSubmit={(v) => void submit(v)}
        onCancel={cancel}
        isActive={active}
        width={width - 4}
        height={height - 4 - general.length}
      />
      <Box flexDirection="column">
        {general.map((g) => (
          <ErrorLine key={g}>{g}</ErrorLine>
        ))}
        {onboarding && <FormTip />}
      </Box>
    </Panel>
  );
}
