import type { z } from "zod";
import { formatIssuePath } from "../../core/config/load.js";

/** Map zod issues to form field keys via a path → key function; others go to `general`. */
export function issuesToErrors(
  error: z.ZodError,
  keyFor: (path: (string | number)[]) => string | null,
): { fields: Record<string, string>; general: string[] } {
  const fields: Record<string, string> = {};
  const general: string[] = [];
  for (const issue of error.issues) {
    const path = issue.path.filter((p): p is string | number => typeof p !== "symbol");
    const key = keyFor(path);
    if (key && !fields[key]) fields[key] = issue.message;
    else if (!key) general.push(`${formatIssuePath(path)}: ${issue.message}`);
  }
  return { fields, general };
}

export const opt = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : undefined;
};

export const optInt = (v: unknown): number | undefined => {
  const s = opt(v);
  return s === undefined ? undefined : Number.parseInt(s, 10);
};
