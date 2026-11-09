import { watch } from "node:fs";
import path from "node:path";
import { useEffect, useRef, useState } from "react";
import { stateDir } from "../../core/config/defaults.js";
import type { Config } from "../../core/config/schema.js";
import type { JobEvent } from "../../core/jobs/events.js";
import { eventsFile } from "../../core/jobs/store.js";
import type { Services } from "../../core/services.js";

const MAX_EVENTS = 5000;

/** Tails a job's NDJSON log: fs.watch when possible, polling as a fallback. */
export function useJobEvents(
  services: Services,
  config: Config | null,
  id: string | null,
  pollMs = 1000,
): JobEvent[] {
  const [events, setEvents] = useState<JobEvent[]>([]);
  const offset = useRef(0);
  useEffect(() => {
    setEvents([]);
    offset.current = 0;
    if (!config || !id) return;
    let alive = true;
    let busy = false;
    const read = async () => {
      if (busy) return;
      busy = true;
      try {
        const r = await services.jobEvents(config, id, offset.current);
        if (!alive) return;
        offset.current = r.offset;
        if (r.events.length) setEvents((prev) => [...prev, ...r.events].slice(-MAX_EVENTS));
      } finally {
        busy = false;
      }
    };
    void read();
    const file = eventsFile(stateDir(config), id);
    let watcher: ReturnType<typeof watch> | null = null;
    try {
      watcher = watch(path.dirname(file), (_e, name) => {
        if (!name || name.toString() === path.basename(file)) void read();
      });
      watcher.on("error", () => {});
    } catch {
      watcher = null;
    }
    const timer = setInterval(() => void read(), pollMs);
    return () => {
      alive = false;
      watcher?.close();
      clearInterval(timer);
    };
  }, [services, config, id, pollMs]);
  return events;
}

export interface ItemProgress {
  environment: string;
  kind: "database" | "project";
  name: string;
  status: "pending" | "running" | "success" | "failed";
  bytes: number;
  files?: number;
  size?: number;
  durationMs?: number;
  error?: string;
  index: number;
  total: number;
  startedAt?: number;
}

/** Fold events into per-item progress, in the order items started. */
export function itemProgress(events: JobEvent[]): ItemProgress[] {
  const items = new Map<string, ItemProgress>();
  const k = (e: { environment: string; kind: string; name: string }) =>
    `${e.environment}\u0000${e.kind}\u0000${e.name}`;
  for (const e of events) {
    if (e.type === "item-start") {
      items.set(k(e), {
        environment: e.environment,
        kind: e.kind,
        name: e.name,
        status: "running",
        bytes: 0,
        index: e.index,
        total: e.total,
        startedAt: Date.parse(e.ts),
      });
    } else if (e.type === "item-progress") {
      const item = items.get(k(e));
      if (item) {
        item.bytes = e.bytes;
        if (e.files !== undefined) item.files = e.files;
      }
    } else if (e.type === "item-done") {
      const item = items.get(k(e));
      if (item) {
        item.status = e.status;
        item.size = e.size;
        item.durationMs = e.durationMs;
        if (e.error) item.error = e.error;
      }
    }
  }
  return [...items.values()];
}

/** Overall fraction done for a running job (items done / items known). */
export function jobFraction(items: ItemProgress[]): { done: number; total: number } {
  const byEnv = new Map<string, number>();
  for (const i of items) byEnv.set(i.environment, i.total);
  const total = [...byEnv.values()].reduce((s, n) => s + n, 0);
  return {
    done: items.filter((i) => i.status === "success" || i.status === "failed").length,
    total,
  };
}
