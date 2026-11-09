// Generates config.schema.json and the README config reference from the zod schema.
// `--check` fails when either is stale (CI and `npm run verify`).
import { readFile, writeFile } from "node:fs/promises";
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

function rows(node: Node, prefix: string, out: string[]) {
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    if (key === "$schema") continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const variants = child.oneOf ?? child.anyOf;
    const def =
      child.default !== undefined &&
      (typeof child.default !== "object" || Array.isArray(child.default))
        ? `\`${JSON.stringify(child.default).replace(/\|/g, "\\|")}\``
        : "";
    const description = (child.description ?? "").replace(/\|/g, "\\|");
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
          `| \`${path}\` (type \`${String(kind)}\`) | object | | ${(v.description ?? "").replace(/\|/g, "\\|")} |`,
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
const readmeFile = new URL("../README.md", import.meta.url);
const schemaText = `${JSON.stringify(configJsonSchema(), null, 2)}\n`;
const readme = await readFile(readmeFile, "utf8");
const start = readme.indexOf(START);
const end = readme.indexOf(END);
const nextReadme =
  start >= 0 && end > start
    ? `${readme.slice(0, start + START.length)}\n${configReference()}\n${readme.slice(end)}`
    : readme;

if (process.argv.includes("--check")) {
  const current = await readFile(schemaFile, "utf8").catch(() => "");
  const problems = [
    current !== schemaText && "config.schema.json is out of date",
    start < 0 && "README.md is missing the config reference markers",
    nextReadme !== readme && "README.md config reference is out of date",
  ].filter(Boolean);
  if (problems.length) {
    console.error(`${problems.join("; ")}; run \`npm run schema\``);
    process.exit(1);
  }
  console.log("config.schema.json and the README config reference are up to date");
} else {
  await writeFile(schemaFile, schemaText);
  if (nextReadme !== readme) await writeFile(readmeFile, nextReadme);
  console.log("wrote config.schema.json and the README config reference");
}
