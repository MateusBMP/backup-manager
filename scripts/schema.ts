// Generates config.schema.json and the config reference table from the zod schema.
// The table is in the wiki (Configuration.md, between the markers below). It is written when a
// checkout of the wiki is found at $BKM_WIKI_DIR or next to this one (../backup-manager.wiki).
// `--check` fails when either is stale (`npm run verify`; CI has no wiki checkout and checks
// the schema only).
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configJsonSchema } from "../src/core/config/schema.js";

type Node = {
  type?: string | string[];
  description?: string;
  default?: unknown;
  properties?: Record<string, Node>;
  items?: Node;
  anyOf?: Node[];
  oneOf?: Node[];
  required?: string[];
  const?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
};

const START = "<!-- config-reference:start -->";
const END = "<!-- config-reference:end -->";

function typeOf(n: Node): string {
  if (n.const !== undefined) return `\`${JSON.stringify(n.const)}\``;
  if (n.enum) return n.enum.map((v) => `\`${JSON.stringify(v)}\``).join(" \\| ");
  if (n.type === "array") return `${n.items ? typeOf(n.items) : "any"}[]`;
  if (n.type === "integer" && n.minimum !== undefined) {
    return n.maximum !== undefined && n.maximum < Number.MAX_SAFE_INTEGER
      ? `integer ${n.minimum}–${n.maximum}`
      : `integer ≥ ${n.minimum}`;
  }
  return Array.isArray(n.type) ? n.type.join(" \\| ") : (n.type ?? "object");
}

/** Plain text in a table cell: a backslash and a pipe are escaped. */
function textCell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/** Inside a code span only the pipe is escaped: a backslash is literal there. */
function codeCell(code: string): string {
  return code.split("|").join("\\|");
}

function rows(node: Node, prefix: string, out: string[]) {
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    if (key === "$schema") continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const variants = child.oneOf ?? child.anyOf;
    const def =
      child.default !== undefined &&
      (typeof child.default !== "object" || Array.isArray(child.default))
        ? `\`${codeCell(JSON.stringify(child.default))}\``
        : "";
    const description = textCell(child.description ?? "");
    if (child.type === "object" || child.properties) {
      if (description) out.push(`| \`${path}\` | object | | ${description} |`);
      rows(child, path, out);
    } else if (child.type === "array" && child.items?.properties) {
      out.push(`| \`${path}[]\` | object[] | | ${description} |`);
      rows(child.items, `${path}[]`, out);
    } else if (variants) {
      for (const v of variants) {
        const kind = v.properties?.type?.const;
        out.push(
          `| \`${path}\` (type \`${String(kind)}\`) | object | | ${textCell(v.description ?? "")} |`,
        );
        rows(v, path, out);
      }
    } else {
      out.push(`| \`${path}\` | ${typeOf(child)} | ${def} | ${description} |`);
    }
  }
}

export function configReference(): string {
  const out = ["| Key | Type | Default | Description |", "| --- | --- | --- | --- |"];
  rows(configJsonSchema() as Node, "", out);
  return out.join("\n");
}

const schemaFile = new URL("../config.schema.json", import.meta.url);
const wikiDir =
  process.env.BKM_WIKI_DIR ?? fileURLToPath(new URL("../../backup-manager.wiki", import.meta.url));
const pageFile = path.join(wikiDir, "Configuration.md");
const schemaText = `${JSON.stringify(configJsonSchema(), null, 2)}\n`;
// null: no wiki checkout here.
const page = await readFile(pageFile, "utf8").catch(() => null);
const start = page?.indexOf(START) ?? -1;
const end = page?.indexOf(END) ?? -1;
const nextPage =
  page !== null && start >= 0 && end > start
    ? `${page.slice(0, start + START.length)}\n${configReference()}\n${page.slice(end)}`
    : page;
const noWiki = `no wiki checkout at ${wikiDir}: the config reference was not checked`;

if (process.argv.includes("--check")) {
  const current = await readFile(schemaFile, "utf8").catch(() => "");
  const problems = [
    current !== schemaText && "config.schema.json is out of date",
    page !== null && start < 0 && `${pageFile} is missing the config reference markers`,
    nextPage !== page && `the config reference in ${pageFile} is out of date`,
  ].filter(Boolean);
  if (problems.length) {
    console.error(`${problems.join("; ")}; run \`npm run schema\``);
    process.exit(1);
  }
  console.log(
    page === null
      ? `config.schema.json is up to date (${noWiki})`
      : "config.schema.json and the wiki's config reference are up to date",
  );
} else {
  await writeFile(schemaFile, schemaText);
  if (page === null) {
    console.log(`wrote config.schema.json (${noWiki.replace("checked", "written")})`);
  } else if (start < 0) {
    console.error(`${pageFile} is missing the config reference markers`);
    process.exit(1);
  } else {
    if (nextPage !== page) await writeFile(pageFile, nextPage as string);
    console.log(`wrote config.schema.json and the config reference in ${pageFile}`);
  }
}
