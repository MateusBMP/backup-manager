# backup-manager

[![CI](https://github.com/MateusBMP/backup-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/MateusBMP/backup-manager/actions/workflows/ci.yml)

`bkm` backs up **MariaDB databases** and **Laravel `storage/` directories**, grouped by
**environment**. You manage everything from one full-screen terminal UI. That includes environments,
schedules, backups, live jobs, retention and the service. A **user-level systemd service** runs
the schedules and serves a read-only **HTTP API**. No cron, no root and no sudo are needed.

- [Overview](#overview)
- [Requirements](#requirements)
- [Installation](#installation)
- [First run](#first-run)
- [The service](#the-service)
- [Schedules](#schedules)
- [Configuration](#configuration)
- [The UI](#the-ui)
- [Jobs](#jobs)
- [HTTP API](#http-api)
- [Command line](#command-line)
- [Development](#development)
- [For LLMs](#for-llms)

---

## Overview

### Concepts

| Concept         | Meaning                                                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Environment** | The unit of scheduling, retention and locking, e.g. `production` or `staging`. It has any number of projects and databases.                                                                      |
| **Project**     | A Laravel application. Its `include` directories (default `storage/app`) are archived into `projects/<name>.tar.gz`, minus the `exclude` globs.                                                  |
| **Database**    | One `mariadb-dump` output (one or more schemas) saved as `databases/<name>.sql.gz`. Credentials come from a project's `.env` (a `laravel` source) or are set explicitly (a `connection` source). |
| **Backup**      | A directory `<id>/` (`YYYYMMDD-HHMMSS`) with the files above and a `manifest.json` (sizes, SHA-256, durations, errors).                                                                          |
| **Job**         | One run that backs up one or more environments, in its own process. Its status and an event log live in the state directory.                                                                     |

### On disk

```
~/.local/share/backup-manager/backups/production/   # <backupDir>/<environment>
├── 20261109-033000/
│   ├── manifest.json
│   ├── databases/shop.sql.gz
│   └── projects/shop.tar.gz
└── .tmp-20261110-033000/                           # in progress; renamed when finished

~/.local/state/backup-manager/
├── jobs/<job-id>.json        # status, trigger, pid, timestamps, result
├── logs/<job-id>.ndjson      # structured events (log, item-start/progress/done, job-done)
├── locks/<environment>.lock  # one run per environment at a time
└── schedule.json             # last scheduled run per environment (for catch-up)
```

A backup is **complete** when every item succeeded and **partial** when some items failed;
the rest are kept and the errors are recorded. A backup without a manifest is **incomplete**.
If every item fails, nothing is kept.

### Architecture

```
                 ┌──────────────── bkm ────────────────┐
  terminal ────▶ │  UI (React + Ink, full screen)      │       systemd --user
                 │  doctor (CLI)                       │      ┌─────────────────────────┐
                 └──────────────────┬──────────────────┘      │ bkm daemon              │
                                    ▼                         │  scheduler (croner)     │
                              core/services.ts ◀──────────────│  catch-up · reload      │
         ┌─────────────┬────────────┼──────────────┬─────────┤  HTTP API (Hono)        │
         ▼             ▼            ▼              ▼         └─────────────────────────┘
   config/store   jobs/runner   backup/catalog   service/manager ──▶ systemctl --user
   (JSON, zod)        │         backup/prune
                      ▼
            bkm __job <id>  (detached from the UI, a child of the daemon)
               └─ backup/pipeline ─┬─ mariadb-dump → gzip
                                   └─ tar.gz (node-tar + globs)
```

## Requirements

- Linux with **systemd** (user services) and **Node.js ≥ 22**.
- MariaDB client tools: `mariadb-dump` (or `mysqldump`) and `mariadb` (or `mysql`).
  Debian/Ubuntu: `apt install mariadb-client`. Arch/Manjaro: `pacman -S mariadb-clients`.
- A database user that can dump, for example:

  ```sql
  CREATE USER 'backup'@'localhost' IDENTIFIED BY '…';
  GRANT SELECT, SHOW VIEW, TRIGGER, EVENT, LOCK TABLES, PROCESS ON *.* TO 'backup'@'localhost';
  ```
- **Read access** to the Laravel project directories and their `.env` files. The service
  runs as your user, so if the projects belong to `www-data`, add yourself to that group
  (`sudo usermod -aG www-data $USER`, then log in again). `bkm doctor` checks this.

## Installation

```bash
git clone https://github.com/MateusBMP/backup-manager.git
cd backup-manager
npm ci && npm run build
npm install -g .          # puts `bkm` on your PATH
```

## First run

Run `bkm` in a terminal. With no config file, the UI walks you through two steps:

1. **Settings:** where backups go and how long to keep them. This writes
   `~/.config/backup-manager/config.json`, which keeps only the values you changed.
2. **First environment:** name, an optional schedule, then projects and databases. You can
   also add them later. Choose **Install** when asked, and the service starts running your
   schedules.

`bkm doctor` checks everything afterwards: config, tools, directories, project access,
database connections and the service.

## The service

The service is a **user-level** systemd unit, `~/.config/systemd/user/bkm.service`. Setting it
up never uses sudo or root. You install and manage it from the **Service** screen in `bkm`
(onboarding also offers to install it):

| Action | What it does |
| ------ | ------------ |
| **Install / update** | Writes the unit, runs `daemon-reload` and `enable --now`, and enables lingering. If the unit is outdated, it is rewritten and the service restarted. Running it again when nothing changed does nothing. |
| **Start / Stop / Restart** | `systemctl --user start\|stop\|restart bkm` |
| **Reload config** | `systemctl --user reload bkm` (SIGHUP) |
| **Uninstall** | `disable --now`, removes the unit, `daemon-reload`. Config, backups and job history are kept. |

The same unit can be handled with the usual tools:

```bash
systemctl --user status bkm
systemctl --user reload bkm      # re-read config.json (it also reloads by itself when the file changes)
systemctl --user restart bkm
journalctl --user -u bkm -f      # scheduler and job log
```

- **Lingering:** **Install / update** runs `loginctl enable-linger $USER`. This lets the service start at
  boot and keep running after you log out. On most systems this needs no root. If your
  system refuses it, the install still succeeds, with a warning that the service only runs
  while you are logged in.
- **Upgrades:** the unit stores absolute paths to `node` and `bkm`. If either one moves
  (an nvm upgrade or a reinstall), `bkm doctor` and the UI flag the unit as **outdated**.
  Choose **Install / update** on the Service screen to rewrite it.
- **Stopping:** on `systemctl --user stop bkm`, the daemon stops scheduling and waits up to
  5 minutes for running jobs. Then it cancels them; an unfinished backup is discarded.

## Schedules

Each environment can have a `schedule`, which is a cron expression. Without one, it is
backed up only on demand.

| Expression       | Meaning                                    |
| ---------------- | ------------------------------------------ |
| `30 3 * * *`     | daily at 03:30                             |
| `0 */6 * * *`    | every 6 hours                              |
| `0 2 * * 1-5`    | weekdays at 02:00                          |
| `0 4 1 * *`      | monthly on the 1st at 04:00                |
| `*/30 * * * * *` | every 30 seconds (6 fields: seconds first) |

- Times are in `settings.timezone`, or the system timezone when it is not set. The editor
  shows a description and the next three runs as you type.
- **Catch-up:** if the service was down when a run was due (for example, the machine was
  off), that run happens once when the service starts again.
- An environment never runs twice at the same time. A run that is due while the previous one
  is still going is skipped and logged. `settings.maxConcurrentJobs` limits how many
  environments run at once.

## Configuration

The config is one JSON file, normally edited from the UI.

- **Location:** `--config` (or `-c`), then `$BKM_CONFIG`, then `$XDG_CONFIG_HOME/backup-manager/config.json`.
- **Saving:** the UI writes it atomically with mode 0600 and keeps the previous version as
  `config.json.bak`. It writes only non-default values. If the file changed on disk since it
  was loaded, the UI reloads it instead of overwriting.
- **Editor support:** `config.schema.json` gives editors autocompletion and validation through
  the `$schema` key. See [`config.example.json`](config.example.json) for a complete example.
- **Errors** are reported by JSON path, e.g. `environments[0].schedule: invalid cron expression`.
- **Passwords:** prefer `passwordFile` over `password`. Either way, credentials reach
  `mariadb-dump` only through a temporary 0600 option file, never on the command line.

Every key (generated from the schema):

<!-- config-reference:start -->
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `version` | `1` | `1` | Config format version. |
| `settings` | object | | Global settings. |
| `settings.backupDir` | string |  | Root directory for backups. Default: $XDG_DATA_HOME/backup-manager/backups. |
| `settings.stateDir` | string |  | Directory for jobs, logs, locks and schedule state. Default: $XDG_STATE_HOME/backup-manager. |
| `settings.compressLevel` | integer 1–9 | `6` | gzip compression level for dumps and archives (1 fastest … 9 smallest). |
| `settings.autoPrune` | boolean | `true` | Apply the retention policy after every successful backup. |
| `settings.timezone` | string |  | IANA timezone for schedules, e.g. 'America/Sao_Paulo'. Default: the system timezone. |
| `settings.maxConcurrentJobs` | integer 1–16 | `1` | Maximum scheduled jobs the daemon runs at the same time. |
| `retention` | object | | Retention policy. A backup is kept when either rule keeps it. |
| `retention.keepLast` | integer ≥ 0 | `7` | Keep the newest N complete backups (0 disables this rule). |
| `retention.keepDays` | integer ≥ 0 | `30` | Keep complete backups younger than N days (0 disables this rule). |
| `api` | object | | Read-only HTTP API served by `bkm daemon`. |
| `api.enabled` | boolean | `true` | Serve the read-only HTTP API from the daemon. |
| `api.host` | string | `"127.0.0.1"` | Address to bind. |
| `api.port` | integer 1–65535 | `8080` | TCP port. |
| `api.token` | string |  | Bearer token required by every route except /health, /docs and /openapi.json. |
| `api.tokenFile` | string |  | File containing the bearer token (alternative to token). |
| `environments[]` | object[] | | Environments, in display order. |
| `environments[].name` | string |  | Environment name: lowercase letters, digits, '-' and '_'. |
| `environments[].schedule` | string |  | Cron expression (5 or 6 fields) for automatic backups. Omit for manual only. |
| `environments[].backupDir` | string |  | Backup directory used as-is. Default: <settings.backupDir>/<name>. |
| `environments[].retention` | object | | Per-environment retention override. |
| `environments[].retention.keepLast` | integer ≥ 0 |  | Overrides the global keepLast. |
| `environments[].retention.keepDays` | integer ≥ 0 |  | Overrides the global keepDays. |
| `environments[].projects[]` | object[] | | Laravel projects whose storage is archived. |
| `environments[].projects[].name` | string |  | Project name: lowercase letters, digits, '-' and '_'. |
| `environments[].projects[].path` | string |  | Absolute path to the Laravel project root (the directory with artisan). |
| `environments[].projects[].include` | string[] | `["storage/app"]` | Directories to archive, relative to the project root. |
| `environments[].projects[].exclude` | string[] | `["storage/framework/{cache,sessions,views}/**","storage/logs/**","**/.gitignore"]` | Glob patterns (relative to the project root) to leave out. 'dir/**' keeps the empty directory. |
| `environments[].databases[]` | object[] | | Databases dumped with mariadb-dump. |
| `environments[].databases[].name` | string |  | Database name: lowercase letters, digits, '-' and '_'. |
| `environments[].databases[].source` (type `laravel`) | object | | Read the connection from a Laravel project's .env; any field set here wins. |
| `environments[].databases[].source.type` | `"laravel"` |  |  |
| `environments[].databases[].source.project` | string |  | Project (in the same environment) whose .env provides DB_* values. |
| `environments[].databases[].source.host` | string |  | Server host. |
| `environments[].databases[].source.port` | integer 1–65535 |  | Server port. |
| `environments[].databases[].source.socket` | string |  | Unix socket path (instead of host/port). |
| `environments[].databases[].source.user` | string |  | User name. |
| `environments[].databases[].source.password` | string |  | Password. Prefer passwordFile. |
| `environments[].databases[].source.passwordFile` | string |  | File containing the password (first line). |
| `environments[].databases[].source.database` | string |  | Overrides DB_DATABASE. |
| `environments[].databases[].source` (type `connection`) | object | | An explicit MariaDB/MySQL connection. |
| `environments[].databases[].source.type` | `"connection"` |  |  |
| `environments[].databases[].source.host` | string |  | Server host. |
| `environments[].databases[].source.port` | integer 1–65535 |  | Server port. |
| `environments[].databases[].source.socket` | string |  | Unix socket path (instead of host/port). |
| `environments[].databases[].source.user` | string |  | User name. |
| `environments[].databases[].source.password` | string |  | Password. Prefer passwordFile. |
| `environments[].databases[].source.passwordFile` | string |  | File containing the password (first line). |
| `environments[].databases[].source.schemas` | string[] |  | Schemas (databases) to dump into one file. |
| `environments[].databases[].extraArgs` | string[] | `[]` | Extra arguments for mariadb-dump, e.g. ['--ignore-table=app.sessions']. |
<!-- config-reference:end -->

## The UI

```
 ▓▒░ backup-manager ░▒▓                      host · service ● active · 2 envs · 12:04
╭──────────────────╮ ╭─ Environments ───────────────────────────────────────────────╮
│ ● Dashboard      │ │ ❯ production  2 db · 1 proj   14 bkp   3.1 GiB  ✔ 2h  ⏱ 03:30 │
│   Environments   │ │   staging     1 proj           6 bkp 220 MiB  ⚠ 1d  ⏱ —     │
│   Backups        │ ╰──────────────────────────────────────────────────────────────╯
│   Jobs         1 │ ╭─ Running ────────────────────────────────────────────────────╮
│   New backup     │ │ ⠹ production · database shop  ████████░░░░ 1/2  41s  schedule│
│   Prune          │ ╰──────────────────────────────────────────────────────────────╯
│   Service        │ ╭─ Recent backups ─────────────────────────────────────────────╮
│   Doctor         │ │ ✔ production  20261109-033000  complete   1.6 GiB  9h ago    │
│   Settings       │ ╰──────────────────────────────────────────────────────────────╯
╰──────────────────╯
 ↑↓ move  ⏎ backups  r run now  n new backup  e environments  tab pane  ? help  q quit
```

| Screen                 | What you can do                                                                                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dashboard**          | Environments at a glance, running jobs with progress, recent backups. `r` runs the selected environment now.                                                                     |
| **Environments**       | `a` add, `⏎` edit, `d` delete (backups on disk are kept), `b` its backups, `r` run now.                                                                                          |
| **Environment editor** | Name, schedule with a live preview, backup dir and retention overrides, plus its projects and databases. Projects detect `artisan`. Databases have a **Test connection** action. |
| **Backups**            | Per environment (`←→`), filter by status (`f`), `⏎` details with every item, checksum and error.                                                                                 |
| **Jobs**               | Every run with its trigger (`ui`, `schedule`, `catch-up`). `⏎` follows one live, `x` stops it.                                                                                   |
| **New backup**         | Pick environments, then items, then confirm. The job starts detached and opens its live view.                                                                                    |
| **Prune**              | A dry run of the retention policy. `p` applies it after confirmation.                                                                                                            |
| **Service**            | State, linger and outdated badges; install, start, stop, restart, reload and uninstall; journal tail; next runs; API address.                                                    |
| **Doctor**             | The same checks as `bkm doctor`; `r` runs them again.                                                                                                                            |
| **Settings**           | Storage, retention, scheduler and API settings.                                                                                                                                  |

**Keys:** `↑↓`/`j k` move · `g G`/`Home End` first/last · `PgUp PgDn` · `⏎` open ·
`Esc` back · `Tab` switches between the sidebar and the content (in forms, it moves to the next
field) · `1`–`9` jump to a menu entry · `n` new backup · `e` environments · `s` service ·
`Ctrl-S` saves a form · `?` help · `q` quit.

Below 90 columns the sidebar becomes a tab bar, and below 60×16 the UI asks you to resize.
`NO_COLOR` is honored.

## Jobs

Every backup runs in its own process (`bkm __job <id>`):

- **Started from the UI**, the job is **detached** in its own session. Quitting the UI or
  losing the SSH connection does not stop it. Open `bkm` again and **Jobs** shows it, live.
- **Started by the service**, the job is a normal child of the daemon. It stays in the
  service's cgroup, so `systemctl --user stop bkm` shuts it down cleanly.
- **Stopping** a job (`x`) signals its whole process group, so `mariadb-dump` stops too, and the
  unfinished backup is discarded. If a job's process disappears, the job is marked failed.
- After each **complete** backup, the retention policy is applied (`settings.autoPrune`).

## HTTP API

The service serves a read-only API, at `http://127.0.0.1:8080` by default (see `api.*`).
OpenAPI docs are at `/docs`.

| Route                                            | Returns                                                                                   |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `GET /health`                                    | status, version, uptime, next scheduled runs                                              |
| `GET /environments`                              | summaries: counts, sizes, last backup, `nextRun`, running                                 |
| `GET /environments/{env}`                        | the summary plus `backupDir` and effective retention                                      |
| `GET /environments/{env}/projects`               | name, path, include, exclude                                                              |
| `GET /environments/{env}/databases`              | name, type, project, host, port, socket, schemas (**never** user, password or extra args) |
| `GET /environments/{env}/backups?status=&limit=` | backups, newest first                                                                     |
| `GET /environments/{env}/backups/{id}`           | one backup with every item from its manifest                                              |
| `GET /jobs?limit=`                               | recent jobs                                                                               |

When `api.token` or `api.tokenFile` is set, every route except `/health`, `/docs` and
`/openapi.json` needs `Authorization: Bearer <token>`. If the API binds to a non-loopback
address without a token, the service logs a warning.

```bash
curl -s http://127.0.0.1:8080/environments | jq
curl -s -H "Authorization: Bearer $(cat ~/.config/backup-manager/api.token)" http://127.0.0.1:8080/jobs
```

## Command line

The CLI is deliberately small: everything else, including installing the service, is in the UI.

| Command                             | Purpose                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| `bkm`                               | Full-screen UI. Without a terminal (TTY), it prints help and exits 2.                   |
| `bkm doctor [--no-db]`              | Check everything; prints ✔/!/✘ and exits 1 when something fails.                        |
| `bkm daemon`                        | The service process. systemd starts it; you can also run it in the foreground to debug. |

Global options: `-c/--config <path>`, `-v/--version`, `-h/--help`.
Exit codes: `0` ok, `1` failure, `2` config or usage error (also when there is no config yet),
`3` the environment is already being backed up.

## Development

```bash
npm ci                    # also installs the git hooks (husky)
npm run dev               # run the CLI from source (tsx), e.g. npm run dev -- doctor
npm test                  # unit + UI tests (vitest)
npm run coverage          # with the coverage gate (lines/statements/functions ≥ 85%, branches ≥ 75%)
npm run test:integration  # real MariaDB, see below
npm run lint              # Biome (format + lint); `npm run format` fixes
npm run typecheck         # tsc --noEmit (TypeScript 7, strict)
npm run schema            # regenerate config.schema.json and the config table in this README
npm run build             # tsup → dist/cli.js
npm run verify            # schema check + typecheck + lint + coverage + build (same as pre-push and CI)
```

- **Git hooks:** pre-commit runs `biome check --write` on staged files. Pre-push runs
  `npm run verify` and blocks the push if it fails.
- **CI** runs on pushes to `main`, on PRs and manually. Jobs: lint/types/schema; tests on
  Node 22, 24 and 26; integration against a MariaDB 11 service; and pack + install +
  CLI smoke test (`--help`, `doctor`, a short `daemon` run). **CodeQL** (`security-extended`)
  scans the TypeScript and the workflows on pushes, PRs and weekly.
- **Dependabot** updates npm packages and actions weekly (dev tools in one PR) and groups
  security updates into one PR per ecosystem. `@types/node` majors are bumped by hand, since
  they track the oldest supported Node. Dependabot malware alerts are enabled in the repo settings.
- **Integration tests** run only when a database is configured:
  `BKM_IT_DB_HOST`/`PORT`/`USER`/`PASSWORD` (or `BKM_IT_DB_SOCKET`) and `BKM_IT_DB_NAME`
  (default `bkm_it`). `BKM_IT_DB_CREATE=1` creates the schema and a table first. Without it,
  the schema is only read, so the tests are safe against a local server, e.g.
  `BKM_IT_DB_SOCKET=/run/mysqld/mysqld.sock BKM_IT_DB_NAME=test npm run test:integration`.
- Tests never touch real systemd (a fake runner is injected) or real databases (a fake
  `mariadb-dump` is put on `PATH`), except the opt-in integration tests.

## For LLMs

`CLAUDE.md`, `AGENTS.md`, `.claude/` and `.agents/` are **gitignored**. Each developer or AI
agent recreates them locally, and **this section is the source of truth** for them. When
commands or architecture change, update this section in the same commit.

### Recreating the agent environment

If you are an AI coding agent (Claude Code, Codex, or another `AGENTS.md`-compatible tool)
starting work on this repository:

1. Read this README completely.
2. Bootstrap and verify that the project is healthy: `npm ci && npm run verify`.
3. Create the local instructions file from the "Agent context" block below:
   - **Claude Code:** write `CLAUDE.md`.
   - **Other agents:** write `AGENTS.md`.
4. Optionally allow the routine commands in `.claude/settings.local.json`, e.g.
   `Bash(npm test:*)`, `Bash(npm run verify:*)`, `Bash(npx vitest:*)`, `Bash(npx biome:*)`, `Bash(npx tsc:*)`.

### Agent context (paste into CLAUDE.md / AGENTS.md)

```markdown
# backup-manager — agent context

TypeScript (Node ≥22, ESM, strict) tool `bkm`: backs up MariaDB databases (mariadb-dump → gzip)
and Laravel storage dirs (tar.gz) per environment. Full-screen React + Ink 8 UI; a user-level
systemd service (`bkm daemon`) runs cron schedules (croner) and a read-only Hono API.
JSON config validated by zod. npm.

## Commands

- Install: `npm ci` · Run from source: `npm run dev -- <args>` · Build: `npm run build`
- Test: `npm test` · coverage gate: `npm run coverage` · one file: `npx vitest run tests/core/jobs.test.ts`
- Integration (real MariaDB): `BKM_IT_DB_SOCKET=/run/mysqld/mysqld.sock BKM_IT_DB_NAME=test npm run test:integration`
- Lint/format: `npm run lint` / `npm run format` (Biome) · Types: `npm run typecheck`
- Schema + README config table: `npm run schema` (CI fails if stale)
- Full gate (pre-push and CI): `npm run verify`

## Architecture

- `src/cli.tsx` → `src/cli/program.ts` (commander): default = UI, `doctor`, `daemon`, hidden `__job <id>`. Service install/uninstall is UI-only (Service screen → `ServiceManager`).
- `src/core/` never imports React. `core/services.ts` is the only facade used by the CLI, UI, API and daemon.
- Config: `core/config/schema.ts` (zod, single source of truth) → `load.ts` (errors as JSON paths) → `store.ts` (the ONLY writer: minimal, atomic, 0600, `.bak`, mtime conflict check). `defaults.ts` resolves paths and retention.
- Backups: `core/backup/pipeline.ts` (one env; `.tmp-<id>` → manifest → rename; auto-prune), `mariadb.ts`, `archive.ts`, `catalog.ts`, `retention.ts` (pure), `prune.ts`, `lock.ts`.
- Jobs: `core/jobs/store.ts` (JSON status), `events.ts` (NDJSON), `runner.ts` (`startJob` spawns `bkm __job`: detached from the UI, a normal child from the daemon; `executeJob` runs it).
- Daemon: `core/daemon/` (scheduler, catch-up via `schedule.json`, reload on file change or SIGHUP, graceful stop) + `src/api/server.ts`.
- systemd: `core/service/` — every systemctl/journalctl/loginctl call goes through the injectable `CommandRunner` in `systemctl.ts`, always `--user`, never sudo, never a shell.
- UI: `src/ui/App.tsx` (frame, routing, global keys, toasts, modals), `screens/`, `components/` (Form, TextField, ScrollList/ScrollView, Panel), `hooks/` (usePolling, useJobEvents). `ui/print/` renders doctor output for the CLI.

## Conventions

- Ink: colors only from `ui/theme.ts`; gate every `useInput` with `isActive` (`useScreenActive()`); forms take the keyboard via `useCaptureKeys`; size from the App context (`width`/`height`), not ad-hoc.
- Tests: vitest + ink-testing-library (100 columns; send a no-op key after mount and wait before keys; match frames after `stripVTControlCharacters`, since CI forces color). Temp dirs via `tests/helpers.ts`; fake `mariadb-dump` (`installFakeDump`) and fake systemd (`fakeSystemd`).
- Every behavior change needs tests; keep README (and this block) in sync in the same change.

## Safety

- Secrets never in argv, logs or API responses (credentials go through a 0600 `--defaults-extra-file`).
- Tests never call the real systemctl or real databases (except opt-in integration tests).
- Never commit `config.json`, `*.pw`, tokens, or CLAUDE.md/AGENTS.md. Do not commit or push unless asked; never `--no-verify`.
```

## License

[MIT](LICENSE) © 2026 MateusBMP
