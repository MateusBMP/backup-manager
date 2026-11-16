// Writes one text file with the licence of every library under <dir>/node_modules:
// name, version, licence identifier and the library's own licence file.
//
//   node scripts/third-party-licenses.mjs bundle > bundle/THIRD-PARTY-LICENSES.txt
//
// `make` runs it for the bundle that the packages and the release tarball install.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const LICENCE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;

/** Every package directory below `root/node_modules`, nested ones included. */
export function packageDirs(root) {
  const out = [];
  const modules = path.join(root, "node_modules");
  let names;
  try {
    names = readdirSync(modules).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const dir = path.join(modules, name);
    if (!statSync(dir).isDirectory()) continue;
    if (name.startsWith("@")) {
      for (const scoped of readdirSync(dir).sort()) {
        const inner = path.join(dir, scoped);
        if (statSync(inner).isDirectory()) out.push(inner, ...packageDirs(inner));
      }
    } else {
      out.push(dir, ...packageDirs(dir));
    }
  }
  return out;
}

export function describe(dir) {
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  const files = readdirSync(dir)
    .filter((f) => LICENCE_FILE.test(f) && statSync(path.join(dir, f)).isFile())
    .sort();
  return {
    name: pkg.name,
    version: pkg.version,
    license: typeof pkg.license === "string" ? pkg.license : "see the text below",
    homepage: pkg.homepage ?? pkg.repository?.url ?? pkg.repository ?? "",
    texts: files.map((f) => readFileSync(path.join(dir, f), "utf8").trim()),
  };
}

export function render(root) {
  const seen = new Set();
  const sections = [];
  for (const dir of packageDirs(root)) {
    const p = describe(dir);
    const key = `${p.name}@${p.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const head = [`${p.name} ${p.version}`, `License: ${p.license}`];
    if (typeof p.homepage === "string" && p.homepage) head.push(p.homepage);
    const body = p.texts.length
      ? p.texts.join("\n\n")
      : "(the library ships no licence file; see its package.json and homepage)";
    sections.push(`${head.join("\n")}\n\n${body}`);
  }
  const rule = `\n\n${"-".repeat(78)}\n\n`;
  return [
    "Third-party software installed with backup-manager",
    "",
    "backup-manager itself is licensed under the GNU General Public License,",
    "version 3 only (see LICENSE and NOTICE). It runs on the Node.js libraries",
    "below, which are installed unmodified next to it (node_modules). Each one",
    "keeps its own licence and copyright notice, reproduced here.",
    "",
    `${sections.length} libraries.`,
  ]
    .join("\n")
    .concat(rule, sections.join(rule), "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  process.stdout.write(render(process.argv[2] ?? "."));
}
