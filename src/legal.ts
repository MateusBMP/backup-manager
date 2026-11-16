/**
 * Copyright and licence notices: `bkm --version`, the end of `bkm --help`, the UI's help
 * overlay and the API's OpenAPI document. tests/core/legal.test.ts keeps LICENSE, NOTICE,
 * package.json and the distribution packages in step with these lines.
 */
import { VERSION } from "./version.js";

export const PROJECT = "backup-manager";
export const COPYRIGHT = "Copyright (C) 2026 MateusBMP";
export const LICENSE_ID = "GPL-3.0-only";
export const LICENSE_URL = "https://www.gnu.org/licenses/gpl-3.0.html";
export const SOURCE_URL = "https://github.com/MateusBMP/backup-manager";
export const DOCS_URL = `${SOURCE_URL}/wiki`;

const TERMS = [
  `License GPLv3: GNU GPL version 3 only <${LICENSE_URL}>.`,
  "This is free software: you are free to change and redistribute it.",
  "There is NO WARRANTY, to the extent permitted by law.",
];

/** GNU-style `--version` output. */
export function versionText(prog = "bkm"): string {
  return [`${prog} (${PROJECT}) ${VERSION}`, COPYRIGHT, ...TERMS].join("\n");
}

/** Printed after `bkm --help`. */
export function helpNotice(): string {
  return [`${PROJECT} ${VERSION}  ${COPYRIGHT}`, ...TERMS, `Documentation: <${DOCS_URL}>`].join(
    "\n",
  );
}

/** Two short lines for the UI's help overlay (the UI is the program's interactive mode). */
export function uiNotice(): [string, string] {
  return [
    `${PROJECT} ${VERSION} · ${COPYRIGHT}`,
    `${LICENSE_ID} · NO WARRANTY · details: bkm --version`,
  ];
}
