import { render } from "ink-testing-library";
import { useState } from "react";
import { describe, expect, test } from "vitest";
import { emptyConfig } from "../../src/core/config/defaults.js";
import { type Field, Form, type Values } from "../../src/ui/components/Form.js";
import { Footer } from "../../src/ui/components/Frame.js";
import { TextField } from "../../src/ui/components/TextField.js";
import { type KeyHint, Provider, useHints } from "../../src/ui/context.js";
import { itemProgress, jobFraction } from "../../src/ui/hooks/useJobEvents.js";
import { isDown, isUp, isZoneKey, joinList, splitList } from "../../src/ui/keys.js";
import { menuIndex } from "../../src/ui/router.js";
import { nextLabel } from "../../src/ui/screens/Dashboard.js";
import { buildDatabase } from "../../src/ui/screens/DatabaseEdit.js";
import { buildTargets } from "../../src/ui/screens/NewBackup.js";
import { applySettings, settingsValues } from "../../src/ui/screens/Settings.js";
import { makeTheme, statusColor, statusIcon } from "../../src/ui/theme.js";
import { sleep } from "../helpers.js";

const ctx = {
  theme: makeTheme(false),
  setCapture: () => {},
} as never;

function Harness({
  fields,
  height,
  onSubmit,
}: {
  fields: Field[];
  height?: number;
  onSubmit?: (v: Values) => void;
}) {
  const [values, setValues] = useState<Values>({ a: "", t: false, s: "x", n: "" });
  return (
    <Provider value={ctx}>
      <Form
        id="f"
        fields={fields}
        values={values}
        onChange={setValues}
        onSubmit={(v) => onSubmit?.(v)}
        onCancel={() => {}}
        isActive
        width={60}
        height={height}
      />
    </Provider>
  );
}

function FieldHarness({ mask, width }: { mask?: boolean; width?: number }) {
  const [v, setV] = useState("");
  return (
    <Provider value={{ theme: makeTheme(false) } as never}>
      <TextField value={v} onChange={setV} focus mask={mask} width={width} placeholder="type" />
    </Provider>
  );
}

describe("ui helpers", () => {
  test("splitList respects glob braces", () => {
    expect(splitList("storage/framework/{cache,sessions}/**, storage/logs/** ,, x")).toEqual([
      "storage/framework/{cache,sessions}/**",
      "storage/logs/**",
      "x",
    ]);
    expect(joinList(["a", "b"])).toBe("a, b");
    expect(splitList("a}, b")).toEqual(["a}", "b"]);
  });

  test("buildTargets sends unfiltered targets when everything is selected", () => {
    const envs = [
      { name: "a", databases: [{ name: "d1" }, { name: "d2" }], projects: [{ name: "p" }] },
      { name: "b", databases: [{ name: "d" }], projects: [] },
      { name: "c", databases: [{ name: "x" }], projects: [] },
    ];
    const items = envs.flatMap((e) => [
      ...e.databases.map((d) => ({ env: e.name, kind: "database" as const, name: d.name })),
      ...e.projects.map((p) => ({ env: e.name, kind: "project" as const, name: p.name })),
    ]);
    const k = (env: string, kind: string, name: string) => `${env}\u0000${kind}\u0000${name}`;
    const picked = new Set([
      k("a", "database", "d1"),
      k("a", "project", "p"),
      k("b", "database", "d"),
    ]);
    expect(buildTargets(envs, picked, items)).toEqual([
      { environment: "a", databases: ["d1"], projects: ["p"] },
      { environment: "b" },
    ]);
  });

  test("job progress folding", () => {
    const ts = new Date().toISOString();
    const items = itemProgress([
      { type: "item-start", ts, environment: "e", kind: "database", name: "d", index: 1, total: 2 },
      { type: "item-progress", ts, environment: "e", kind: "database", name: "d", bytes: 10 },
      {
        type: "item-done",
        ts,
        environment: "e",
        kind: "database",
        name: "d",
        status: "failed",
        size: 0,
        durationMs: 5,
        error: "x",
      },
      { type: "item-start", ts, environment: "e", kind: "project", name: "p", index: 2, total: 2 },
      {
        type: "item-progress",
        ts,
        environment: "e",
        kind: "project",
        name: "p",
        bytes: 7,
        files: 3,
      },
      { type: "item-progress", ts, environment: "e", kind: "project", name: "ghost", bytes: 7 },
      {
        type: "item-done",
        ts,
        environment: "e",
        kind: "project",
        name: "ghost",
        status: "success",
        size: 0,
        durationMs: 1,
      },
    ]);
    expect(items.map((i) => [i.name, i.status, i.bytes, i.files])).toEqual([
      ["d", "failed", 10, undefined],
      ["p", "running", 7, 3],
    ]);
    expect(jobFraction(items)).toEqual({ done: 1, total: 2 });
  });

  test("database form values build both source types", () => {
    const base = {
      name: "db",
      host: "",
      port: "",
      socket: "",
      user: "",
      password: "",
      passwordFile: "",
      extraArgs: "",
    };
    expect(
      buildDatabase({ ...base, type: "laravel", project: "shop", database: "", schemas: "" }),
    ).toEqual({
      name: "db",
      source: { type: "laravel", project: "shop" },
      extraArgs: [],
    });
    expect(
      buildDatabase({
        ...base,
        type: "connection",
        project: "",
        database: "",
        schemas: "a, b",
        port: "3307",
        password: "p",
        extraArgs: "--x",
      }),
    ).toEqual({
      name: "db",
      source: { type: "connection", schemas: ["a", "b"], port: 3307, password: "p" },
      extraArgs: ["--x"],
    });
  });

  test("settings round trip", () => {
    const config = emptyConfig();
    const values = settingsValues(config);
    expect(applySettings(config, values)).toMatchObject({
      settings: { compressLevel: 6, autoPrune: true },
      api: { port: 8080 },
    });
  });

  test("theme, labels and menu mapping", () => {
    const t = makeTheme(true);
    for (const s of [
      "ok",
      "success",
      "complete",
      "active",
      "warn",
      "partial",
      "queued",
      "fail",
      "failed",
      "incomplete",
      "running",
      "x",
    ]) {
      expect(statusIcon(s)).toBeTruthy();
      statusColor(t, s);
    }
    expect(makeTheme(false).accent).toBeUndefined();
    const now = new Date(2026, 0, 1, 12);
    expect(nextLabel(null)).toBe("—");
    expect(nextLabel(new Date(2026, 0, 1, 15, 5), now)).toBe("15:05");
    expect(nextLabel(new Date(2026, 0, 3, 15, 5), now)).toBe("1/3 15:05");
    expect(menuIndex({ name: "job-live", id: "x" })).toBe(3);
    expect(menuIndex({ name: "onboarding" })).toBe(0);
  });
});

describe("form", () => {
  test("toggles, selects, numbers, actions and windowing", async () => {
    let pressed = 0;
    let deleted = 0;
    let submitted: Values | null = null;
    const fields: Field[] = [
      { kind: "heading", key: "h", label: "Head" },
      { kind: "text", key: "a", label: "A", hint: "hint a" },
      { kind: "toggle", key: "t", label: "T" },
      {
        kind: "select",
        key: "s",
        label: "S",
        options: [
          { label: "X", value: "x" },
          { label: "Y", value: "y" },
        ],
      },
      { kind: "number", key: "n", label: "N", error: "bad n" },
      {
        kind: "action",
        key: "go",
        label: "Go",
        detail: "press",
        onPress: () => pressed++,
        onDelete: () => deleted++,
      },
      ...Array.from(
        { length: 8 },
        (_, i): Field => ({ kind: "text", key: `x${i}`, label: `X${i}` }),
      ),
    ];
    const r = render(<Harness fields={fields} height={8} onSubmit={(v) => (submitted = v)} />);
    const press = async (k: string) => {
      r.stdin.write(k);
      await sleep(30);
    };
    await sleep(100);
    await press("\u001b[24~");
    await press("h");
    await press("i");
    expect(r.lastFrame()).toContain("hi");
    expect(r.lastFrame()).toContain("hint a");
    await press("\r"); // next field
    await press(" "); // toggle on
    expect(r.lastFrame()).toContain("● on");
    await press("\t");
    await press("\u001b[C"); // select → Y
    expect(r.lastFrame()).toContain("Y");
    await press("\u001b[D"); // back to X
    await press("\t");
    await press("1");
    await press("z"); // stripped for number fields
    expect(r.lastFrame()).toContain("bad n");
    await press("\t");
    await press("\r");
    await press("d");
    expect([pressed, deleted]).toEqual([1, 1]);
    for (let i = 0; i < 6; i++) await press("\u001b[B");
    expect(r.lastFrame()).toContain("↑ more");
    await press("\u0013");
    expect(submitted).toMatchObject({ a: "hi", t: true, s: "x", n: "1" });
    await press("\u001b[Z");
    await press("\u001b[A");
    r.unmount();
  });
});

describe("text field", () => {
  test("cursor movement, deletion, clear, paste and masking", async () => {
    const r = render(<FieldHarness width={8} />);
    const press = async (k: string) => {
      r.stdin.write(k);
      await sleep(25);
    };
    await sleep(100);
    await press("\u001b[24~");
    expect(r.lastFrame()).toContain("ype");
    for (const ch of "abcdef") await press(ch);
    await press("\u001b[D"); // left
    await press("\u001b[D");
    await press("X");
    await press("\u001b[H"); // home
    await press("\u0005"); // ctrl-e end
    await press("\u0001"); // ctrl-a home
    await press("\u001b[C"); // right
    await press("\u007f"); // backspace at 1 → removes "a"
    await press("\u0015"); // ctrl-u clears before cursor
    await press("\u001b[F"); // end
    await press("\u001b[200~pas\nte\u001b[201~"); // bracketed paste
    const frame = r.lastFrame() ?? "";
    expect(frame.replace(/\s/g, "")).toContain("te");
    r.unmount();
    const masked = render(<FieldHarness mask />);
    await sleep(100);
    masked.stdin.write("\u001b[24~");
    await sleep(30);
    for (const ch of "pw") {
      masked.stdin.write(ch);
      await sleep(25);
    }
    expect(masked.lastFrame()).toContain("••");
    masked.unmount();
  });
});

const calls: number[] = [];
function HintScreen({ n }: { n: number }) {
  useHints([{ key: "x", label: "go", run: () => calls.push(n) }], []);
  return null;
}

describe("button bar", () => {
  const theme = makeTheme(false);
  const run = () => {};
  const hints: KeyHint[] = [
    { key: "↑↓", label: "move" },
    { key: "a", label: "add", run },
  ];
  const global: KeyHint[] = [{ key: "q", label: "quit", run }];

  test("footer shows hints, and buttons when focused", () => {
    const view = (focused: boolean) =>
      render(
        <Provider value={{ theme } as never}>
          <Footer
            theme={theme}
            columns={100}
            hints={hints}
            global={global}
            focused={focused}
            selected={1}
          />
        </Provider>,
      );
    const plain = view(false);
    expect(plain.lastFrame()).toContain("↑↓ move  a add  q quit");
    plain.unmount();
    const bar = view(true);
    expect(bar.lastFrame()).toContain("[ add ] [ quit ]");
    expect(bar.lastFrame()).toContain("esc back");
    expect(bar.lastFrame()).not.toContain("move");
    bar.unmount();
  });

  test("useHints buttons call the latest closure", async () => {
    let registered: KeyHint[] = [];
    calls.length = 0;
    const value = { setHints: (h: KeyHint[]) => (registered = h) } as never;
    const r = render(
      <Provider value={value}>
        <HintScreen n={1} />
      </Provider>,
    );
    await sleep(20);
    r.rerender(
      <Provider value={value}>
        <HintScreen n={2} />
      </Provider>,
    );
    await sleep(20);
    registered[0]?.run?.();
    expect(calls).toEqual([2]);
    r.unmount();
  });

  test("zone keys are Ctrl/Alt arrows and never move inside lists", () => {
    const key = (k: Record<string, boolean>) => k as never;
    expect(isZoneKey(key({ ctrl: true, downArrow: true }))).toBe(true);
    expect(isZoneKey(key({ meta: true, leftArrow: true }))).toBe(true);
    expect(isZoneKey(key({ downArrow: true }))).toBe(false);
    expect(isZoneKey(key({ ctrl: true }))).toBe(false);
    expect(isDown("", key({ ctrl: true, downArrow: true }))).toBeFalsy();
    expect(isUp("", key({ meta: true, upArrow: true }))).toBeFalsy();
    expect(isDown("j", key({}))).toBe(true);
    expect(isUp("", key({ upArrow: true }))).toBe(true);
  });
});
