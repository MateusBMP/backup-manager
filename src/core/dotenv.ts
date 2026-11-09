import { readFile } from "node:fs/promises";

/**
 * Minimal parser for Laravel `.env` files: `KEY=value`, optional `export` prefix,
 * single/double quoted values, `#` comments and blank lines. `${VAR}` interpolation is
 * not performed; such values are kept verbatim and reported in `warnings`.
 */
export interface DotEnv {
  values: Record<string, string>;
  warnings: string[];
}

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/;
const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\", $: "$" };

function unescapeDouble(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\\" && i + 1 < raw.length) {
      const next = raw[++i] as string;
      out += ESCAPES[next] ?? `\\${next}`;
    } else {
      out += ch;
    }
  }
  return out;
}

function parseValue(input: string): string {
  const raw = input.trim();
  if (!raw) return "";
  const quote = raw[0];
  if (quote === '"' || quote === "'") {
    for (let i = 1; i < raw.length; i++) {
      if (raw[i] === "\\" && quote === '"') {
        i++;
        continue;
      }
      if (raw[i] === quote) {
        const inner = raw.slice(1, i);
        return quote === '"' ? unescapeDouble(inner) : inner;
      }
    }
    return raw.slice(1); // unterminated quote: be lenient
  }
  return (raw.split(/\s+#/, 1)[0] ?? "").trim();
}

export function parseDotenv(text: string): DotEnv {
  const env: DotEnv = { values: {}, warnings: [] };
  text.split(/\r?\n/).forEach((line, index) => {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) return;
    const match = LINE.exec(line);
    if (!match) {
      env.warnings.push(`line ${index + 1}: cannot parse ${JSON.stringify(stripped.slice(0, 40))}`);
      return;
    }
    const key = match[1] as string;
    const value = parseValue(match[2] as string);
    if (value.includes("${")) {
      env.warnings.push(`line ${index + 1}: ${key} uses \${...} interpolation, not expanded`);
    }
    env.values[key] = value;
  });
  return env;
}

export async function loadDotenv(file: string): Promise<DotEnv> {
  return parseDotenv(await readFile(file, "utf8"));
}

/** Value of `key`, treating an empty string as absent. */
export function dotenvGet(env: DotEnv, key: string): string | undefined {
  const value = env.values[key];
  return value === undefined || value === "" ? undefined : value;
}
