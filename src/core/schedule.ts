import { Cron } from "croner";

/** Returns an error message when `expr` is not a valid cron expression, otherwise `null`. */
export function scheduleError(expr: string, timezone?: string): string | null {
  try {
    new Cron(expr, { paused: true, ...(timezone ? { timezone } : {}) }).stop();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function nextRuns(expr: string, count: number, timezone?: string, from?: Date): Date[] {
  try {
    const cron = new Cron(expr, { paused: true, ...(timezone ? { timezone } : {}) });
    const runs = cron.nextRuns(count, from);
    cron.stop();
    return runs;
  } catch {
    return [];
  }
}

export function nextRun(expr: string | undefined, timezone?: string, from?: Date): Date | null {
  if (!expr) return null;
  return nextRuns(expr, 1, timezone, from)[0] ?? null;
}

/** Most recent scheduled fire time strictly before `reference`. */
export function previousRun(expr: string, reference: Date, timezone?: string): Date | null {
  try {
    const cron = new Cron(expr, { paused: true, ...(timezone ? { timezone } : {}) });
    const runs = cron.previousRuns(1, reference);
    cron.stop();
    return runs[0] ?? null;
  } catch {
    return null;
  }
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const isNum = (v: string | undefined): v is string => v !== undefined && /^\d+$/.test(v);
const hhmm = (h: string, m: string) => `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;

/** A short human description of common cron shapes; falls back to the expression itself. */
export function describeSchedule(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  const fields = parts.length === 6 ? parts.slice(1) : parts;
  const seconds = parts.length === 6 ? parts[0] : "0";
  if (fields.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = fields as [string, string, string, string, string];
  if (parts.length === 6 && seconds !== "0") {
    if (/^\*\/\d+$/.test(seconds ?? "") && [min, hour, dom, mon, dow].every((f) => f === "*")) {
      return `every ${seconds?.slice(2)} seconds`;
    }
    return `custom: ${expr}`;
  }
  const rest = [dom, mon, dow];
  if (min === "*" && hour === "*" && rest.every((f) => f === "*")) return "every minute";
  if (/^\*\/\d+$/.test(min) && hour === "*" && rest.every((f) => f === "*")) {
    return `every ${min.slice(2)} minutes`;
  }
  if (isNum(min) && hour === "*" && rest.every((f) => f === "*")) {
    return `hourly at minute ${min}`;
  }
  if (isNum(min) && /^\*\/\d+$/.test(hour) && rest.every((f) => f === "*")) {
    return `every ${hour.slice(2)} hours at minute ${min}`;
  }
  if (isNum(min) && isNum(hour)) {
    const at = hhmm(hour, min);
    if (rest.every((f) => f === "*")) return `daily at ${at}`;
    if (dom === "*" && mon === "*" && isNum(dow)) {
      return `weekly on ${DAYS[Number(dow) % 7]} at ${at}`;
    }
    if (dom === "*" && mon === "*" && dow === "1-5") return `weekdays at ${at}`;
    if (isNum(dom) && mon === "*" && dow === "*") return `monthly on day ${dom} at ${at}`;
  }
  return `custom: ${expr}`;
}
