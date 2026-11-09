import { appendFileSync, mkdirSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import type { BackupStatus, ItemKind, ItemStatus } from "../backup/manifest.js";

export type LogLevel = "info" | "warn" | "error";

export type JobEvent =
  | { type: "log"; ts: string; level: LogLevel; message: string; environment?: string }
  | {
      type: "item-start";
      ts: string;
      environment: string;
      kind: ItemKind;
      name: string;
      index: number;
      total: number;
    }
  | {
      type: "item-progress";
      ts: string;
      environment: string;
      kind: ItemKind;
      name: string;
      bytes: number;
      files?: number;
    }
  | {
      type: "item-done";
      ts: string;
      environment: string;
      kind: ItemKind;
      name: string;
      status: ItemStatus;
      size: number;
      durationMs: number;
      error?: string;
    }
  | {
      type: "backup-done";
      ts: string;
      environment: string;
      backupId: string | null;
      status: BackupStatus | "failed";
    }
  | { type: "job-done"; ts: string; status: string; error?: string };

/** Distributive Omit so each variant keeps its own fields. */
export type JobEventInput = JobEvent extends infer E
  ? E extends JobEvent
    ? Omit<E, "ts">
    : never
  : never;
export type Emit = (event: JobEventInput) => void;

/** Appends events synchronously so the order on disk matches the order emitted. */
export function eventWriter(file: string): Emit {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return (event) => {
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, {
      mode: 0o600,
    });
  };
}

/** Reads complete lines from `offset`; returns the events and the offset to continue from. */
export async function readEvents(
  file: string,
  offset = 0,
): Promise<{ events: JobEvent[]; offset: number }> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, "r");
  } catch {
    return { events: [], offset };
  }
  try {
    const { size } = await handle.stat();
    if (size <= offset) return { events: [], offset: size < offset ? 0 : offset };
    const buffer = Buffer.alloc(size - offset);
    await handle.read(buffer, 0, buffer.length, offset);
    const text = buffer.toString("utf8");
    const end = text.lastIndexOf("\n");
    if (end < 0) return { events: [], offset };
    const events: JobEvent[] = [];
    for (const line of text.slice(0, end).split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as JobEvent);
      } catch {
        // ignore a corrupt line
      }
    }
    return { events, offset: offset + Buffer.byteLength(text.slice(0, end + 1)) };
  } finally {
    await handle.close();
  }
}
