import type { Retention } from "../config/schema.js";
import type { BackupInfo } from "./catalog.js";

const DAY = 86_400_000;

/**
 * Backups the policy no longer protects, newest first. Pure logic.
 *
 * - Complete backups are kept when among the newest `keepLast` complete ones **or** younger
 *   than `keepDays` (0 disables a rule). The newest complete backup is always kept.
 * - Partial/incomplete backups are kept when younger than `keepDays` or newer than the newest
 *   complete backup, so failures since the last good run stay inspectable.
 */
export function selectForDeletion<T extends Pick<BackupInfo, "id" | "createdAt" | "status">>(
  backups: readonly T[],
  retention: Retention,
  now: Date,
): T[] {
  const ordered = [...backups].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
  );
  const young = (b: T) =>
    retention.keepDays > 0 && now.getTime() - b.createdAt.getTime() < retention.keepDays * DAY;
  const complete = ordered.filter((b) => b.status === "complete");
  const newest = complete[0];
  return ordered.filter((b) => {
    if (b.status === "complete") {
      const rank = complete.indexOf(b);
      return !(b === newest || rank < retention.keepLast || young(b));
    }
    const newerThanGood = !newest || b.createdAt.getTime() > newest.createdAt.getTime();
    return !(young(b) || newerThanGood);
  });
}
