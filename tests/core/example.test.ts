import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { parseConfig } from "../../src/core/config/load.js";

test("config.example.json is valid", async () => {
  const text = await readFile(
    path.resolve(import.meta.dirname, "../../config.example.json"),
    "utf8",
  );
  const config = parseConfig(JSON.parse(text));
  expect(config.environments.map((e) => e.name)).toEqual(["production", "staging"]);
});
