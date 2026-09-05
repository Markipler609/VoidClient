# VOID CLIENT

Minimalistic Minecraft launcher with a Y2K look, built on Electron. Vanilla + Fabric, Forge, NeoForge and Quilt for Minecraft 1.21.4+.

- Website: https://markipler609.github.io/VoidClient/ (sources in `docs/`, served from GitHub Pages)
- Downloads: [Releases](https://github.com/Markipler609/VoidClient/releases)
- Launcher source & build docs: [`mc-launcher/`](mc-launcher/)
- Website source: [`docs/`](docs/)

## Repository layout

```
mc-launcher/   Electron launcher — main.js, src/, assets/ (build: npm install && npm run build)
docs/          The site (HTML/CSS/JS) — published to GitHub Pages from this folder
```

## Quick start (launcher)

```bash
cd mc-launcher
npm install
npm start        # run in dev mode
npm run build    # electron-builder → installers in dist/
```

Requires Node.js 18+ and Java 21+ to actually play Minecraft.

## Discord Rich Presence

The launcher shows your presence in Discord. The Client ID lives in `mc-launcher/src/discord-rpc.js` (or override it with the `VOID_DISCORD_APP_ID` environment variable). The launcher icon is registered as the art asset `void_logo` in the Discord developer portal.

## License

MIT — see `LICENSE`.