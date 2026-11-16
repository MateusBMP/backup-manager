# Security policy

backup-manager handles database credentials, database dumps and application
files, runs a background service and serves an HTTP API. Security reports are
welcome and taken seriously.

## Supported versions

Only the latest release and the latest commit on `main` are supported; fixes
are not backported to older releases.

## Reporting a vulnerability

**Please do not open a public issue for a vulnerability.**

Report it privately through GitHub:
[**Report a vulnerability**](https://github.com/MateusBMP/backup-manager/security/advisories/new)
(the *Security* tab → *Report a vulnerability*). Only the maintainers can see
the report.

Please include:

- the version (`bkm --version`), how it was installed (npm, a package,
  `make install`), the distribution and the versions of Node.js, systemd and
  the MariaDB client;
- what an attacker needs (another local user, a client of the HTTP API, a host
  on the network, control over a project directory or a database) and what
  they gain;
- steps to reproduce, or a proof of concept;
- the output of `bkm doctor` if it helps (check it for anything you do not
  want to share first).

What to expect:

- an acknowledgement within 7 days;
- an assessment and a plan, discussed with you in the private advisory;
- a fix on `main`, then a published GitHub security advisory crediting you
  (unless you prefer not to be named). Please keep the details private until
  the advisory is published.

## Scope

In scope, for example:

- database passwords or the API token appearing in a process list, a log, a
  job event, an API response or a file readable by other users;
- the HTTP API changing anything, answering without the configured token, or
  returning database users, passwords or extra dump arguments;
- another local user reading or changing the config, the backups, the job
  records or the service unit through permissions that `bkm` set;
- a project directory, a `.env` file, a database name or a config value
  injecting options or commands into `mariadb-dump`, `systemctl`,
  `journalctl`, `loginctl` or a shell, or making an archive include files
  outside the project;
- a `sudo` or root step where the documentation says none is needed;
- an interrupted or failed run left behind as a backup that looks complete;
- the distribution packages or `make install` installing files writable by
  other users, or overwriting files they do not own.

Out of scope (documented limitations, not vulnerabilities; normal issues are
fine for these):

- backups are not encrypted: whoever can read the backup directory can read
  the dumps;
- a `password` or `api.token` written in the config is stored in plain text
  in a file readable only by its owner;
- the HTTP API speaks plain HTTP and is meant to stay on loopback;
- anything that requires root, or access to the account that runs `bkm`;
- vulnerabilities in Node.js, MariaDB or a third-party library that do not
  change what `bkm` exposes (report them to their projects; Dependabot
  updates the libraries here).

## Security design

A summary; the details are in the [Security](https://github.com/MateusBMP/backup-manager/wiki/Security)
and [Architecture](https://github.com/MateusBMP/backup-manager/wiki/Architecture)
wiki pages.

- **No root.** The service is a systemd user unit. Every `systemctl`,
  `journalctl` and `loginctl` call uses `--user` and an argument list: never
  sudo, never a shell.
- **Credentials off the command line.** They reach `mariadb-dump` only
  through a temporary option file with mode 0600, and never appear in logs or
  API responses.
- **Private files.** The config, backups, manifests, job records and logs are
  created readable only by their owner (0600 files, 0700 directories).
- **A read-only API.** No route changes anything; it listens on loopback by
  default and supports a bearer token compared in constant time.
- **Whole or nothing.** A run is written to a temporary directory and renamed
  only when its manifest, with a SHA-256 for every file, is written.
- **Verified releases.** npm versions are staged by CI with provenance and
  approved by a maintainer with two-factor authentication; the distribution
  packages are built from the tagged commit and published with `SHA256SUMS`.
