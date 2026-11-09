import { Box, renderToString, Text } from "ink";
import Gradient from "ink-gradient";
import type { ReactElement } from "react";
import type { CheckStatus, DoctorReport } from "../../core/doctor.js";
import { ICONS, makeTheme, type Theme } from "../theme.js";

export interface PrintOptions {
  /** Plain text: no ANSI (no TTY or NO_COLOR). */
  plain: boolean;
  columns?: number;
}

export function printOptions(stream: NodeJS.WriteStream = process.stdout): PrintOptions {
  const plain = !stream.isTTY || ("NO_COLOR" in process.env && process.env.NO_COLOR !== "0");
  return { plain, columns: stream.columns || 100 };
}

function render(element: ReactElement, options: PrintOptions): string {
  return renderToString(element, { columns: options.columns ?? 100 });
}

const ICON: Record<CheckStatus, string> = { ok: ICONS.ok, warn: ICONS.warn, fail: ICONS.fail };

function groupChecks(report: DoctorReport) {
  const groups = new Map<string, DoctorReport["checks"]>();
  for (const check of report.checks) {
    const list = groups.get(check.group) ?? [];
    list.push(check);
    groups.set(check.group, list);
  }
  return groups;
}

function summary(report: DoctorReport): { text: string; status: CheckStatus } {
  const fails = report.checks.filter((c) => c.status === "fail").length;
  const warns = report.checks.filter((c) => c.status === "warn").length;
  if (fails) return { text: `${fails} problem(s), ${warns} warning(s)`, status: "fail" };
  if (warns) return { text: `all good, ${warns} warning(s)`, status: "warn" };
  return { text: "all good", status: "ok" };
}

function Title({ t, children }: { t: Theme; children: string }) {
  return t.color ? (
    <Gradient colors={t.gradient}>
      <Text bold>{children}</Text>
    </Gradient>
  ) : (
    <Text bold>{children}</Text>
  );
}

function DoctorView({ report, t }: { report: DoctorReport; t: Theme }) {
  const color = { ok: t.success, warn: t.warning, fail: t.error };
  const width = Math.max(...report.checks.map((c) => c.name.length), 8);
  const s = summary(report);
  return (
    <Box flexDirection="column">
      <Title t={t}>backup-manager doctor</Title>
      <Text color={t.muted}>{report.configPath}</Text>
      {[...groupChecks(report)].map(([group, checks]) => (
        <Box key={group} flexDirection="column" marginTop={1}>
          <Text bold color={t.accent}>
            {group}
          </Text>
          {checks.map((c) => (
            <Box key={`${c.name}\u0000${c.detail}`}>
              <Box width={4} flexShrink={0}>
                <Text color={color[c.status]}>{`  ${ICON[c.status]}`}</Text>
              </Box>
              <Box width={width + 2} flexShrink={0}>
                <Text>{c.name}</Text>
              </Box>
              <Text color={c.status === "ok" ? t.muted : undefined}>{c.detail}</Text>
            </Box>
          ))}
        </Box>
      ))}
      <Box marginTop={1}>
        <Text bold color={color[s.status]}>
          {`${ICON[s.status]} ${s.text}`}
        </Text>
      </Box>
    </Box>
  );
}

export function doctorText(report: DoctorReport, options: PrintOptions): string {
  if (!options.plain) return render(<DoctorView report={report} t={makeTheme(true)} />, options);
  const lines = ["backup-manager doctor", report.configPath];
  const width = Math.max(...report.checks.map((c) => c.name.length), 8);
  for (const [group, checks] of groupChecks(report)) {
    lines.push("", group);
    for (const c of checks) lines.push(`  ${ICON[c.status]} ${c.name.padEnd(width)}  ${c.detail}`);
  }
  const s = summary(report);
  lines.push("", `${ICON[s.status]} ${s.text}`);
  return lines.join("\n");
}
