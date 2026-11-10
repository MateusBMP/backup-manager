import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { busHint, ServiceError, ServiceManager } from "../../src/core/service/manager.js";
import { execRunner, parseProperties, userBusEnv } from "../../src/core/service/systemctl.js";
import { quoteArg, renderUnit, unitPath } from "../../src/core/service/unit.js";
import { fakeSystemd, tempDir } from "../helpers.js";

const COMMAND = ["/opt/node/bin/node", "/opt/bkm/dist/cli.js"];

async function manager(options: Parameters<typeof fakeSystemd>[0] = {}) {
  const dir = await tempDir();
  const fake = fakeSystemd(options);
  const m = new ServiceManager({
    configPath: path.join(dir, "my config.json"),
    runner: fake.runner,
    unitFile: path.join(dir, "systemd", "user", "bkm.service"),
    user: "alice",
    command: COMMAND,
  });
  return { m, fake, dir };
}

describe("unit", () => {
  test("renders absolute paths, quotes spaces, targets default.target", () => {
    const unit = renderUnit({ command: COMMAND, configPath: "/home/a/my cfg/config.json" });
    expect(unit).toContain(
      'ExecStart=/opt/node/bin/node /opt/bkm/dist/cli.js daemon --config "/home/a/my cfg/config.json"',
    );
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("ExecReload=/bin/kill -HUP $MAINPID");
    expect(unit).not.toMatch(/After=mariadb/);
    expect(quoteArg("100%")).toBe("100%%");
    expect(quoteArg('a"b')).toBe('"a\\"b"');
    expect(quoteArg("$HOME")).toBe('"$$HOME"');
    expect(unitPath({ XDG_CONFIG_HOME: "/c" })).toBe("/c/systemd/user/bkm.service");
    expect(parseProperties("A=1\nB=x=y\nnoise")).toEqual({ A: "1", B: "x=y" });
  });
});

describe("service manager", () => {
  test("install writes the unit, enables it, enables linger; re-run is a no-op", async () => {
    const { m, fake } = await manager();
    await expect(stat(m.unitFile)).rejects.toThrow();
    expect(fake.calls).toEqual([]);

    const result = await m.install();
    expect(result.actions).toEqual([
      `write ${m.unitFile}`,
      "systemctl --user daemon-reload",
      "systemctl --user enable --now bkm",
      "loginctl enable-linger alice",
    ]);
    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(await readFile(m.unitFile, "utf8")).toBe(m.expectedUnit());
    const status = await m.status();
    expect(status).toMatchObject({
      installed: true,
      outdated: false,
      activeState: "active",
      enabled: "enabled",
      linger: true,
      mainPid: 4242,
    });
    for (const call of fake.calls) {
      expect(call[0]).not.toBe("sudo");
      if (call[0] === "systemctl") expect(call[1]).toBe("--user");
    }

    const again = await m.install();
    expect(again.actions).toEqual([]);
    expect(again.changed).toBe(false);
  });

  test("outdated unit needs --force; linger refusal is a warning", async () => {
    const { m, fake } = await manager({ lingerAllowed: false });
    await m.install();
    await writeFile(m.unitFile, "[Service]\nExecStart=/old/node /old/cli.js daemon\n");
    expect((await m.status()).outdated).toBe(true);
    await expect(m.install()).rejects.toBeInstanceOf(ServiceError);
    const forced = await m.install({ force: true });
    expect(forced.actions).toContain("systemctl --user restart bkm");
    expect(forced.warnings[0]).toMatch(/only while you are logged in/);
    expect(fake.state.reloads).toBe(2);
  });

  test("unavailable systemd", async () => {
    const { m } = await manager({ available: false });
    const status = await m.status();
    expect(status.available).toBe(false);
    expect(status.error).toMatch(/bus/);
    await expect(m.install()).rejects.toThrow(/not available/);
  });

  test("logs fall back to the system journal when the user journal is missing", async () => {
    const { m, fake } = await manager({ userJournalMissing: true });
    expect(await m.logs(10)).toEqual(["2026-11-09T03:30:00 host bkm[1]: scheduler started"]);
    const last = fake.calls.filter((c) => c[0] === "journalctl").at(-1);
    expect(last?.[1]).toBe("_SYSTEMD_USER_UNIT=bkm.service");
    expect(last).not.toContain("--user");
  });

  test("control, logs and uninstall keep data", async () => {
    const { m, fake, dir } = await manager();
    expect(await m.uninstall()).toEqual([]);
    await m.install();
    await m.control("stop");
    expect(fake.state.active).toBe(false);
    await expect(m.control("reload")).rejects.toThrow(/reload failed/);
    await m.control("start");
    await m.control("reload");
    expect(await m.logs(10)).toEqual(["2026-11-09T03:30:00 host bkm[1]: scheduler started"]);
    const actions = await m.uninstall();
    expect(actions).toEqual([
      "systemctl --user disable --now bkm",
      `remove ${m.unitFile}`,
      "systemctl --user daemon-reload",
    ]);
    await expect(stat(m.unitFile)).rejects.toThrow();
    expect((await stat(dir)).isDirectory()).toBe(true);
  });

  test("missing user bus env gets an actionable hint", async () => {
    const busError =
      "Failed to connect to bus: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined (consider using --machine=<user>@.host --user to connect to bus of other user)";
    const { m } = await manager({ available: false, busError });
    const status = await m.status();
    expect(status.error).toContain(busError);
    expect(status.error).toMatch(/ssh alice@host/);
    expect(status.error).toMatch(/loginctl enable-linger alice/);
    await expect(m.install()).rejects.toThrow(/enable-linger alice/);
    expect(busHint("Unit bkm.service not found.", "alice")).toBe("Unit bkm.service not found.");
  });

  test("userBusEnv fills the user bus from /run/user/<uid> without overwriting", () => {
    const all = (p: string) => p === "/run/user/1000" || p === "/run/user/1000/bus";
    const input = { PATH: "/bin" };
    expect(userBusEnv(input, 1000, all)).toEqual({
      PATH: "/bin",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    });
    expect(input).toEqual({ PATH: "/bin" });
    expect(userBusEnv({}, 1000, (p) => p === "/run/user/1000")).toEqual({
      XDG_RUNTIME_DIR: "/run/user/1000",
    });
    expect(userBusEnv({}, 1000, () => false)).toEqual({});
    expect(userBusEnv({}, null, () => true)).toEqual({});
    const set = { XDG_RUNTIME_DIR: "/x", DBUS_SESSION_BUS_ADDRESS: "unix:path=/y" };
    expect(userBusEnv(set, 1000, () => true)).toEqual(set);
  });

  test("execRunner reports missing programs and exit codes without a shell", async () => {
    expect((await execRunner("definitely-not-a-command-xyz", [])).code).toBe(127);
    expect((await execRunner(process.execPath, ["-e", "process.exit(3)"])).code).toBe(3);
    const ok = await execRunner(process.execPath, ["-e", "process.stdout.write('$HOME')"]);
    expect(ok).toEqual({ code: 0, stdout: "$HOME", stderr: "" });
  });
});
