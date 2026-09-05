# Changelog

All notable changes to VOID CLIENT.

## [1.0.1] — 2026-09-06

### Added

- One-click auto-update: the launcher downloads the new installer, verifies its SHA-256 checksum against the manifest and runs it silently.
- Anonymous telemetry — one ping per day (launcher version, OS, arch, unique install id) to the project's own endpoint, plus a password-protected dashboard.
- In-app news notices (`notices` in `version.json`) — shown once via Windows notifications.
- macOS builds (Intel x64 + Apple Silicon arm64): dmg + zip, built by the same CI matrix on tagged releases.
- RSS/Atom feed, sitemap.xml and robots.txt on the website.
- Download counter endpoint (`counter.php`) and live count on the site.
- Open Graph / social preview cards on both pages.

### Changed

- Launcher version bumped to 1.0.1.
- Update manifest now carries per-platform SHA-256 sums.

### Fixed

- Forge auto-install edge cases around the recommended build lookup.

## [1.0.0] — 2026-09-05

First public release.

### Added

- Discord Rich Presence — shows "Playing VOID CLIENT" while the launcher is open.
- Self-update check — compares against `version.json` on GitHub Pages and prompts to download when a newer build exists.
- Full multi-size icon set (16–256 px) and `favicon.ico` on the website.
- Multi-size `.ico` embedded into the Windows executable for crisp 16…256 px rendering.
- GitHub Actions auto-build: pushing a `v*` tag builds Windows + Linux and attaches the artifacts to the release.
- GitHub Release `v1.0.0` with `VOID_Launcher.exe`, `VOID_Client_Setup_1.0.0.exe` and `void-client-1.0.0.tar.gz`.

### Changed

- Launcher version set to 1.0.0 (was 2.4.1 in development).
- Website now ships as a static build for GitHub Pages (`docs/`); download buttons point at the GitHub Release.
- Repository layout: `mc-launcher/` (sources), `docs/` (site), README, MIT license.

### Fixed

- Slider thumb cursor/hover animation on the launcher settings.
- Site reveal animations after a stylesheet encoding corruption.