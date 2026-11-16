# Changelog

All notable changes to backup-manager. Versions follow [Semantic Versioning](https://semver.org/).
The Debian package spells a pre-release with `~` (1.0.0-rc.1 is 1.0.0~rc.1); the Arch package
drops the hyphen (1.0.0rc.1).

## [0.4.1] - 2026-11-16

### Changed
- Updated bundled libraries: tar 7.5.23, hono 4.13.18 and @hono/node-server
  2.1.8. The npm install and the packages carry the same versions.

## [0.4.0] - 2026-11-16

### Changed
- **Action needed:** the licence is now GPL-3.0-only (versions up to 0.3.1 stay
  MIT). Using the program is unaffected; if you redistribute or modify it,
  read `LICENSE` and `NOTICE` first.
- `bkm --version` prints the version, the copyright and the licence in the GNU
  style, on several lines. A script that reads the version should take the
  last word of the first line.
- `bkm --help` ends with the copyright, the licence and a link to the
  documentation.
- The documentation moved from the README to the wiki; the README keeps the
  basics. The table of configuration keys is generated from the schema.

### Added
- The help overlay (`?`) shows the version, the copyright and the licence.
- API: the OpenAPI document names the licence.
- `SECURITY.md`, with how to report a vulnerability, and this changelog.

### Fixed
- The help overlay moves up on short terminals so that its last line stays on
  screen.

### Packaging
- Packages for Debian 12 and 13, Ubuntu 24.04 and 26.04 (`.deb`) and Arch
  Linux, and a release tarball with `make install` for Fedora and other
  systems. They carry the program already built with its dependencies, so
  installing needs Node.js 22 or later but not npm.
- Every package installs the licence, the notices and the licence texts of the
  bundled libraries (`THIRD-PARTY-LICENSES.txt`).
- Nothing is enabled on install: each user still installs the service from the
  UI, without root.

## [0.3.1] - 2026-11-10

### Fixed
- The Service screen shows the service log of system users (UID below 1000):
  systemd keeps no per-user journal for them, so the log is read from the
  system journal instead.

## [0.3.0] - 2026-11-10

### Added
- API: `GET /environments/{env}` reports the total, free and used bytes of the
  filesystem that holds the backup directory.
- API: `GET /environments/{env}/projects/{project}/backups` lists a project's
  item in every backup, with its databases, newest first.

## [0.2.2] - 2026-11-10

### Fixed
- The service can be installed and managed from shells opened with `su`,
  `sudo -u` or SSH without a login session: the systemd user bus is found
  under `/run/user/<uid>`, and when no user manager is running the error says
  how to get one.

## [0.2.1] - 2026-11-10

### Added
- Every action on the footer line is also a button, for terminals that swallow
  chords like Ctrl-S: Ctrl+↓ (or Alt+↓) focuses the button bar, ←→ pick a
  button, ⏎ presses it. Ctrl+← focuses the sidebar and Ctrl+→ or Ctrl+↑ the
  content.
- Forms have save and cancel buttons, lists their actions, and screens reached
  from another one a back button.

## [0.1.1] - 2026-11-09

### Added
- First release on npm, as `@mateusbmp/backup-manager`: backups of MariaDB
  databases and Laravel storage directories per environment, a full-screen
  terminal UI, a user-level systemd service with cron schedules and catch-up,
  retention, `bkm doctor` and a read-only HTTP API.

[0.3.1]: https://www.npmjs.com/package/@mateusbmp/backup-manager/v/0.3.1
[0.3.0]: https://www.npmjs.com/package/@mateusbmp/backup-manager/v/0.3.0
[0.2.2]: https://www.npmjs.com/package/@mateusbmp/backup-manager/v/0.2.2
[0.2.1]: https://www.npmjs.com/package/@mateusbmp/backup-manager/v/0.2.1
[0.1.1]: https://www.npmjs.com/package/@mateusbmp/backup-manager/v/0.1.1
[0.4.0]: https://github.com/MateusBMP/backup-manager/releases/tag/v0.4.0
[0.4.1]: https://github.com/MateusBMP/backup-manager/releases/tag/v0.4.1
