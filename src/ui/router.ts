export type Route =
  | { name: "onboarding" }
  | { name: "dashboard" }
  | { name: "environments" }
  | { name: "environment-edit"; env?: string; onboarding?: boolean }
  | { name: "backups"; env?: string }
  | { name: "backup-detail"; env: string; id: string }
  | { name: "jobs" }
  | { name: "job-live"; id: string }
  | { name: "new-backup"; env?: string }
  | { name: "prune" }
  | { name: "service" }
  | { name: "doctor" }
  | { name: "settings" };

export type RouteName = Route["name"];

export interface MenuItem {
  route: Route;
  label: string;
  /** Digit shortcut (1–9) and an optional letter alias. */
  key: string;
  alias?: string;
}

export const MENU: MenuItem[] = [
  { route: { name: "dashboard" }, label: "Dashboard", key: "1" },
  { route: { name: "environments" }, label: "Environments", key: "2", alias: "e" },
  { route: { name: "backups" }, label: "Backups", key: "3" },
  { route: { name: "jobs" }, label: "Jobs", key: "4" },
  { route: { name: "new-backup" }, label: "New backup", key: "5", alias: "n" },
  { route: { name: "prune" }, label: "Prune", key: "6" },
  { route: { name: "service" }, label: "Service", key: "7", alias: "s" },
  { route: { name: "doctor" }, label: "Doctor", key: "8" },
  { route: { name: "settings" }, label: "Settings", key: "9" },
];

/** Which menu entry a route belongs to (detail screens highlight their parent). */
export function menuIndex(route: Route): number {
  const parent: Partial<Record<RouteName, RouteName>> = {
    "environment-edit": "environments",
    "backup-detail": "backups",
    "job-live": "jobs",
    onboarding: "dashboard",
  };
  const name = parent[route.name] ?? route.name;
  return Math.max(
    0,
    MENU.findIndex((m) => m.route.name === name),
  );
}
