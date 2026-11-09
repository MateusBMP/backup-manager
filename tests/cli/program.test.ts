import path from "node:path";
import { describe, expect, test } from "vitest";
import { EXIT_USAGE, main } from "../../src/cli/program.js";
import { saveConfig } from "../../src/core/config/store.js";
import type { DoctorReport } from "../../src/core/doctor.js";
import { newJobId, readJob, writeJob } from "../../src/core/jobs/store.js";
import { Services } from "../../src/core/services.js";
import { doctorText, printOptions } from "../../src/ui/print/print.js";
import {
  fakeSystemd,
  freePort,
  installFakeDump,
  makeConfig,
  makeLaravelProject,
  memoryLogger,
  sleep,
  tempDir,
} from "../helpers.js";

function io(isTTY = false, plain = true) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (t: string) => out.push(t),
      err: (t: string) => err.push(t),
      isTTY,
      print: { plain, columns: 100 },
    },
  };
}

async function setup(withConfig = true) {
  const root = await tempDir();
  await installFakeDump(root);
  const projectPath = await makeLaravelProject(root);
  const configPath = path.join(root, "config.json");
  const config = makeConfig(root, {
    api: { port: await freePort() },
    environments: [
      {
        name: "prod",
        schedule: "30 3 * * *",
        projects: [{ name: "shop", path: projectPath }],
        databases: [{ name: "shop", source: { type: "laravel", project: "shop" } }],
      },
    ],
  });
  if (withConfig) await saveConfig(configPath, config);
  const fake = fakeSystemd();
  const unitFile = path.join(root, "systemd", "bkm.service");
  const run = (argv: string[], tty = false, extra: Record<string, unknown> = {}) => {
    const t = io(tty);
    return main(["-c", configPath, ...argv], {
      io: t.io,
      runner: fake.runner,
      unitFile,
      ...extra,
    }).then((code) => ({ code, ...t }));
  };
  const services = new Services({ configPath, runner: fake.runner, unitFile });
  return { root, configPath, config, fake, unitFile, run, services };
}

describe("cli", () => {
  test("help, version, usage errors and no TTY", async () => {
    const { run } = await setup();
    expect((await run(["--help"])).code).toBe(0);
    const version = await run(["--version"]);
    expect(version.code).toBe(0);
    expect(version.out.join("")).toMatch(/\d+\.\d+\.\d+/);
    expect((await run(["frobnicate"])).code).toBe(EXIT_USAGE);
    expect((await run(["doctor", "--bogus"])).code).toBe(EXIT_USAGE);
    const noTty = await run([]);
    expect(noTty.code).toBe(EXIT_USAGE);
    expect(noTty.err.join("")).toMatch(/needs a terminal/);
    expect(noTty.err.join("")).toMatch(/Usage: bkm/);
    expect(noTty.err.join("")).not.toContain("__job");
  });

  test("bkm in a TTY launches the UI with the resolved config", async () => {
    const { run, configPath } = await setup();
    let seen = "";
    const r = await run([], true, {
      launchUi: async (s: { configPath: string }) => {
        seen = s.configPath;
        return 0;
      },
    });
    expect(r.code).toBe(0);
    expect(seen).toBe(configPath);
  });

  test("install and uninstall are UI-only; commands need a config", async () => {
    const { run, services } = await setup();
    for (const cmd of [["install"], ["uninstall"]]) expect((await run(cmd)).code).toBe(EXIT_USAGE);

    await services.service.install();
    const doctor = await run(["doctor", "--no-db"]);
    expect(doctor.code).toBe(0);
    expect(doctor.out.join("")).toMatch(/✔ active/);

    const empty = await setup(false);
    for (const cmd of [["doctor"], ["daemon"], ["__job", "x"]]) {
      const r = await empty.run(cmd);
      expect(r.code).toBe(EXIT_USAGE);
      expect(r.err.join("")).toMatch(/run `bkm` in a terminal first/);
    }
  });

  test("doctor exits 1 on failures and reports JSON paths", async () => {
    const { run, configPath } = await setup();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(configPath, JSON.stringify({ environments: [{ name: "x", schedule: "bad" }] }));
    const r = await run(["doctor", "--no-db"]);
    expect(r.code).toBe(1);
    expect(r.out.join("")).toMatch(/environments\[0\]\.schedule: invalid cron/);
  });

  test("daemon boots in-process and stops on SIGTERM", async () => {
    const { run } = await setup();
    const log = memoryLogger();
    const pending = run(["daemon"], false, { daemonLog: log });
    for (let i = 0; i < 100 && !log.lines.some((l) => l.includes("ready")); i++) await sleep(20);
    expect(log.lines.some((l) => l.includes("api listening"))).toBe(true);
    process.emit("SIGHUP", "SIGHUP");
    await sleep(50);
    process.emit("SIGTERM", "SIGTERM");
    expect((await pending).code).toBe(0);
    expect(log.lines).toContain("info: stopped");
  });

  test("daemon start failure maps to an exit code", async () => {
    const { run } = await setup();
    const r = await run(["daemon"], false, {
      daemon: async () => {
        throw new Error("boom");
      },
    });
    expect(r.code).toBe(1);
    expect(r.err.join("")).toMatch(/boom/);
  });

  test("__job runs a queued job in-process", async () => {
    const { run, config, configPath } = await setup();
    const state = config.settings.stateDir!;
    const id = newJobId();
    await writeJob(state, {
      id,
      status: "queued",
      trigger: "ui",
      targets: [{ environment: "prod" }],
      configPath,
      detached: false,
      pid: null,
      createdAt: new Date().toISOString(),
      backups: [],
    });
    const r = await run(["__job", id]);
    expect(r.code).toBe(0);
    expect((await readJob(state, id))!.status).toBe("success");
  });
});

describe("print", () => {
  const report: DoctorReport = {
    configPath: "/c.json",
    missingConfig: false,
    ok: false,
    checks: [
      { group: "config", name: "config file", status: "ok", detail: "valid" },
      { group: "databases", name: "prod/shop", status: "fail", detail: "Access denied" },
      { group: "service", name: "unit", status: "warn", detail: "not installed" },
    ],
  };

  test("doctor plain and colored", () => {
    const plain = doctorText(report, { plain: true });
    expect(plain).toContain("  ✘ prod/shop    Access denied");
    expect(plain).toContain("✘ 1 problem(s), 1 warning(s)");
    expect(plain).not.toMatch(/\x1b\[/);
    const colored = doctorText(report, { plain: false, columns: 100 });
    expect(colored.replace(/\x1b\[[0-9;]*m/g, "")).toContain("✘ prod/shop");
    expect(doctorText({ ...report, checks: [report.checks[0]!] }, { plain: true })).toContain(
      "✔ all good",
    );
  });

  test("print options fall back to plain text without a TTY", () => {
    expect(printOptions({ isTTY: false, columns: 0 } as never)).toEqual({
      plain: true,
      columns: 100,
    });
  });
});
