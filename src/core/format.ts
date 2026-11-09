const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(value < 10 ? 1 : 0)} ${UNITS[unit]}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Compact relative age: `now`, `42s`, `5m`, `3h`, `2d`, `6w`. */
export function formatAge(from: Date | string | number, now: Date = new Date()): string {
  const diff = now.getTime() - new Date(from).getTime();
  if (!Number.isFinite(diff)) return "—";
  const s = Math.floor(Math.abs(diff) / 1000);
  let text: string;
  if (s < 5) return "now";
  if (s < 60) text = `${s}s`;
  else if (s < 3600) text = `${Math.floor(s / 60)}m`;
  else if (s < 86_400) text = `${Math.floor(s / 3600)}h`;
  else if (s < 86_400 * 14) text = `${Math.floor(s / 86_400)}d`;
  else text = `${Math.floor(s / (86_400 * 7))}w`;
  return diff >= 0 ? `${text} ago` : `in ${text}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `2026-11-09 03:15` in local time. */
export function formatDateTime(value: Date | string | number): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Backup/job id from a timestamp: `YYYYMMDD-HHMMSS` (local time). */
export function timestampId(d: Date = new Date()): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}
