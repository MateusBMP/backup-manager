import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { tempDir } from "../helpers.js";

test("third-party-licenses lists every library once, nested and scoped ones included", async () => {
  // @ts-expect-error a plain .mjs script, run by `make` without a TypeScript loader
  const { render } = (await import("../../scripts/third-party-licenses.mjs")) as {
    render(root: string): string;
  };
  const root = await tempDir();
  const lib = async (dir: string, pkg: object, licence?: string) => {
    await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, dir, "package.json"), JSON.stringify(pkg));
    if (licence) await writeFile(path.join(root, dir, "LICENSE"), licence);
  };
  await lib("node_modules/a", { name: "a", version: "1.0.0", license: "MIT" }, "MIT text of a\n");
  await lib("node_modules/a/node_modules/b", { name: "b", version: "2.0.0", license: "ISC" });
  await lib("node_modules/@s/c", { name: "@s/c", version: "3.0.0", homepage: "https://c" }, "C");
  await lib("node_modules/b", { name: "b", version: "2.0.0", license: "ISC" });
  await mkdir(path.join(root, "node_modules/.bin"), { recursive: true });

  const text = render(root);
  expect(text).toContain("3 libraries.");
  expect(text).toContain("a 1.0.0\nLicense: MIT\n\nMIT text of a");
  expect(text).toContain("@s/c 3.0.0\nLicense: see the text below\nhttps://c\n\nC");
  expect(text.match(/^b 2\.0\.0$/gm)).toHaveLength(1);
  expect(text).toContain("ships no licence file");
  expect(render(path.join(root, "missing"))).toContain("0 libraries.");
});
