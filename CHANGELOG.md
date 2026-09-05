# Changelog

All notable changes to VOID CLIENT.

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