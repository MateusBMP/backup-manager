import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { PrunePlan } from "../../core/backup/prune.js";
import { effectiveRetention, findEnvironment } from "../../core/config/defaults.js";
import { formatAge, formatBytes } from "../../core/format.js";
import { cell, Muted, Panel, Spinner } from "../components/basics.js";
import { ScrollView } from "../components/ScrollList.js";
import { useApp, useHints, useScreenActive } from "../context.js";
import { usePolling } from "../hooks/usePolling.js";
import { isDown, isUp } from "../keys.js";

export function Prune() {
  const { services, config, width, height, confirm, toast, theme } = useApp();
  const active = useScreenActive();
  const plans = usePolling<PrunePlan[]>(
    () => (config ? services.planPrune(config) : Promise.resolve([])),
    0,
    [config],
  );
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const list = plans.data ?? [];
  const toDelete = list.reduce((s, p) => s + p.delete.length + p.staleTemp.length, 0);
  const freed = list.reduce((s, p) => s + p.freedBytes, 0);

  const lines: React.ReactNode[] = [];
  for (const plan of list) {
    const env = config ? findEnvironment(config, plan.environment) : undefined;
    const r = config && env ? effectiveRetention(config, env) : null;
    lines.push(
      <Text>
        <Text bold color={theme.accent}>
          {cell(plan.environment, 18)}
        </Text>
        <Text color={theme.muted}>
          {r ? `keep last ${r.keepLast} or ${r.keepDays} days · ` : ""}
        </Text>
        {`keep ${plan.keep.length}, delete ${plan.delete.length}`}
      </Text>,
    );
    for (const b of plan.delete) {
      lines.push(
        <Text color={theme.error} wrap="truncate-end">
          {`  ✘ ${cell(b.id, 18)} ${cell(b.status, 11)}${cell(formatBytes(b.size), 10, "right")}  ${formatAge(b.createdAt)}`}
        </Text>,
      );
    }
    for (const t of plan.staleTemp)
      lines.push(<Text color={theme.warning} wrap="truncate-end">{`  ✘ stale ${t}`}</Text>);
    if (plan.delete.length + plan.staleTemp.length === 0)
      lines.push(<Text color={theme.muted}> nothing to delete</Text>);
  }
  const viewHeight = height - 5;

  const apply = () => {
    if (toDelete === 0 || busy) return;
    void (async () => {
      const ok = await confirm({
        title: "Apply retention",
        message: `Delete ${toDelete} item(s) and free ${formatBytes(freed)}? This cannot be undone.`,
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      setBusy(true);
      const r = await services.applyPrune(list);
      setBusy(false);
      toast(
        r.errors.length ? `deleted ${r.deleted}; ${r.errors[0]}` : `deleted ${r.deleted} item(s)`,
        r.errors.length ? "warning" : "success",
      );
      plans.refresh();
    })();
  };
  useHints([
    { key: "p", label: "apply", run: apply },
    { key: "r", label: "refresh", run: () => plans.refresh() },
    { key: "↑↓", label: "scroll" },
  ]);
  useInput(
    (input, key) => {
      if (isUp(input, key)) setOffset((o) => Math.max(0, o - 1));
      else if (isDown(input, key))
        setOffset((o) => Math.min(Math.max(0, lines.length - viewHeight), o + 1));
      else if (input === "r") plans.refresh();
      else if (input === "p") apply();
    },
    { isActive: active },
  );
  return (
    <Panel title="Prune" width={width} height={height} focused={active} right="dry run">
      <Box marginBottom={1}>
        {plans.loading || busy ? (
          <Spinner label={busy ? "deleting…" : "computing…"} />
        ) : (
          <Text>
            {toDelete ? (
              <Text
                color={theme.warning}
              >{`${toDelete} item(s) to delete, ${formatBytes(freed)} to free`}</Text>
            ) : (
              <Text color={theme.success}>✔ everything is within the retention policy</Text>
            )}
          </Text>
        )}
      </Box>
      {list.length === 0 && !plans.loading ? (
        <Muted>No environments.</Muted>
      ) : (
        <ScrollView lines={lines} height={viewHeight} offset={offset} />
      )}
    </Panel>
  );
}
