import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { previousRun } from "../schedule.js";

/** `<stateDir>/schedule.json`: the last scheduled fire time per environment. */
export type ScheduleState = Record<string, { schedule: string; lastFire: string }>;

export const scheduleFile = (stateDir: string) => path.join(stateDir, "schedule.json");

export async function readScheduleState(stateDir: string): Promise<ScheduleState> {
  try {
    const data = JSON.parse(await readFile(scheduleFile(stateDir), "utf8"));
    return data && typeof data === "object" ? (data as ScheduleState) : {};
  } catch {
    return {};
  }
}

export async function writeScheduleState(stateDir: string, state: ScheduleState): Promise<void> {
  const file = scheduleFile(stateDir);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

export interface CatchUpDecision {
  environment: string;
  /** The missed fire time to run now. */
  missed: Date | null;
}

/**
 * Like systemd `Persistent=true`: when the most recent scheduled time is later than the
 * recorded last fire, that run was missed while the daemon was down and runs once now.
 * Without a record (first start) or after a schedule change, nothing is caught up; the
 * baseline is set to the most recent scheduled time instead.
 */
export function planCatchUp(
  schedules: { environment: string; schedule: string }[],
  state: ScheduleState,
  now: Date,
  timezone?: string,
): { decisions: CatchUpDecision[]; state: ScheduleState } {
  const next: ScheduleState = {};
  const decisions: CatchUpDecision[] = [];
  for (const { environment, schedule } of schedules) {
    const previous = previousRun(schedule, now, timezone);
    const record = state[environment];
    let missed: Date | null = null;
    if (
      record &&
      record.schedule === schedule &&
      previous &&
      previous.getTime() > new Date(record.lastFire).getTime()
    ) {
      missed = previous;
    }
    decisions.push({ environment, missed });
    const baseline = previous ?? now;
    next[environment] = {
      schedule,
      lastFire:
        record && record.schedule === schedule && !missed
          ? record.lastFire
          : baseline.toISOString(),
    };
  }
  return { decisions, state: next };
}
