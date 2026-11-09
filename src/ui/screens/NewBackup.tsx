import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import type { JobTarget } from "../../core/jobs/store.js";
import { cell, Muted, Panel } from "../components/basics.js";
import { ScrollList } from "../components/ScrollList.js";
import { useApp, useBackHandler, useHints, useScreenActive } from "../context.js";
import { useListNav } from "../keys.js";

type Step = "envs" | "items" | "confirm";
interface Item {
  env: string;
  kind: "database" | "project";
  name: string;
}
const keyOf = (i: Item) => `${i.env}\u0000${i.kind}\u0000${i.name}`;

/** Build job targets; an environment with everything selected is sent without filters. */
export function buildTargets(
  envs: { name: string; databases: { name: string }[]; projects: { name: string }[] }[],
  picked: Set<string>,
  items: Item[],
): JobTarget[] {
  const targets: JobTarget[] = [];
  for (const env of envs) {
    const mine = items.filter((i) => i.env === env.name);
    const chosen = mine.filter((i) => picked.has(keyOf(i)));
    if (chosen.length === 0) continue;
    if (chosen.length === mine.length) targets.push({ environment: env.name });
    else
      targets.push({
        environment: env.name,
        databases: chosen.filter((i) => i.kind === "database").map((i) => i.name),
        projects: chosen.filter((i) => i.kind === "project").map((i) => i.name),
      });
  }
  return targets;
}

export function NewBackup({ envName }: { envName?: string }) {
  const { config, services, width, height, navigate, toast, theme } = useApp();
  const active = useScreenActive();
  const envs = (config?.environments ?? []).filter(
    (e) => e.databases.length + e.projects.length > 0,
  );
  const [step, setStep] = useState<Step>("envs");
  const [selectedEnvs, setSelectedEnvs] = useState<Set<string>>(
    () => new Set(envName ? [envName] : envs.length === 1 ? [envs[0]!.name] : []),
  );
  const items = useMemo<Item[]>(
    () =>
      envs
        .filter((e) => selectedEnvs.has(e.name))
        .flatMap((e) => [
          ...e.databases.map((d) => ({ env: e.name, kind: "database" as const, name: d.name })),
          ...e.projects.map((p) => ({ env: e.name, kind: "project" as const, name: p.name })),
        ]),
    [envs, selectedEnvs],
  );
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const picked = new Set(items.map(keyOf).filter((k) => !excluded.has(k)));
  const [starting, setStarting] = useState(false);

  const envNav = useListNav(envs.length, { isActive: active && step === "envs" });
  const itemNav = useListNav(items.length, { isActive: active && step === "items" });
  useHints(
    step === "confirm"
      ? [
          { key: "⏎", label: "start" },
          { key: "esc", label: "back" },
        ]
      : [
          { key: "space", label: "toggle" },
          { key: "a", label: "all/none" },
          { key: "⏎", label: "next" },
          { key: "esc", label: "back" },
        ],
    [step],
  );

  const start = async () => {
    if (!config || starting) return;
    setStarting(true);
    try {
      const job = await services.startBackup(config, buildTargets(envs, picked, items));
      toast("backup started; it keeps running if you quit", "success");
      navigate({ name: "job-live", id: job.id }, { replace: true });
    } catch (error) {
      toast((error as Error).message, "error");
      setStarting(false);
    }
  };

  useBackHandler(() => {
    if (step === "envs") return false;
    setStep(step === "confirm" ? "items" : "envs");
    return true;
  });
  useInput(
    (input, key) => {
      if (step === "envs") {
        const env = envs[envNav.index];
        if (input === " " && env) {
          const next = new Set(selectedEnvs);
          next.has(env.name) ? next.delete(env.name) : next.add(env.name);
          setSelectedEnvs(next);
        } else if (input === "a") {
          setSelectedEnvs(
            selectedEnvs.size === envs.length ? new Set() : new Set(envs.map((e) => e.name)),
          );
        } else if (key.return) {
          if (selectedEnvs.size === 0 && env) setSelectedEnvs(new Set([env.name]));
          setStep("items");
        }
      } else if (step === "items") {
        const item = items[itemNav.index];
        if (input === " " && item) {
          const next = new Set(excluded);
          next.has(keyOf(item)) ? next.delete(keyOf(item)) : next.add(keyOf(item));
          setExcluded(next);
        } else if (input === "a") {
          setExcluded(picked.size === items.length ? new Set(items.map(keyOf)) : new Set());
        } else if (key.return && picked.size > 0) setStep("confirm");
      } else if (step === "confirm") {
        if (key.return) void start();
      }
    },
    { isActive: active },
  );

  if (!config) return null;
  if (envs.length === 0) {
    return (
      <Panel title="New backup" width={width} height={height} focused={active}>
        <Muted>No environment has a database or project yet. Add them in Environments (e).</Muted>
      </Panel>
    );
  }
  const check = (on: boolean) => (
    <Text color={on ? theme.success : theme.muted}>{on ? "◉ " : "○ "}</Text>
  );
  const steps = ["1 environments", "2 items", "3 confirm"];
  const current = step === "envs" ? 0 : step === "items" ? 1 : 2;
  return (
    <Panel title="New backup" width={width} height={height} focused={active}>
      <Box marginBottom={1}>
        {steps.map((s, i) => (
          <Text key={s} color={i === current ? theme.accent : theme.muted} bold={i === current}>
            {`${s}${i < steps.length - 1 ? "  ›  " : ""}`}
          </Text>
        ))}
      </Box>
      {step === "envs" && (
        <ScrollList
          items={envs}
          index={envNav.index}
          height={height - 4}
          render={(e) => (
            <Text wrap="truncate-end">
              {check(selectedEnvs.has(e.name))}
              <Text bold>{cell(e.name, 18)}</Text>
              <Text
                color={theme.muted}
              >{`${e.databases.length} db · ${e.projects.length} proj`}</Text>
            </Text>
          )}
        />
      )}
      {step === "items" && (
        <ScrollList
          items={items}
          index={itemNav.index}
          height={height - 4}
          render={(i) => (
            <Text wrap="truncate-end">
              {check(picked.has(keyOf(i)))}
              <Text color={theme.muted}>{cell(i.env, 16)}</Text>
              {cell(i.kind, 10)}
              <Text bold>{i.name}</Text>
            </Text>
          )}
        />
      )}
      {step === "confirm" && (
        <Box flexDirection="column">
          {buildTargets(envs, picked, items).map((t) => (
            <Text key={t.environment} wrap="truncate-end">
              <Text bold>{cell(t.environment, 18)}</Text>
              {t.databases || t.projects
                ? [
                    ...(t.databases ?? []).map((d) => `db ${d}`),
                    ...(t.projects ?? []).map((p) => `project ${p}`),
                  ].join(", ")
                : "everything"}
            </Text>
          ))}
          <Box marginTop={1}>
            <Text color={theme.muted}>
              The job runs detached: you can quit the UI or lose SSH and it keeps going.
            </Text>
          </Box>
          <Text color={theme.accent}>{starting ? "starting…" : "press ⏎ to start"}</Text>
        </Box>
      )}
    </Panel>
  );
}
