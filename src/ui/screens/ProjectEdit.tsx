import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import {
  DEFAULT_EXCLUDE,
  DEFAULT_INCLUDE,
  type Environment,
  type Project,
  ProjectSchema,
} from "../../core/config/schema.js";
import { expandHome } from "../../core/paths.js";
import { ErrorLine, Panel } from "../components/basics.js";
import { type Field, Form, type Values } from "../components/Form.js";
import { useApp, useHints } from "../context.js";
import { joinList, splitList } from "../keys.js";
import { issuesToErrors } from "./forms.js";

function useArtisanHint(projectPath: string): { ok: boolean; text: string } | null {
  const [hint, setHint] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    const p = projectPath.trim();
    if (!p) return setHint(null);
    let alive = true;
    const timer = setTimeout(async () => {
      const dir = path.resolve(expandHome(p));
      const exists = await access(dir, constants.R_OK).then(
        () => true,
        () => false,
      );
      const artisan =
        exists &&
        (await access(path.join(dir, "artisan")).then(
          () => true,
          () => false,
        ));
      if (!alive) return;
      setHint(
        !exists
          ? { ok: false, text: "directory not found or not readable" }
          : artisan
            ? { ok: true, text: "Laravel project (artisan found)" }
            : { ok: false, text: "no artisan file here; is this the project root?" },
      );
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [projectPath]);
  return hint;
}

export function ProjectEdit({
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
  const { width, height, theme } = useApp();
  const original = index === null ? undefined : env.projects[index];
  const [values, setValues] = useState<Values>({
    name: original?.name ?? "",
    path: original?.path ?? "",
    include: joinList(original?.include ?? DEFAULT_INCLUDE),
    exclude: joinList(original?.exclude ?? DEFAULT_EXCLUDE),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string[]>([]);
  const hint = useArtisanHint(String(values.path));
  useHints([
    { key: "tab", label: "next field" },
    { key: "ctrl-s", label: "apply" },
    { key: "esc", label: "cancel" },
  ]);

  const submit = (values: Values) => {
    const candidate = {
      name: String(values.name).trim(),
      path: String(values.path).trim() ? path.resolve(expandHome(String(values.path).trim())) : "",
      include: splitList(String(values.include)),
      exclude: splitList(String(values.exclude)),
    };
    const parsed = ProjectSchema.safeParse(candidate);
    if (!parsed.success) {
      const e = issuesToErrors(parsed.error, (p) => (typeof p[0] === "string" ? p[0] : null));
      setErrors(e.fields);
      setGeneral(e.general);
      return;
    }
    const project: Project = parsed.data;
    if (env.projects.some((p, i) => i !== index && p.name === project.name)) {
      setErrors({ name: `project '${project.name}' already exists in this environment` });
      return;
    }
    const projects = [...env.projects];
    if (index === null) projects.push(project);
    else projects[index] = project;
    const renamed = original && original.name !== project.name;
    const databases = env.databases.map((db) =>
      renamed && db.source.type === "laravel" && db.source.project === original.name
        ? { ...db, source: { ...db.source, project: project.name } }
        : db,
    );
    onApply({ ...env, projects, databases });
  };

  const fields: Field[] = [
    {
      kind: "text",
      key: "name",
      label: "Name",
      placeholder: "shop",
      error: errors.name,
      hint: "lowercase letters, digits, - and _",
    },
    {
      kind: "text",
      key: "path",
      label: "Path",
      placeholder: "/var/www/shop",
      error: errors.path,
      hint: hint ? (
        <Text
          color={hint.ok ? theme.success : theme.warning}
        >{`${hint.ok ? "✔" : "!"} ${hint.text}`}</Text>
      ) : (
        "absolute path to the Laravel project root"
      ),
    },
    {
      kind: "text",
      key: "include",
      label: "Include",
      error: errors.include,
      hint: "directories to archive, comma separated, relative to the project",
    },
    {
      kind: "text",
      key: "exclude",
      label: "Exclude",
      error: errors.exclude,
      hint: "glob patterns, comma separated; 'dir/**' keeps the empty dir",
    },
  ];
  return (
    <Panel
      title={original ? `Project · ${original.name}` : "New project"}
      width={width}
      height={height}
      focused={isActive}
      right={`in ${env.name || "new environment"}`}
    >
      <Form
        id="project-edit"
        fields={fields}
        values={values}
        onChange={setValues}
        onSubmit={submit}
        onCancel={onCancel}
        isActive={isActive}
        width={width - 4}
        height={height - 4}
      />
      <Box flexDirection="column" marginTop={1}>
        {general.map((g) => (
          <ErrorLine key={g}>{g}</ErrorLine>
        ))}
      </Box>
    </Panel>
  );
}
