import { Box, Text } from "ink";
import { useState } from "react";
import { emptyConfig } from "../../core/config/defaults.js";
import { type Config, ConfigSchema } from "../../core/config/schema.js";
import { defaultBackupDir, defaultStateDir } from "../../core/paths.js";
import { systemTimezone } from "../../core/schedule.js";
import { ErrorLine, Panel } from "../components/basics.js";
import { type Field, Form, type Values } from "../components/Form.js";
import { useApp, useHints, useScreenActive } from "../context.js";
import { issuesToErrors, opt, optInt } from "./forms.js";

export function settingsValues(c: Config): Values {
  return {
    backupDir: c.settings.backupDir ?? "",
    stateDir: c.settings.stateDir ?? "",
    compressLevel: String(c.settings.compressLevel),
    autoPrune: c.settings.autoPrune,
    timezone: c.settings.timezone ?? "",
    maxConcurrentJobs: String(c.settings.maxConcurrentJobs),
    keepLast: String(c.retention.keepLast),
    keepDays: String(c.retention.keepDays),
    apiEnabled: c.api.enabled,
    apiHost: c.api.host,
    apiPort: String(c.api.port),
    apiToken: c.api.token ?? "",
    apiTokenFile: c.api.tokenFile ?? "",
  };
}

export function applySettings(c: Config, v: Values): unknown {
  return {
    ...c,
    settings: {
      backupDir: opt(v.backupDir),
      stateDir: opt(v.stateDir),
      compressLevel: optInt(v.compressLevel),
      autoPrune: Boolean(v.autoPrune),
      timezone: opt(v.timezone),
      maxConcurrentJobs: optInt(v.maxConcurrentJobs),
    },
    retention: { keepLast: optInt(v.keepLast), keepDays: optInt(v.keepDays) },
    api: {
      enabled: Boolean(v.apiEnabled),
      host: opt(v.apiHost),
      port: optInt(v.apiPort),
      token: opt(v.apiToken),
      tokenFile: opt(v.apiTokenFile),
    },
  };
}

const PATH_KEYS: Record<string, string> = {
  "settings.backupDir": "backupDir",
  "settings.stateDir": "stateDir",
  "settings.compressLevel": "compressLevel",
  "settings.timezone": "timezone",
  "settings.maxConcurrentJobs": "maxConcurrentJobs",
  "retention.keepLast": "keepLast",
  "retention.keepDays": "keepDays",
  retention: "keepLast",
  "api.host": "apiHost",
  "api.port": "apiPort",
  "api.token": "apiToken",
  "api.tokenFile": "apiTokenFile",
};

export function Settings() {
  const { config, width, height, save, back, confirm } = useApp();
  const active = useScreenActive();
  const [values, setValues] = useState<Values>(() => settingsValues(config ?? emptyConfig()));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string[]>([]);
  useHints([
    { key: "tab", label: "field" },
    { key: "space", label: "toggle" },
    { key: "ctrl-s", label: "save" },
    { key: "esc", label: "leave" },
  ]);
  if (!config) return null;

  const submit = async (current: Values) => {
    const parsed = ConfigSchema.safeParse(applySettings(config, current));
    if (!parsed.success) {
      const e = issuesToErrors(
        parsed.error,
        (p) => PATH_KEYS[p.slice(0, 2).join(".")] ?? PATH_KEYS[String(p[0])] ?? null,
      );
      setErrors(e.fields);
      setGeneral(e.general);
      return;
    }
    setErrors({});
    setGeneral([]);
    await save(parsed.data, "settings saved");
  };
  const fields: Field[] = [
    { kind: "heading", key: "h1", label: "Storage" },
    {
      kind: "text",
      key: "backupDir",
      label: "Backup dir",
      placeholder: defaultBackupDir(),
      error: errors.backupDir,
    },
    {
      kind: "text",
      key: "stateDir",
      label: "State dir",
      placeholder: defaultStateDir(),
      error: errors.stateDir,
      hint: "jobs, logs, locks and schedule state",
    },
    {
      kind: "number",
      key: "compressLevel",
      label: "Compression",
      error: errors.compressLevel,
      hint: "gzip level 1 (fast) … 9 (small)",
    },
    { kind: "heading", key: "h2", label: "Retention" },
    {
      kind: "number",
      key: "keepLast",
      label: "Keep last",
      error: errors.keepLast,
      hint: "newest complete backups kept per environment",
    },
    {
      kind: "number",
      key: "keepDays",
      label: "Keep days",
      error: errors.keepDays,
      hint: "complete backups younger than this are kept",
    },
    {
      kind: "toggle",
      key: "autoPrune",
      label: "Auto prune",
      hint: "apply retention after every complete backup",
    },
    { kind: "heading", key: "h3", label: "Scheduler" },
    {
      kind: "text",
      key: "timezone",
      label: "Timezone",
      placeholder: systemTimezone(),
      error: errors.timezone,
    },
    {
      kind: "number",
      key: "maxConcurrentJobs",
      label: "Max parallel jobs",
      error: errors.maxConcurrentJobs,
    },
    { kind: "heading", key: "h4", label: "HTTP API (served by the daemon)" },
    { kind: "toggle", key: "apiEnabled", label: "Enabled" },
    {
      kind: "text",
      key: "apiHost",
      label: "Host",
      error: errors.apiHost,
      hint: "127.0.0.1 keeps it local; other addresses should use a token",
    },
    { kind: "number", key: "apiPort", label: "Port", error: errors.apiPort },
    {
      kind: "password",
      key: "apiToken",
      label: "Token",
      error: errors.apiToken,
      placeholder: "none",
    },
    {
      kind: "text",
      key: "apiTokenFile",
      label: "Token file",
      error: errors.apiTokenFile,
      placeholder: "none",
    },
  ];
  return (
    <Panel title="Settings" width={width} height={height} focused={active}>
      <Form
        id="settings"
        fields={fields}
        values={values}
        onChange={setValues}
        onSubmit={(v) => void submit(v)}
        onCancel={() =>
          void (async () => {
            const dirty = JSON.stringify(values) !== JSON.stringify(settingsValues(config));
            if (
              !dirty ||
              (await confirm({
                title: "Discard changes",
                message: "Leave Settings without saving?",
                confirmLabel: "Discard",
                danger: true,
              }))
            )
              back();
          })()
        }
        isActive={active}
        width={width - 4}
        height={height - 3 - general.length}
      />
      <Box flexDirection="column">
        {general.map((g) => (
          <ErrorLine key={g}>{g}</ErrorLine>
        ))}
      </Box>
      <Text> </Text>
    </Panel>
  );
}
