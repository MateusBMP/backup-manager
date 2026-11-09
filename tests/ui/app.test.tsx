import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { render } from "ink-testing-library";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runBackup } from "../../src/core/backup/pipeline.js";
import { loadConfig } from "../../src/core/config/load.js";
import { saveConfig } from "../../src/core/config/store.js";
import { getJobCommand, setJobCommand } from "../../src/core/jobs/runner.js";
import { Services } from "../../src/core/services.js";
import { App } from "../../src/ui/App.js";
import { makeTheme } from "../../src/ui/theme.js";
import {
  fakeSystemd,
  installFakeDump,
  makeConfig,
  makeLaravelProject,
  sleep,
  tempDir,
  waitFor,
} from "../helpers.js";

const ENTRY = path.resolve(import.meta.dirname, "../fixtures/job-entry.ts");
let saved: ReturnType<typeof getJobCommand>;
beforeAll(() => {
  saved = getJobCommand();
  setJobCommand({ command: process.execPath, args: ["--import", "tsx", ENTRY] });
});
afterAll(() => setJobCommand(saved));

const KEY = {
  enter: "\r",
  esc: "\u001b",
  tab: "\t",
  shiftTab: "\u001b[Z",
  down: "\u001b[B",
  up: "\u001b[A",
  right: "\u001b[C",
  ctrlS: "\u0013",
  backspace: "\u007f",
};

async function setup(
  options: {
    config?: boolean;
    envs?: Record<string, unknown>[];
    extra?: Record<string, unknown>;
  } = {},
) {
  const root = await tempDir();
  await installFakeDump(root);
  const projectPath = await makeLaravelProject(root);
  const configPath = path.join(root, "config.json");
  const config = makeConfig(root, {
    environments: options.envs ?? [
      {
        name: "production",
        schedule: "30 3 * * *",
        projects: [{ name: "shop", path: projectPath }],
        databases: [{ name: "shop", source: { type: "laravel", project: "shop" } }],
      },
    ],
    ...options.extra,
  });
  if (options.config !== false) await saveConfig(configPath, config);
  const fake = fakeSystemd();
  const services = new Services({
    configPath,
    runner: fake.runner,
    unitFile: path.join(root, "bkm.service"),
  });
  return { root, projectPath, configPath, config, services, fake };
}

async function mount(services: Services, size = { columns: 100, rows: 30 }) {
  const r = render(
    <App
      services={services}
      size={size}
      theme={makeTheme(false)}
      intervals={{ service: 200, jobs: 200 }}
    />,
  );
  const frame = () => r.lastFrame() ?? "";
  // ink-testing-library drops the very first keystroke after mount (a real pty does not),
  // so prime input with a key no handler uses (F12).
  await waitFor(() => frame().includes("backup-manager") || frame().includes("too small"));
  await sleep(100);
  r.stdin.write("\u001b[24~");
  await sleep(50);
  return {
    ...r,
    frame,
    async keys(...keys: string[]) {
      await sleep(150); // let effects subscribe input handlers after the last frame
      for (const k of keys) {
        r.stdin.write(k);
        await sleep(40);
      }
      await sleep(60);
    },
    async type(text: string) {
      await sleep(150);
      for (const ch of text) {
        r.stdin.write(ch);
        await sleep(5);
      }
      await sleep(60);
    },
    until: (text: string | RegExp, timeout = 5000) =>
      waitFor(() => (typeof text === "string" ? frame().includes(text) : text.test(frame())), {
        timeout,
      }).catch(() => {
        throw new Error(`timed out waiting for ${text}\n${frame()}`);
      }),
  };
}

describe("ui", () => {
  test("onboarding creates a minimal config and the first environment", async () => {
    const { services, configPath, root, fake } = await setup({ config: false });
    const ui = await mount(services);
    await ui.until("Let's set up backup-manager");
    await ui.type(path.join(root, "data"));
    await ui.keys(KEY.tab, KEY.backspace, "5");
    await ui.keys(KEY.ctrlS);
    await ui.until("First environment");
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      $schema: expect.any(String),
      version: 1,
      settings: { backupDir: path.join(root, "data") },
      retention: { keepLast: 5 },
      environments: [],
    });
    await ui.type("prod");
    await ui.keys(KEY.tab);
    await ui.type("30 3 * * *");
    await ui.until("daily at 03:30");
    await ui.keys(KEY.ctrlS);
    await ui.until("Install the service?");
    await ui.keys("y");
    await ui.until("Environments");
    await waitFor(() => fake.state.active);
    const { config } = await loadConfig(configPath);
    expect(config.environments).toEqual([
      { name: "prod", schedule: "30 3 * * *", projects: [], databases: [] },
    ]);
    ui.unmount();
  });

  test("edit an environment: add a project and a Laravel database, validation errors", async () => {
    const { services, configPath, projectPath } = await setup({ envs: [{ name: "stage" }] });
    const ui = await mount(services);
    await ui.until("stage");
    await ui.keys("e");
    await ui.until("manual only");
    await ui.keys(KEY.enter);
    await ui.until("Environment · stage");
    // bad schedule shows an inline error on save
    await ui.keys(KEY.tab);
    await ui.type("nope");
    await ui.keys(KEY.ctrlS);
    await ui.until("invalid cron expression");
    for (let i = 0; i < 4; i++) await ui.keys(KEY.backspace);
    // go to "+ Add project"
    for (let i = 0; i < 4; i++) await ui.keys(KEY.tab);
    await ui.until(/❯ \+ Add project/);
    await ui.keys(KEY.enter);
    await ui.until("New project");
    await ui.type("shop");
    await ui.keys(KEY.tab);
    await ui.type(projectPath);
    await ui.until("Laravel project (artisan found)");
    await ui.keys(KEY.ctrlS);
    await ui.until("Projects (1)");
    // "+ Add database" is the last field
    await ui.keys(KEY.shiftTab);
    await ui.until(/❯ \+ Add database/);
    await ui.keys(KEY.enter);
    await ui.until("New database");
    await ui.type("shop");
    await ui.until("Laravel .env");
    // Shift-Tab wraps to the action at the bottom: test the connection
    await ui.keys(KEY.shiftTab);
    await ui.until(/❯ Test connection/);
    await ui.keys(KEY.enter);
    await ui.until("connected to shop");
    await ui.keys(KEY.ctrlS);
    await ui.until("Databases (1)");
    await ui.keys(KEY.ctrlS);
    await ui.until("saved stage");
    const { config } = await loadConfig(configPath);
    expect(config.environments[0]).toMatchObject({
      name: "stage",
      projects: [{ name: "shop", path: projectPath }],
      databases: [{ name: "shop", source: { type: "laravel", project: "shop" } }],
    });
    ui.unmount();
  });

  test("new backup runs detached and the live view follows it; jobs list shows it", async () => {
    const { services } = await setup();
    const ui = await mount(services);
    await ui.until("production");
    await ui.keys("n");
    await ui.until("1 environments");
    await ui.keys(KEY.enter);
    await ui.until("database  shop");
    await ui.keys(KEY.enter);
    await ui.until("press ⏎ to start");
    await ui.keys(KEY.enter);
    await ui.until("Job · ", 5000);
    await ui.until("job success", 20_000);
    expect(ui.frame()).toContain("database shop");
    await ui.keys("4");
    await ui.until(/✔ success/);
    await ui.keys("1");
    await ui.until("Recent backups");
    await ui.until(/✔ production\s+\d{8}-\d{6}/);
    ui.unmount();
  });

  test("dashboard shows running jobs; stopping from the jobs list", async () => {
    const { services, config } = await setup();
    process.env.FAKE_DUMP_SLEEP_MS = "20000";
    try {
      const ui = await mount(services);
      await ui.until("idle");
      await services.startBackup(config, [{ environment: "production" }]);
      await ui.until("production · database shop", 10_000);
      await ui.keys("4");
      await ui.until(/running\s+\d{8}/);
      await ui.keys("x");
      await ui.until("Stop job");
      await ui.keys("y");
      await ui.until(/✘ failed/, 10_000);
      ui.unmount();
    } finally {
      delete process.env.FAKE_DUMP_SLEEP_MS;
    }
  });

  test("backups list, filter and detail", async () => {
    const { services, config } = await setup();
    await runBackup(config, config.environments[0]!);
    const ui = await mount(services);
    await ui.keys("3");
    await ui.until(/✔ complete\s+\d{8}-\d{6}/);
    await ui.keys("f");
    await ui.until("filter: complete");
    await ui.keys(KEY.enter);
    await ui.until("sha256");
    expect(ui.frame()).toContain("database shop");
    await ui.keys(KEY.esc);
    await ui.until("filter: complete");
    ui.unmount();
  });

  test("prune previews and applies the retention policy", async () => {
    const { services, config } = await setup({
      extra: { retention: { keepLast: 1, keepDays: 0 }, settings: { autoPrune: false } },
    });
    const env = config.environments[0]!;
    await runBackup(config, env, {}, { now: () => new Date(2026, 0, 1) });
    await runBackup(config, env, {}, { now: () => new Date(2026, 0, 2) });
    await runBackup(config, env);
    const ui = await mount(services);
    await ui.keys("6");
    await ui.until("2 item(s) to delete");
    await ui.keys("p");
    await ui.until("Apply retention");
    await ui.keys("y");
    await ui.until("deleted 2 item(s)");
    await ui.until("everything is within the retention policy");
    ui.unmount();
  });

  test("service panel installs and reports status; doctor and settings render", async () => {
    const { services, fake, configPath } = await setup();
    const ui = await mount(services);
    await ui.keys("s");
    await ui.until("NOT INSTALLED");
    await ui.keys(KEY.enter);
    await ui.until("service installed and running");
    await ui.until("ACTIVE");
    expect(fake.state.linger).toBe(true);
    await ui.keys(KEY.down, KEY.down, KEY.enter);
    await ui.until("Stop the service");
    await ui.keys("y");
    await ui.until("stop done");
    await ui.keys("8");
    await ui.until(/all good|problem/, 10_000);
    expect(ui.frame()).toContain("dump client");
    await ui.keys("9");
    await ui.until("Max parallel jobs");
    await ui.keys(KEY.tab, KEY.tab);
    await ui.type("9");
    await ui.keys(KEY.ctrlS);
    await ui.until("Too big");
    await ui.keys(KEY.backspace, KEY.backspace);
    await ui.type("9");
    await ui.keys(KEY.ctrlS);
    await ui.until("settings saved");
    expect(JSON.parse(await readFile(configPath, "utf8")).settings.compressLevel).toBe(9);
    ui.unmount();
  });

  test("environments: run now and delete", async () => {
    const { services, configPath } = await setup();
    const ui = await mount(services);
    await ui.keys("e");
    await ui.until("daily at 03:30");
    await ui.keys("r");
    await ui.until("Run backup now");
    await ui.keys("y");
    await ui.until("Job · ");
    await ui.until("job success", 20_000);
    await ui.keys("e");
    await ui.until("daily at 03:30");
    await ui.keys("d");
    await ui.until("Delete environment");
    await ui.keys(KEY.enter); // danger dialogs default to Cancel
    await ui.until("daily at 03:30");
    await ui.keys("d");
    await ui.until("Delete environment");
    await ui.keys("y");
    await ui.until("deleted production");
    expect(JSON.parse(await readFile(configPath, "utf8")).environments).toEqual([]);
    ui.unmount();
  });

  test("onboarding validates its fields", async () => {
    const { services } = await setup({ config: false });
    const ui = await mount(services);
    await ui.until("Let's set up");
    await ui.keys(KEY.tab, KEY.backspace);
    await ui.type("0");
    await ui.keys(KEY.tab, KEY.backspace, KEY.backspace);
    await ui.type("0");
    await ui.keys(KEY.ctrlS);
    await ui.until("cannot both be 0");
    ui.unmount();
  });

  test("help overlay, narrow tab bar, too small, config errors", async () => {
    const { services, configPath } = await setup();
    const ui = await mount(services);
    await ui.until("Dashboard");
    await ui.keys("?");
    await ui.until("Keys");
    expect(ui.frame()).toContain("jump to a menu entry");
    await ui.keys("x");
    await waitFor(() => !ui.frame().includes("jump to a menu entry"));
    await ui.keys(KEY.tab);
    await ui.keys(KEY.down, KEY.enter);
    await ui.until("⏎ edit");
    ui.unmount();

    const narrow = await mount(services, { columns: 80, rows: 24 });
    await narrow.until("1 Dashboard");
    narrow.unmount();

    const small = await mount(services, { columns: 50, rows: 12 });
    await small.until("Terminal too small");
    small.unmount();

    await writeFile(configPath, JSON.stringify({ environments: [{ name: "Bad" }] }));
    const broken = await mount(services);
    await broken.until("The config file has errors");
    expect(broken.frame()).toContain("environments[0].name");
    await writeFile(configPath, JSON.stringify({ environments: [] }));
    await broken.keys("r");
    await broken.until("No environments yet");
    broken.unmount();
  });
});
