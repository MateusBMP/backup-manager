import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { cell, Panel, Spinner } from "../components/basics.js";
import { ScrollView } from "../components/ScrollList.js";
import { useApp, useHints, useScreenActive } from "../context.js";
import { usePolling } from "../hooks/usePolling.js";
import { isDown, isUp } from "../keys.js";

export function Doctor() {
  const { services, width, height, theme } = useApp();
  const active = useScreenActive();
  const report = usePolling(() => services.doctor({ db: true }), 0);
  const [offset, setOffset] = useState(0);
  useHints([
    { key: "r", label: "re-run" },
    { key: "↑↓", label: "scroll" },
  ]);
  const color = { ok: theme.success, warn: theme.warning, fail: theme.error };
  const icon = { ok: "✔", warn: "!", fail: "✘" };
  const lines: React.ReactNode[] = [];
  let group = "";
  for (const c of report.data?.checks ?? []) {
    if (c.group !== group) {
      if (group) lines.push(<Text> </Text>);
      group = c.group;
      lines.push(
        <Text bold color={theme.accent}>
          {group}
        </Text>,
      );
    }
    lines.push(
      <Text wrap="truncate-end">
        <Text color={color[c.status]}>{`  ${icon[c.status]} `}</Text>
        {cell(c.name, 22)}
        <Text color={c.status === "ok" ? theme.muted : color[c.status]}>{c.detail}</Text>
      </Text>,
    );
  }
  const viewHeight = height - 4;
  useInput(
    (input, key) => {
      if (input === "r") report.refresh();
      else if (isUp(input, key)) setOffset((o) => Math.max(0, o - 1));
      else if (isDown(input, key))
        setOffset((o) => Math.min(Math.max(0, lines.length - viewHeight), o + 1));
    },
    { isActive: active },
  );
  const fails = report.data?.checks.filter((c) => c.status === "fail").length ?? 0;
  const warns = report.data?.checks.filter((c) => c.status === "warn").length ?? 0;
  return (
    <Panel title="Doctor" width={width} height={height} focused={active}>
      <Box marginBottom={1}>
        {report.loading ? (
          <Spinner label="checking config, tools, paths, databases and the service…" />
        ) : (
          <Text color={fails ? theme.error : warns ? theme.warning : theme.success}>
            {fails
              ? `✘ ${fails} problem(s), ${warns} warning(s)`
              : warns
                ? `! all good, ${warns} warning(s)`
                : "✔ all good"}
          </Text>
        )}
      </Box>
      <ScrollView lines={lines} height={viewHeight} offset={offset} />
    </Panel>
  );
}
