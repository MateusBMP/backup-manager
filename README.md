# backup-manager

[![CI](https://github.com/MateusBMP/backup-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/MateusBMP/backup-manager/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@mateusbmp/backup-manager)](https://www.npmjs.com/package/@mateusbmp/backup-manager)

`bkm` backs up **MariaDB databases** and **Laravel `storage/` directories**,
grouped by **environment**. You manage everything from one full-screen terminal
UI: environments, schedules, backups, live jobs, retention and the service.

- **No root, no cron.** A user-level systemd service runs the schedules, catches
  up on runs missed while the machine was off, and applies the retention policy.
  Nothing is installed or run with sudo.
- **Backups you can check.** Each backup is a directory with one gzip dump per
  database, one `tar.gz` per project and a `manifest.json` with sizes, SHA-256
  checksums, durations and errors. An interrupted run leaves nothing behind.
- **Jobs survive your session.** Every run is its own process: closing the UI
  or losing the SSH connection does not stop it.
- **Secrets stay out of sight.** Database credentials reach `mariadb-dump` only
  through a temporary 0600 option file: never on a command line, in a log or
  in an API response.
- **A read-only HTTP API** for dashboards and monitoring, on loopback by
  default, with OpenAPI docs.

> **Status:** released. Versions are published on
> [npm](https://www.npmjs.com/package/@mateusbmp/backup-manager), and packages
> for Debian, Ubuntu and Arch are attached to each
> [release](https://github.com/MateusBMP/backup-manager/releases); there is no
> package repository yet. Every supported distribution is tested in CI.

## Components

| Component | Runs as | Purpose |
|---|---|---|
| `bkm` | you, in a terminal | the full-screen UI (React + Ink): everything is managed here, including the service |
| `bkm daemon` | you, as the systemd user unit `bkm.service` | runs the schedules, reloads the config, serves the HTTP API |
| `bkm __job <id>` | you, one process per run | performs one backup job (internal) |
| `bkm doctor` | you | checks the config, tools, directories, project access, databases and the service |

## Supported environments

Linux with systemd (user services) and Node.js 22 or later. Every target is
tested in CI in its own container:

| Distribution | Node.js 22+ comes from | Package |
|---|---|---|
| Debian 12 (bookworm) | NodeSource | `.deb` |
| Debian 13 (trixie) | NodeSource | `.deb` |
| Ubuntu 24.04 LTS | NodeSource | `.deb` |
| Ubuntu 26.04 LTS | the distribution | `.deb` |
| Fedora 44 | the distribution | none: `make install` from the release tarball |
| Arch Linux | the distribution | `.pkg.tar.zst` |

- In each container the package is built from the release tarball, linted
  (lintian, namcap), installed, run and removed. "Run" includes a scheduled
  backup of a project through the real `bkm daemon`, with its manifest,
  archive and API checked. On Fedora the same checks run on `make install`.
- The unit and UI tests run on Node.js 22, 24 and 26, and the integration
  tests against MariaDB 11, on every push.
- Containers have no systemd, so the user service itself is not started in
  CI; its `systemctl` calls are tested against a fake.
- Derivatives (Manjaro, Linux Mint, Pop!_OS, ...) are expected to work but are
  not tested in CI. Development happens on Manjaro. Any other Linux with
  systemd and Node.js 22 or later can use npm.

## Installation

Installing enables nothing. Afterwards, run `bkm` as the user who will own the
backups: the UI creates the config and installs the service, without root.

**From a release.** Download the package for your distribution from the
[latest release](https://github.com/MateusBMP/backup-manager/releases/latest)
and check it with `sha256sum -c SHA256SUMS --ignore-missing`:

```sh
sudo apt install ./backup-manager_*_all.deb               # Debian 12/13, Ubuntu 24.04/26.04
sudo pacman -U backup-manager-*-any.pkg.tar.zst           # Arch Linux / Manjaro
tar xf backup-manager-*.tar.gz && cd backup-manager-*/ && sudo make install   # Fedora and others
```

The packages carry the program already built, with the Node.js libraries it
uses; they need Node.js 22 or later (`nodejs`) from the system. Debian 12/13
and Ubuntu 24.04 ship an older one: the
[Installation](https://github.com/MateusBMP/backup-manager/wiki/Installation)
page shows how to add NodeSource's.

**With npm**, on any distribution:

```sh
npm install -g @mateusbmp/backup-manager   # puts `bkm` on your PATH
```

**Database backups** need the MariaDB client tools (`mariadb-dump`):
`mariadb-client` on Debian and Ubuntu, `mariadb` on Fedora, `mariadb-clients`
on Arch.

## First run

```sh
bkm            # the UI: settings, the first environment, then "Install" for the service
bkm doctor     # checks config, tools, directories, project access, databases and the service
```

A running service keeps the previous code after an upgrade until
`systemctl --user restart bkm`.

## Development

```sh
npm ci                    # also installs the git hooks (husky)
npm run dev -- doctor     # run the CLI from source
npm test                  # unit + UI tests (no root, no database, no systemd)
npm run verify            # schema check + typecheck + lint + coverage + build (pre-push and CI)

make dist                 # the release tarball; then the package checks of one distribution:
docker run --rm -v "$PWD:/src:ro" -v "$PWD/results:/results" debian:13 bash /src/tests/ci/package.sh
```

Tests never touch real systemd or real databases, except the opt-in
integration tests.

## Documentation

The [wiki](https://github.com/MateusBMP/backup-manager/wiki) covers the
architecture, installation, usage, configuration (every key), the HTTP API,
troubleshooting and restoring a backup, security and development.
[CHANGELOG.md](CHANGELOG.md) lists what changed in each release.

## Security

Please report vulnerabilities privately through
[GitHub's vulnerability reporting](https://github.com/MateusBMP/backup-manager/security/advisories/new),
not in a public issue. [SECURITY.md](SECURITY.md) describes the process, what
is in scope and the security design (a user-level service with no root,
credentials kept off the command line, private files, a read-only API,
all-or-nothing backups with checksums).

## License

Copyright (C) 2026 MateusBMP

backup-manager is free software under the GNU General Public License,
version 3 only (`GPL-3.0-only`); see [LICENSE](LICENSE) and [NOTICE](NOTICE).
It comes with ABSOLUTELY NO WARRANTY, to the extent permitted by law.

Versions up to and including 0.3.1 were published under the MIT licence and
keep it. The Node.js libraries that `bkm` runs on are not part of this
repository and keep their own licences (MIT, ISC, BlueOak-1.0.0); the packages
install them with their licence files and a `THIRD-PARTY-LICENSES.txt`.

`bkm --version` prints the version, copyright and licence; `bkm --help` and
the help overlay of the UI (`?`) name them too.
