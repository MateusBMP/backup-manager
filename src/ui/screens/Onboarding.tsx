import { Box, Text } from "ink";
import { useState } from "react";
import { emptyConfig } from "../../core/config/defaults.js";
import { ConfigSchema } from "../../core/config/schema.js";
import { defaultBackupDir } from "../../core/paths.js";
import { ErrorLine, FormTip, GradientText, Panel } from "../components/basics.js";
import { type Field, Form, type Values } from "../components/Form.js";
import { useApp, useHints, useScreenActive } from "../context.js";
import { issuesToErrors, opt, optInt } from "./forms.js";

export function Onboarding() {
  const { services, width, height, save, navigate, theme } = useApp();
  const active = useScreenActive();
  const [values, setValues] = useState<Values>({ backupDir: "", keepLast: "7", keepDays: "30" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string[]>([]);

  const submit = async (values: Values) => {
    const base = emptyConfig();
    const parsed = ConfigSchema.safeParse({
      ...base,
      settings: { ...base.settings, backupDir: opt(values.backupDir) },
      retention: { keepLast: optInt(values.keepLast), keepDays: optInt(values.keepDays) },
    });
    if (!parsed.success) {
      const e = issuesToErrors(parsed.error, (p) =>
        p[0] === "settings"
          ? "backupDir"
          : p[0] === "retention"
            ? typeof p[1] === "string"
              ? p[1]
              : "keepLast"
            : null,
      );
      setErrors(e.fields);
      setGeneral(e.general);
      return;
    }
    if (await save(parsed.data, `created ${services.configPath}`)) {
      navigate({ name: "environment-edit", onboarding: true }, { replace: true });
    }
  };
  const fields: Field[] = [
    {
      kind: "text",
      key: "backupDir",
      label: "Backup dir",
      placeholder: defaultBackupDir(),
      error: errors.backupDir,
      hint: "where backups are written; empty = the default shown",
    },
    {
      kind: "number",
      key: "keepLast",
      label: "Keep last",
      error: errors.keepLast,
      hint: "newest complete backups to keep per environment",
    },
    {
      kind: "number",
      key: "keepDays",
      label: "Keep days",
      error: errors.keepDays,
      hint: "also keep anything younger than this many days",
    },
  ];
  useHints([
    { key: "tab", label: "field" },
    { key: "ctrl-s", label: "continue", run: () => void submit(values) },
  ]);
  return (
    <Panel title="Welcome" width={width} height={height} focused={active} right="step 1 of 2">
      <Box flexDirection="column" marginBottom={1}>
        <GradientText>Let's set up backup-manager</GradientText>
        <Text
          color={theme.muted}
        >{`No config yet at ${services.configPath}. Start with where backups go and how long to keep them.`}</Text>
      </Box>
      <Form
        id="onboarding"
        fields={fields}
        values={values}
        onChange={setValues}
        onSubmit={(v) => void submit(v)}
        onCancel={() => {}}
        isActive={active}
        width={width - 4}
      />
      {general.map((g) => (
        <ErrorLine key={g}>{g}</ErrorLine>
      ))}
      <Box marginTop={1}>
        <FormTip />
      </Box>
    </Panel>
  );
}
