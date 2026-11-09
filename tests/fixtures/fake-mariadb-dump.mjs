#!/usr/bin/env node
// Stand-in for mariadb-dump / mariadb used by the tests (linked into a temp bin dir on PATH).
// FAKE_DUMP_LOG: append {tool,args,cnf} JSON lines; FAKE_DUMP_SLEEP_MS: stall before exiting;
// a password of "wrong" fails like an access-denied error.
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const optionFile = args.find((a) => a.startsWith("--defaults-extra-file="))?.split("=")[1];
const cnf = optionFile ? readFileSync(optionFile, "utf8") : "";
if (process.env.FAKE_DUMP_LOG) {
  appendFileSync(process.env.FAKE_DUMP_LOG, `${JSON.stringify({ tool, args, cnf })}\n`);
}
if (cnf.includes('password="wrong"')) {
  process.stderr.write("ERROR 1045 (28000): Access denied for user 'backup'@'localhost'\n");
  process.exit(2);
}
if (tool === "mariadb" || tool === "mysql") process.exit(0);

const schemas = args.includes("--databases")
  ? args.slice(args.indexOf("--databases") + 1)
  : [args.at(-1)];
process.stdout.write(`-- fake dump\n-- schemas: ${schemas.join(",")}\n`);
for (let i = 0; i < 2000; i++) process.stdout.write(`INSERT INTO t VALUES (${i}, 'row ${i}');\n`);
const sleep = Number(process.env.FAKE_DUMP_SLEEP_MS || 0);
if (sleep) setTimeout(() => process.exit(0), sleep);
