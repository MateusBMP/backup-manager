import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { PACKAGE_NAME, VERSION } from "../../src/version.js";

test("VERSION comes from this package's package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    name: string;
    version: string;
  };
  expect(pkg.name).toBe(PACKAGE_NAME);
  expect(VERSION).toBe(pkg.version);
  expect(VERSION).not.toBe("0.0.0");
});
