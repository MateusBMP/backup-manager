import { Text, useInput } from "ink";
import { describeSchedule } from "../../core/schedule.js";
import { cell, Panel } from "../components/basics.js";
import { ScrollList } from "../components/ScrollList.js";
import { useApp, useHints, useScreenActive, useSessionState } from "../context.js";
import { useListNav } from "../keys.js";
import { useRunNow } from "./Dashboard.js";

export function Environments() {
  const { config, width, height, navigate, theme, confirm, save } = useApp();
  const active = useScreenActive();
  const envs = config?.environments ?? [];
  const nav = useListNav(envs.length, {
    isActive: active,
    state: useSessionState("environments:index", 0),
    onSelect: (i) => navigate({ name: "environment-edit", env: envs[i]?.name }),
  });
  useHints([
    { key: "⏎", label: "edit" },
    { key: "a", label: "add" },
    { key: "d", label: "delete" },
    { key: "b", label: "backups" },
    { key: "r", label: "run now" },
  ]);
  useRunNow(active, () => envs[nav.index]?.name);
  useInput(
    (input) => {
      const env = envs[nav.index];
      if (input === "a") navigate({ name: "environment-edit" });
      else if (input === "b" && env) navigate({ name: "backups", env: env.name });
      else if (input === "d" && env && config) {
        void (async () => {
          const ok = await confirm({
            title: "Delete environment",
            message: `Remove '${env.name}' from the config? Its backups on disk are kept.`,
            confirmLabel: "Delete",
            danger: true,
          });
          if (ok)
            await save(
              { ...config, environments: envs.filter((e) => e.name !== env.name) },
              `deleted ${env.name}`,
            );
        })();
      }
    },
    { isActive: active },
  );
  const inner = width - 7;
  return (
    <Panel
      title="Environments"
      width={width}
      height={height}
      focused={active}
      right={`${envs.length}`}
    >
      <ScrollList
        items={envs}
        index={nav.index}
        height={height - 2}
        empty="No environments yet. Press a to add one."
        render={(e) => (
          <Text wrap="truncate-end">
            <Text bold>{cell(e.name, 16)}</Text>
            <Text color={theme.muted}>
              {cell(`${e.databases.length} db · ${e.projects.length} proj`, 16)}
            </Text>
            <Text color={e.schedule ? undefined : theme.muted}>
              {cell(
                e.schedule ? `⏱ ${describeSchedule(e.schedule)}` : "manual only",
                Math.max(10, inner - 32),
              )}
            </Text>
          </Text>
        )}
      />
    </Panel>
  );
}
