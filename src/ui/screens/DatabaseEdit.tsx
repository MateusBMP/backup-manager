import { Box, Text } from "ink";
import { useState } from "react";
import { type Database, DatabaseSchema, type Environment } from "../../core/config/schema.js";
import { ErrorLine, Panel, Spinner } from "../components/basics.js";
import { type Field, Form, type Values } from "../components/Form.js";
import { useApp, useHints } from "../context.js";
import { joinList, splitList } from "../keys.js";
import { issuesToErrors, opt, optInt } from "./forms.js";

function initialValues(db: Database | undefined, env: Environment): Values {
  const s = db?.source;
  return {
    name: db?.name ?? "",
    type: s?.type ?? (env.projects.length ? "laravel" : "connection"),
    project: s?.type === "laravel" ? s.project : (env.projects[0]?.name ?? ""),
    database: s?.type === "laravel" ? (s.database ?? "") : "",
    schemas: s?.type === "connection" ? joinList(s.schemas) : "",
    host: s?.host ?? "",
    port: s?.port ? String(s.port) : "",
    socket: s?.socket ?? "",
    user: s?.user ?? "",
    password: s?.password ?? "",
    passwordFile: s?.passwordFile ?? "",
    extraArgs: joinList(db?.extraArgs ?? []),
  };
}

export function buildDatabase(values: Values): unknown {
  const common = {
    host: opt(values.host),
    port: optInt(values.port),
    socket: opt(values.socket),
    user: opt(values.user),
    password: values.password === "" ? undefined : String(values.password),
    passwordFile: opt(values.passwordFile),
  };
  const source =
    values.type === "laravel"
      ? {
          type: "laravel",
          project: String(values.project),
          database: opt(values.database),
          ...common,
        }
      : { type: "connection", schemas: splitList(String(values.schemas)), ...common };
  return {
    name: String(values.name).trim(),
    source: Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined)),
    extraArgs: splitList(String(values.extraArgs)),
  };
}

export function DatabaseEdit({
  env,
  index,
  onApply,
  onCancel,
  isActive,
}: {
  env: Environment;
  index: number | null;
  onApply(env: Environment): void;
  onCancel(): void;
  isActive: boolean;
}) {
  const { width, height, theme, services } = useApp();
  const original = index === null ? undefined : env.databases[index];
  const [values, setValues] = useState<Values>(() => initialValues(original, env));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string[]>([]);
  const [test, setTest] = useState<
    { state: "running" } | { state: "done"; ok: boolean; message: string } | null
  >(null);

  const validate = (values: Values): Database | null => {
    const parsed = DatabaseSchema.safeParse(buildDatabase(values));
    if (!parsed.success) {
      const e = issuesToErrors(parsed.error, (p) => {
        if (p[0] === "source" && typeof p[1] === "string" && p[1] !== "type") return p[1];
        if (p[0] === "name" || p[0] === "extraArgs") return p[0];
        return null;
      });
      setErrors(e.fields);
      setGeneral(e.general);
      return null;
    }
    const db = parsed.data;
    const errs: Record<string, string> = {};
    if (db.source.password !== undefined && db.source.passwordFile)
      errs.passwordFile = "set password or passwordFile, not both";
    if (env.databases.some((d, i) => i !== index && d.name === db.name))
      errs.name = `database '${db.name}' already exists`;
    if (
      db.source.type === "laravel" &&
      !env.projects.some((p) => p.name === (db.source as { project: string }).project)
    ) {
      errs.project = "add a project to this environment first";
    }
    setErrors(errs);
    setGeneral([]);
    return Object.keys(errs).length ? null : db;
  };

  const submit = (current: Values) => {
    const db = validate(current);
    if (!db) return;
    const databases = [...env.databases];
    if (index === null) databases.push(db);
    else databases[index] = db;
    onApply({ ...env, databases });
  };

  const runTest = () => {
    const db = validate(values);
    if (!db) return;
    setTest({ state: "running" });
    void services.testConnection(env, db).then((r) => setTest({ state: "done", ...r }));
  };

  useHints([
    { key: "tab", label: "field" },
    { key: "←→", label: "change" },
    { key: "ctrl-s", label: "apply", run: () => submit(values) },
    { key: "esc", label: "cancel", run: onCancel },
  ]);

  const laravel = values.type === "laravel";
  const fields: Field[] = [
    { kind: "text", key: "name", label: "Name", placeholder: "shop", error: errors.name },
    {
      kind: "select",
      key: "type",
      label: "Source",
      options: [
        { label: "Laravel .env", value: "laravel" },
        { label: "Connection", value: "connection" },
      ],
      hint: laravel
        ? "DB_* values from the project's .env; fields below override them"
        : "explicit host/socket and schemas",
    },
    ...(laravel
      ? ([
          {
            kind: "select",
            key: "project",
            label: "Project",
            options: env.projects.map((p) => ({ label: p.name, value: p.name })),
            error: errors.project,
          },
          {
            kind: "text",
            key: "database",
            label: "Database",
            placeholder: "from .env DB_DATABASE",
            error: errors.database,
          },
        ] as Field[])
      : ([
          {
            kind: "text",
            key: "schemas",
            label: "Schemas",
            placeholder: "app, reports",
            error: errors.schemas,
            hint: "comma separated; several go into one file",
          },
        ] as Field[])),
    {
      kind: "text",
      key: "host",
      label: "Host",
      placeholder: laravel ? "from .env DB_HOST" : "localhost",
      error: errors.host,
    },
    {
      kind: "number",
      key: "port",
      label: "Port",
      placeholder: laravel ? "from .env DB_PORT" : "3306",
      error: errors.port,
    },
    {
      kind: "text",
      key: "socket",
      label: "Socket",
      placeholder: "unix socket (instead of host)",
      error: errors.socket,
    },
    {
      kind: "text",
      key: "user",
      label: "User",
      placeholder: laravel ? "from .env DB_USERNAME" : "",
      error: errors.user,
    },
    {
      kind: "password",
      key: "password",
      label: "Password",
      placeholder: laravel ? "from .env DB_PASSWORD" : "",
      error: errors.password,
      hint: "stored in config.json (mode 0600); prefer a password file",
    },
    {
      kind: "text",
      key: "passwordFile",
      label: "Password file",
      placeholder: "~/.config/backup-manager/db.pw",
      error: errors.passwordFile,
    },
    {
      kind: "text",
      key: "extraArgs",
      label: "Extra args",
      placeholder: "--ignore-table=app.sessions",
      error: errors.extraArgs,
      hint: "extra mariadb-dump arguments, comma separated",
    },
    {
      kind: "action",
      key: "test",
      label: "Test connection",
      detail: "⏎ run SELECT 1",
      onPress: runTest,
    },
  ];
  return (
    <Panel
      title={original ? `Database · ${original.name}` : "New database"}
      width={width}
      height={height}
      focused={isActive}
      right={`in ${env.name || "new environment"}`}
    >
      <Form
        id="database-edit"
        fields={fields}
        values={values}
        onChange={setValues}
        onSubmit={submit}
        onCancel={onCancel}
        isActive={isActive}
        width={width - 4}
        height={height - 5}
      />
      <Box flexDirection="column" marginTop={1}>
        {test?.state === "running" && <Spinner label="testing connection…" />}
        {test?.state === "done" && (
          <Text
            color={test.ok ? theme.success : theme.error}
          >{`${test.ok ? "✔" : "✘"} ${test.message}`}</Text>
        )}
        {general.map((g) => (
          <ErrorLine key={g}>{g}</ErrorLine>
        ))}
      </Box>
    </Panel>
  );
}
