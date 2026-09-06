const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');

// Minimal ZIP reader: extracts a single entry from a jar.
// Needed because some NeoForge installer jars trip up adm-zip's strict names.
function readZipEntry(jarPath, entryName) {
    const buf = fs.readFileSync(jarPath);
    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error('Not a valid zip (no EOCD)');
    const totalEntries = buf.readUInt16LE(eocd + 10);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    let off = cdOffset;
    for (let i = 0; i < totalEntries; i++) {
        if (buf.readUInt32LE(off) !== 0x02014b50) break;
        const fnameLen = buf.readUInt16LE(off + 28);
        const extraLen = buf.readUInt16LE(off + 30);
        const commentLen = buf.readUInt16LE(off + 32);
        const lho = buf.readUInt32LE(off + 42);
        const fname = buf.slice(off + 46, off + 46 + fnameLen).toString('utf8');
        if (fname === entryName) {
            const compMethod = buf.readUInt16LE(off + 10);
            const compSize = buf.readUInt32LE(off + 20);
            const lNameLen = buf.readUInt16LE(lho + 26);
            const lExtraLen = buf.readUInt16LE(lho + 28);
            const dataStart = lho + 30 + lNameLen + lExtraLen;
            const data = buf.slice(dataStart, dataStart + compSize);
            if (compMethod === 0) return data;
            if (compMethod === 8) return zlib.inflateRawSync(data);
            throw new Error(`Unsupported zip method ${compMethod}`);
        }
        off += 46 + fnameLen + extraLen + commentLen;
    }
    throw new Error(`Zip entry not found: ${entryName}`);
}

// ═══════════════ LOGGING ═══════════════
const LOG_DIR = path.join(app.getPath('home'), '.voidclient', 'logs');
let logFile = null;

function initLog() {
    try {
        if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        logFile = path.join(LOG_DIR, `void-${ts}.log`);
    } catch {}
}
initLog();

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    try { if (logFile) fs.appendFileSync(logFile, line + '\n', 'utf8'); } catch {}
}
function logError(msg) { log(`[ERROR] ${msg}`); }
function logWarn(msg) { log(`[WARN] ${msg}`); }
log('=== VOID CLIENT STARTED ===');
log(`Electron ${process.versions.electron}, Node ${process.versions.node}, Chrome ${process.versions.chrome}`);

// ═══════════════ SETTINGS ═══════════════
const SETTINGS_PATH = path.join(app.getPath('home'), '.voidclient', 'settings.json');
function loadSettings() { try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch { return {}; } }
function saveSettings(s) { try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2), 'utf8'); } catch {} }

// ═══════════════ TELEMETRY (anonymous, one ping per day) ═══════════════
// Endpoint hosted on the primary site. Override with the VOID_TELEMETRY_URL env var.
const TELEMETRY_URL = process.env.VOID_TELEMETRY_URL || 'https://x95027pc.beget.tech/api/telemetry.php';

function getInstallId(settings) {
    if (settings.installId) return settings.installId;
    settings.installId = crypto.randomUUID();
    return settings.installId;
}

function telemetryPost(url, payload) {
    return new Promise((resolve) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.request(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'User-Agent': 'VoidClient/' + app.getVersion(),
            },
        }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.on('error', () => resolve(0));
        req.setTimeout(8000, () => { req.destroy(); resolve(0); });
        req.write(payload);
        req.end();
    });
}

async function postTelemetry() {
    try {
        const settings = loadSettings();
        if (settings.telemetryDisabled === true) { log('Telemetry disabled by settings'); return; }
        const today = new Date().toISOString().substring(0, 10);
        if (settings.lastTelemetry === today) { log('Telemetry already sent today'); return; }
        const payload = JSON.stringify({
            install_id: getInstallId(settings),
            version: app.getVersion(),
            platform: process.platform,
            arch: process.arch,
            date: today,
        });
        let code = await telemetryPost(TELEMETRY_URL, payload);
        if (code !== 200 && code !== 204) code = await telemetryPost(TELEMETRY_URL.replace(/^https:/, 'http:'), payload);
        if (code === 200 || code === 204) {
            settings.lastTelemetry = today;
            saveSettings(settings);
            log(`Telemetry ping sent (HTTP ${code})`);
        } else {
            logWarn(`Telemetry endpoint unreachable (HTTP ${code}) — will retry next launch`);
        }
    } catch (e) { logWarn(`Telemetry failed: ${e.message}`); }
}

// ═══════════════ DISCORD RICH PRESENCE ═══════════════
const discordRpc = require('./src/discord-rpc.js');
discordRpc.setLogger(log);

// ═══════════════ WINDOW ═══════════════
let mainWindow;

function createWindow() {
    log('Creating main window');
    mainWindow = new BrowserWindow({
        width: 1100, height: 700, minWidth: 900, minHeight: 600,
        frame: false, titleBarStyle: 'hidden', backgroundColor: '#000000',
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
    mainWindow.webContents.on('did-finish-load', () => log('Renderer loaded'));
    mainWindow.webContents.on('did-fail-load', (e, code, desc) => logError(`Renderer load failed: ${code} ${desc}`));
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http://') || url.startsWith('https://')) {
            shell.openExternal(url);
            return { action: 'deny' };
        }
        return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (e, url) => {
        if (url.startsWith('http://') || url.startsWith('https://')) {
            e.preventDefault();
            shell.openExternal(url);
        }
    });
}
app.whenReady().then(async () => {
    createWindow();
    await discordRpc.init();
    discordRpc.setMenu();
    setTimeout(checkForUpdates, 5000);
    setTimeout(postTelemetry, 3000);
});
app.on('window-all-closed', () => { log('All windows closed'); discordRpc.shutdown(); if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => discordRpc.shutdown());

ipcMain.on('window-minimize', () => mainWindow.minimize());
ipcMain.on('window-maximize', () => { mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); });
ipcMain.on('window-close', () => mainWindow.close());

// ═══════════════ IPC: FILE DIALOGS ═══════════════
ipcMain.handle('get-log-path', () => logFile);

ipcMain.handle('select-directory', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('open-game-folder', async (event, dir) => {
    try {
        if (dir && fs.existsSync(dir)) { shell.openPath(dir); return { ok: true }; }
        return { error: 'not found' };
    } catch (e) { return { error: String(e) }; }
});

// ── Installed versions ──────────────────────────────────────────────
const LOADER_MARKERS = [['-forge-', 'forge'], ['-neoforge-', 'neoforge'], ['-fabric-', 'fabric'], ['-quilt-', 'quilt']];
function classifyLoader(id) {
    for (const [mark, loader] of LOADER_MARKERS) if (id.includes(mark)) return loader;
    return 'vanilla';
}
function mcVersionOf(id, loader) {
    if (loader === 'vanilla') return id;
    const mark = LOADER_MARKERS.find(([m]) => id.includes(m));
    return mark ? id.split(mark[0])[0] : id;
}
function dirSizeSafe(p) {
    let s = 0;
    try {
        for (const e of fs.readdirSync(p, { withFileTypes: true })) {
            const fp = path.join(p, e.name);
            if (e.isDirectory()) s += dirSizeSafe(fp);
            else { try { s += fs.statSync(fp).size; } catch {} }
        }
    } catch {}
    return s;
}
function parseExtraJvmArgs(str) {
    if (!str || !String(str).trim()) return [];
    return (String(str).trim().match(/(?:[^\s"]+|"[^"]*")+/g) || [])
        .map(a => a.replace(/^"|"$/g, ''));
}

ipcMain.handle('list-installed-versions', async (event, { gameDir }) => {
    const versionsDir = path.join(gameDir, 'versions');
    if (!fs.existsSync(versionsDir)) return [];
    const out = [];
    for (const name of fs.readdirSync(versionsDir)) {
        const dir = path.join(versionsDir, name);
        try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
        const jsonPath = path.join(dir, `${name}.json`);
        if (!fs.existsSync(jsonPath)) continue;
        try { JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch { continue; }
        const loader = classifyLoader(name);
        out.push({
            id: name,
            loader,
            mcVersion: mcVersionOf(name, loader),
            size: dirSizeSafe(dir),
            hasClient: fs.existsSync(path.join(dir, `${name}.jar`))
        });
    }
    return out.sort((a, b) => b.mcVersion.localeCompare(a.mcVersion, undefined, { numeric: true }));
});

ipcMain.handle('delete-version', async (event, { gameDir, id }) => {
    try {
        const clean = String(id || '').replace(/[\\/]+/g, '');
        if (!clean || clean.includes('..')) return { error: 'Invalid version id' };
        const dir = path.join(gameDir, 'versions', clean);
        if (!fs.existsSync(dir)) return { error: 'Version not found' };
        fs.rmSync(dir, { recursive: true, force: true });
        return { ok: true };
    } catch (e) { return { error: String(e) }; }
});

ipcMain.handle('select-image', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['jpg','jpeg','png','gif','webp','bmp'] }]
    });
    return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('select-video', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [{ name: 'Videos', extensions: ['mp4','webm','ogg','mov','mkv'] }]
    });
    return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('select-java-exe', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [{ name: 'Java Executable', extensions: ['exe'] }]
    });
    return r.canceled ? null : r.filePaths[0];
});

// ═══════════════ HTTP ═══════════════
function httpGet(url, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
        if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, { headers: { 'User-Agent': 'VoidClient/2.4' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                let loc = res.headers.location;
                if (loc.startsWith('/')) loc = new URL(url).origin + loc;
                return httpGet(loc, maxRedirects - 1).then(resolve, reject);
            }
            if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(body); } });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

// ═══════════════ SELF-UPDATE CHECK ═══════════════
const UPDATE_MANIFEST_URL = process.env.VOID_UPDATE_MANIFEST || 'https://markipler609.github.io/VoidClient/version.json';
const UPDATE_DOWNLOAD_URL = 'https://github.com/Markipler609/VoidClient/releases';

function newerVersion(a, b) {
    const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const x = pa[i] || 0, y = pb[i] || 0;
        if (x > y) return true;
        if (x < y) return false;
    }
    return false;
}

function sha256File(p) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        fs.createReadStream(p).on('data', d => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
    });
}

function pickDownload(data) {
    if (!data || !data.downloads) return null;
    const dl = data.downloads;
    if (process.platform === 'win32') return dl.win_installer || dl.win_portable;
    if (process.platform === 'darwin') return dl.mac_arm64 || dl.mac_x64;
    return dl.linux;
}

function showNotices(data) {
    try {
        const notices = Array.isArray(data?.notices) ? data.notices : [];
        if (!notices.length) return;
        const settings = loadSettings();
        const seen = settings.seenNotices || {};
        let changed = false;
        for (const n of notices) {
            if (!n || !n.id || seen[n.id]) continue;
            seen[n.id] = true;
            changed = true;
            try {
                new Notification({ title: n.title || 'VOID CLIENT', body: n.body || 'Update available', silent: false }).show();
            } catch (e) { logWarn(`Notice notify failed: ${e.message}`); }
        }
        if (changed) { settings.seenNotices = seen; saveSettings(settings); }
    } catch (e) { logWarn(`showNotices failed: ${e.message}`); }
}

async function applyUpdate(data) {
    const target = pickDownload(data);
    if (!target || !target.url) { shell.openExternal(UPDATE_DOWNLOAD_URL); return; }
    const remote = String(data.version || '');
    try {
        const updDir = path.join(app.getPath('temp'), 'voidclient-update');
        if (!fs.existsSync(updDir)) fs.mkdirSync(updDir, { recursive: true });
        const fileName = (String(target.url).split('/').pop() || 'VOID_Client_Setup.exe').split('?')[0];
        const destPath = path.join(updDir, fileName + '.new');
        log(`Downloading update ${remote} → ${destPath}`);
        await downloadFile(target.url, destPath);
        const size = fs.statSync(destPath).size;
        if (target.sha256) {
            const h = await sha256File(destPath);
            if (h.toLowerCase() !== String(target.sha256).toLowerCase()) {
                logError(`Update checksum mismatch (got ${h})`);
                try { fs.unlinkSync(destPath); } catch {}
                const bad = await dialog.showMessageBox(mainWindow, {
                    type: 'error',
                    title: 'VOID CLIENT — update failed',
                    message: 'The downloaded update failed the SHA-256 check.',
                    detail: 'Grab the build manually from the releases page instead.',
                    buttons: ['Open releases', 'Close'],
                    defaultId: 0, cancelId: 1
                });
                if (bad.response === 0) shell.openExternal(UPDATE_DOWNLOAD_URL);
                return;
            }
            log(`Update checksum OK (${h})`);
        } else {
            log('Update manifest has no SHA-256, skipping verification');
        }
        const r = await dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'VOID CLIENT — update ready',
            message: `VOID CLIENT ${remote} is downloaded (${Math.round(size / 1048576)} MB).`,
            detail: process.platform === 'win32'
                ? 'The installer will replace your current copy silently.'
                : 'Opening the downloads page so you can finish the update.',
            buttons: process.platform === 'win32' ? ['Install now', 'Later'] : ['Open downloads', 'Later'],
            defaultId: 0,
            cancelId: 1
        });
        if (process.platform === 'win32' && r.response === 0) {
            log(`Launching silent installer: ${destPath} /S`);
            const child = spawn(destPath, ['/S'], { detached: true, stdio: 'ignore' });
            child.unref();
            setTimeout(() => app.quit(), 1500);
        } else {
            shell.openExternal(UPDATE_DOWNLOAD_URL);
        }
    } catch (e) {
        logError(`Update download failed: ${e.message}`);
    }
}

async function checkForUpdates() {
    try {
        log('Checking for updates...');
        const data = await httpGet(UPDATE_MANIFEST_URL);
        showNotices(data);
        const remote = String(data?.version || '').trim();
        const current = app.getVersion();
        if (!remote || remote === current) { log(`Update check: up to date (${current})`); return; }
        if (!newerVersion(remote, current)) { log(`Update check: current ${current} >= remote ${remote}`); return; }
        log(`Update available: ${remote} (running ${current})`);
        const r = await dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'VOID CLIENT — update available',
            message: `VOID CLIENT ${remote} is available.`,
            detail: `You're on ${current}. Install or download the new build.`,
            buttons: ['Update now', 'Open downloads', 'Later'],
            defaultId: 0,
            cancelId: 2
        });
        if (r.response === 0) await applyUpdate(data);
        else if (r.response === 1) shell.openExternal(UPDATE_DOWNLOAD_URL);
    } catch (e) {
        log(`Update check failed: ${e.message}`);
    }
}

// Launcher version badge (shown in the titlebar)
ipcMain.handle('get-version-info', async () => {
    const current = app.getVersion();
    let latest = null;
    try {
        const data = await httpGet(UPDATE_MANIFEST_URL);
        latest = String(data?.version || '').trim() || null;
    } catch { latest = null; }
    return {
        current,
        latest,
        updateAvailable: !!(latest && newerVersion(latest, current)),
    };
});

// ═══════════════ MC VERSION MANIFEST ═══════════════
let versionManifest = null;
ipcMain.handle('get-versions', async () => {
    try {
        log('Fetching version manifest...');
        versionManifest = await httpGet('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
        const count = versionManifest.versions?.length || 0;
        log(`Got ${count} versions`);
        return versionManifest.versions;
    } catch (e) {
        logError(`Version manifest fetch failed: ${e.message}`);
        return getFallbackVersions();
    }
});

async function ensureManifest() {
    if (versionManifest?.versions) return versionManifest;
    versionManifest = await httpGet('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
    return versionManifest;
}

async function getVersionJson(versionId) {
    const manifest = await ensureManifest();
    const entry = manifest.versions.find(v => v.id === versionId);
    if (!entry) throw new Error(`Version ${versionId} not found in manifest`);
    log(`Fetching version JSON for ${versionId}`);
    return await httpGet(entry.url);
}

// ═══════════════ JAVA DETECTION — DYNAMIC SCAN ═══════════════
function scanForJava() {
    log('Scanning for Java installations...');
    const home = app.getPath('home');
    const found = [];

    // Static known paths (priority)
    const staticPaths = [
        path.join(home, '.minecraft', 'runtime', 'java-runtime-gamma', 'windows-x64', 'java-runtime-gamma', 'bin', 'java.exe'),
        path.join(home, '.minecraft', 'runtime', 'java-runtime-beta', 'windows-x64', 'java-runtime-beta', 'bin', 'java.exe'),
        path.join(home, '.jdks', 'java-runtime-gamma', 'bin', 'java.exe'),
    ];
    for (const p of staticPaths) { if (fs.existsSync(p)) found.push(p); }

    // Scan Program Files directories dynamically
    const pf = [
        process.env['PROGRAMFILES'] || 'C:\\Program Files',
        process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)',
    ];
    const scanDirs = ['Java', 'Eclipse Adoptium', 'Microsoft', 'Amazon Corretto', 'Zulu', 'BellSoft', 'GraalVM', 'Semeru', 'Temurin'];
    for (const base of pf) {
        for (const dir of scanDirs) {
            const parent = path.join(base, dir);
            if (!fs.existsSync(parent)) continue;
            try {
                const entries = fs.readdirSync(parent);
                for (const entry of entries) {
                    const candidate = path.join(parent, entry, 'bin', 'java.exe');
                    if (fs.existsSync(candidate)) found.push(candidate);
                    // Also check jre subdirectory
                    const jreCandidate = path.join(parent, entry, 'jre', 'bin', 'java.exe');
                    if (fs.existsSync(jreCandidate)) found.push(jreCandidate);
                }
            } catch {}
        }
    }

    // PATH lookup
    try {
        const result = execSync('where java', { encoding: 'utf8', timeout: 5000 }).trim();
        for (const line of result.split(/\r?\n/)) {
            const p = line.trim();
            if (p && fs.existsSync(p) && !found.includes(p)) found.push(p);
        }
    } catch {}

    log(`Found ${found.length} Java candidates`);
    return found;
}

function getJavaVersion(javaPath) {
    try {
        const out = execSync(`"${javaPath}" -version 2>&1`, { encoding: 'utf8', timeout: 8000 });
        log(`Java version output (${javaPath}): ${out.split('\n')[0]}`);
        // Match: openjdk version "21.0.3" or java version "1.8.0_45" or java version "28"
        const m = out.match(/version\s+"(\d+)(?:\.(\d+))?/);
        if (m) {
            const major = parseInt(m[1]);
            if (major >= 10) return major; // 21, 28, etc
            if (major === 1 && m[2]) return parseInt(m[2]); // 1.8 -> 8
            return major;
        }
    } catch (e) { logError(`getJavaVersion failed for ${javaPath}: ${e.message}`); }
    return 0;
}

function getRequiredJava(mcVersion) {
    const parts = (mcVersion || '').split('.');
    const minor = parseInt(parts[1]) || 0;
    if (minor >= 21) return 21;
    if (minor >= 17) return 17;
    if (minor >= 16) return 16;
    return 8;
}

// Java detection cache: scanning spawns "java -version" per candidate, which is
// slow and noisy, so we memoize results and only rescan periodically.
let javaCache = { bestPath: null, bestVer: 0, at: 0 };
const JAVA_CACHE_TTL = 60 * 1000;

function findJava() {
    const now = Date.now();
    if (javaCache.bestPath && now - javaCache.at < JAVA_CACHE_TTL) return javaCache.bestPath;

    log('Scanning for Java installations...');
    const candidates = scanForJava();
    if (candidates.length === 0) { logWarn('No Java found'); return null; }

    // Score each candidate: prefer highest version
    let bestPath = candidates[0];
    let bestVer = 0;
    for (const p of candidates) {
        const ver = getJavaVersion(p);
        log(`  ${p} -> Java ${ver}`);
        if (ver > bestVer) { bestVer = ver; bestPath = p; }
    }
    log(`Best Java: ${bestPath} (Java ${bestVer})`);
    javaCache = { bestPath, bestVer, at: now };
    return bestPath;
}

// Invalidate the cache (e.g. after the user manually picks a different Java)
function invalidateJavaCache() { javaCache = { bestPath: null, bestVer: 0, at: 0 }; }

ipcMain.handle('find-java', async () => findJava());

ipcMain.handle('check-java-version', async (event, jp) => {
    const p = jp || findJava();
    if (!p) return { path: null, version: 0, valid: false };
    const ver = getJavaVersion(p);
    return { path: p, version: ver, valid: ver > 0 };
});

// ═══════════════ MICROSOFT ACCOUNT AUTH ═══════════════
const { app: _app } = require('electron');
const msAuth = require(path.join(__dirname, 'src', 'microsoft-auth.js'));

// Route all game launches into the user's chosen gameDir vault location
ipcMain.handle('msa-configure', async (event, { gameDir }) => {
    if (gameDir) msAuth.setVaultDir(gameDir);
    return { ok: true };
});

// Does NOT expose tokens or sensitive data — only UI-safe info
ipcMain.handle('msa-status', async () => {
    if (!msAuth.isConfigured()) return { configured: false, signedIn: false, error: 'MICROSOFT_CLIENT_ID is not set in src/microsoft-auth.js' };
    const acc = msAuth.loadStoredAccount();
    if (!acc) return { configured: true, signedIn: false };
    return {
        configured: true, signedIn: true,
        username: acc.username, uuid: acc.uuid,
        hasValidToken: !!(acc.mcToken && acc.refreshToken),
        obtainedAt: acc.obtainedAt,
    };
});

ipcMain.handle('msa-login-start', async () => {
    if (!msAuth.isConfigured()) return { error: 'MICROSOFT_CLIENT_ID is not set in src/microsoft-auth.js' };
    try {
        const d = await msAuth.requestDeviceCode();
        if (d.error) return { error: d.errorDescription || d.error };
        return {
            deviceCode: d.deviceCode,
            userCode: d.userCode,
            verificationUri: d.verificationUri,
            interval: Math.max(d.interval || 5, 3),
            expiresIn: d.expiresIn,
            message: d.message,
        };
    } catch (e) { return { error: e.message }; }
});

ipcMain.handle('msa-login-poll', async (event, deviceCode) => {
    if (!deviceCode) return { error: 'No device code' };
    try {
        const r = await msAuth.pollForToken(deviceCode);
        if (r.error === 'authorization_pending') return { pending: true };
        if (r.error === 'slow_down') return { pending: true, slow: true };
        if (r.error) return { error: r.errorDescription || r.error };
        if (r.error === 'expired_token' || r.error === 'denied' || r.error === 'authorization_declined' || r.error === 'bad_verification_code') {
            return { error: r.errorDescription || r.error };
        }
        // Raced ahead of poll token server being ready: give the login chain a beat
        await new Promise(r2 => setTimeout(r2, 500));
        const account = await msAuth.finalizeLogin(deviceCode, r);
        return { success: true, username: account.username, uuid: account.uuid };
    } catch (e) { return { error: e.message }; }
});

ipcMain.handle('msa-logout', async () => {
    msAuth.removeAccount();
    return { ok: true };
});

// ═══════════════ FABRIC / FORGE / etc ═══════════════
let loaderGameVersionsCache = null;
ipcMain.handle('get-loader-game-versions', async () => {
    if (loaderGameVersionsCache) return loaderGameVersionsCache;
    const out = { forge: [], fabric: [], neoforge: [], quilt: [] };
    try {
        const fabric = await httpGet('https://meta.fabricmc.net/v2/versions/game');
        out.fabric = (Array.isArray(fabric) ? fabric : []).map(v => v.version).filter(Boolean);
    } catch {}
    try {
        const quilt = await httpGet('https://meta.quiltmc.org/v3/versions/game');
        out.quilt = (Array.isArray(quilt) ? quilt : []).map(v => v.version).filter(Boolean);
    } catch {}
    try {
        const forge = await httpGet('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
        const keys = Object.keys(forge.promos || {});
        out.forge = [...new Set(keys.map(k => k.replace(/-(latest|recommended)$/, ''))
            .filter(k => /^\d+(\.\d+)*$/.test(k) && k !== 'latest' && k !== 'recommended'))];
    } catch {}
    try {
        const metaXml = await httpGet('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml');
        const vs = typeof metaXml === 'string' ? [...metaXml.matchAll(/<version>([^<]+)<\/version>/g)].map(m => m[1]) : [];
        out.neoforge = [...new Set(vs.map(v => {
            v = String(v).replace(/-[a-z]+$/i, '');
            const m = v.match(/^(\d+)\.(\d+)/);
            if (!m) return null;
            const a = parseInt(m[1]), b = parseInt(m[2]);
            if (a === 20 || a === 21) return b === 0 ? '1.' + a : '1.' + a + '.' + b;
            if (a >= 22) return a + '.' + b;
            return null;
        }).filter(Boolean))];
    } catch {}
    log(`Loader game versions: forge=${out.forge.length} fabric=${out.fabric.length} neoforge=${out.neoforge.length} quilt=${out.quilt.length}`);
    loaderGameVersionsCache = out;
    return out;
});

ipcMain.handle('get-fabric-versions', async (event, mcVersion) => {
    try {
        const data = await httpGet(`https://meta.fabricmc.net/v2/versions/loader/${mcVersion}`);
        return Array.isArray(data) ? data.map(v => ({ id: v.loader.version, stable: v.loader.stable })) : [];
    } catch { return []; }
});

ipcMain.handle('get-loader-versions', async (event, loader) => {
    try {
        if (loader === 'forge') {
            const d = await httpGet('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
            return d.promos ? Object.entries(d.promos).map(([k, v]) => ({ id: v, label: k })) : [];
        }
        if (loader === 'neoforge') {
            const d = await httpGet('https://api.neoforged.net/v2/versions');
            return Array.isArray(d) ? d.slice(0, 80).map(v => ({ id: v.version || String(v), label: v.version || String(v) })) : [];
        }
        if (loader === 'quilt') {
            const d = await httpGet('https://meta.quiltmc.org/v3/versions/loader');
            return Array.isArray(d) ? d.slice(0, 40).map(v => ({ id: v.version, label: v.version })) : [];
        }
        return [];
    } catch { return []; }
});

// ═══════════════ FABRIC INSTALL ═══════════════
async function installFabricLoader(mcVersion, gameDir) {
    log(`Installing Fabric loader for MC ${mcVersion}`);
    const versionsDir = path.join(gameDir, 'versions');
    const fabricVersionId = `fabric-loader-${mcVersion}`;

    // Check if already installed
    const existingJson = path.join(versionsDir, fabricVersionId, `${fabricVersionId}.json`);
    if (fs.existsSync(existingJson)) {
        log(`Fabric already installed for ${mcVersion}`);
        return { versionId: fabricVersionId };
    }

    // 1) Get latest loader version for this MC version
    const loaders = await httpGet(`https://meta.fabricmc.net/v2/versions/loader/${mcVersion}`);
    if (!Array.isArray(loaders) || !loaders.length) throw new Error(`No Fabric loader for MC ${mcVersion}`);
    const latestLoader = loaders[0];
    const loaderVersion = latestLoader.loader.version;
    log(`Fabric loader version: ${loaderVersion}`);

    // 2) Get the profile JSON from Fabric meta
    const profileUrl = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${loaderVersion}/profile/json`;
    const fabricProfile = await httpGet(profileUrl);
    if (!fabricProfile || !fabricProfile.id) throw new Error('Invalid Fabric profile response');
    log(`Fabric profile id: ${fabricProfile.id}`);

    // 3) Make sure we have the vanilla MC version JSON
    const vanillaVersionJson = await getVersionJson(mcVersion);
    const vanillaVersionDir = path.join(versionsDir, mcVersion);
    if (!fs.existsSync(vanillaVersionDir)) fs.mkdirSync(vanillaVersionDir, { recursive: true });
    fs.writeFileSync(path.join(vanillaVersionDir, `${mcVersion}.json`), JSON.stringify(vanillaVersionJson, null, 2));

    // 4) Build the merged Fabric version JSON
    const fabricDir = path.join(versionsDir, fabricVersionId);
    if (!fs.existsSync(fabricDir)) fs.mkdirSync(fabricDir, { recursive: true });

    const fabricVersionJson = {
        id: fabricVersionId,
        inheritsFrom: mcVersion,
        mainClass: (typeof fabricProfile.mainClass === 'object' && fabricProfile.mainClass.client) ? fabricProfile.mainClass.client : (fabricProfile.mainClass || 'net.fabricmc.loader.impl.launch.knot.KnotClient'),
        arguments: fabricProfile.arguments || {},
        libraries: (fabricProfile.libraries || []).map(lib => ({
            name: lib.name,
            url: lib.url || 'https://maven.fabricmc.net/',
            // Fabric libs use maven.fabricmc.net as default repo
        })),
        releaseTime: new Date().toISOString(),
        type: 'release',
    };

    // If fabricProfile has a custom mainClass.client, use it
    if (fabricProfile.arguments?.game) {
        fabricVersionJson.arguments = { game: fabricProfile.arguments.game, jvm: fabricProfile.arguments.jvm || [] };
    }

    fs.writeFileSync(path.join(fabricDir, `${fabricVersionId}.json`), JSON.stringify(fabricVersionJson, null, 2));
    log(`Fabric version JSON written: ${path.join(fabricDir, `${fabricVersionId}.json`)}`);

    // 5) Download all Fabric libraries
    const libsDir = path.join(gameDir, 'libraries');
    if (!fs.existsSync(libsDir)) fs.mkdirSync(libsDir, { recursive: true });

    const allLibs = fabricVersionJson.libraries || [];
    let downloaded = 0, skipped = 0;
    const libTasks = [];
    for (const lib of allLibs) {
        const libPath = path.join(libsDir, nameToPath(lib.name));
        if (fs.existsSync(libPath)) { skipped++; continue; }
        const repoUrl = lib.url || 'https://maven.fabricmc.net/';
        const fullUrl = repoUrl + nameToPath(lib.name);
        libTasks.push(async () => {
            try {
                await downloadFile(fullUrl, libPath);
                downloaded++;
            } catch (e) { logWarn(`Fabric lib failed: ${lib.name} — ${e.message}`); }
        });
    }
    if (libTasks.length > 0) {
        log(`Downloading ${libTasks.length} Fabric libraries...`);
        await downloadBatch(libTasks, 8);
    }
    log(`Fabric libs: ${downloaded} downloaded, ${skipped} cached`);

    return { versionId: fabricVersionId };
}

// ═══════════════ QUILT INSTALL ═══════════════
async function installQuiltLoader(mcVersion, gameDir) {
    log(`Installing Quilt loader for MC ${mcVersion}`);
    const versionsDir = path.join(gameDir, 'versions');
    const quiltVersionId = `quilt-loader-${mcVersion}`;

    const existingJson = path.join(versionsDir, quiltVersionId, `${quiltVersionId}.json`);
    if (fs.existsSync(existingJson)) {
        log(`Quilt already installed for ${mcVersion}`);
        return { versionId: quiltVersionId };
    }

    // 1) Get latest Quilt loader for this MC version
    const loaders = await httpGet(`https://meta.quiltmc.org/v3/versions/loader/${mcVersion}`);
    if (!Array.isArray(loaders) || !loaders.length) throw new Error(`No Quilt loader for MC ${mcVersion}`);
    const entry = loaders[0];
    const loaderVersion = entry.loader.version;
    const launcherMeta = entry.launcherMeta || {};
    log(`Quilt loader version: ${loaderVersion}`);

    // 2) Make sure we have the vanilla MC version JSON
    const vanillaVersionJson = await getVersionJson(mcVersion);
    const vanillaVersionDir = path.join(versionsDir, mcVersion);
    if (!fs.existsSync(vanillaVersionDir)) fs.mkdirSync(vanillaVersionDir, { recursive: true });
    fs.writeFileSync(path.join(vanillaVersionDir, `${mcVersion}.json`), JSON.stringify(vanillaVersionJson, null, 2));

    // 3) Build the quilt version JSON (inheritsFrom pattern, like Fabric)
    const quiltDir = path.join(versionsDir, quiltVersionId);
    if (!fs.existsSync(quiltDir)) fs.mkdirSync(quiltDir, { recursive: true });

    const mainClass = (launcherMeta.mainClass && launcherMeta.mainClass.client)
        ? launcherMeta.mainClass.client
        : 'org.quiltmc.loader.impl.launch.knot.KnotClient';
    const commonLibs = launcherMeta.libraries?.common || [];
    const clientLibs = launcherMeta.libraries?.client || [];

    // launcherMeta.libraries omits the quilt-loader jar itself and the
    // runtime mappings jar (hashed for modern MC, intermediary for older).
    // Both must be on the classpath or KnotClient can't be found.
    let mappingsLib = null;
    try {
        const hashed = await httpGet(`https://meta.quiltmc.org/v3/versions/hashed/${mcVersion}`);
        if (Array.isArray(hashed) && hashed.length && hashed[0].maven) {
            mappingsLib = { name: hashed[0].maven, url: 'https://maven.quiltmc.org/repository/release/' };
        }
    } catch {}
    if (!mappingsLib) {
        mappingsLib = { name: `net.fabricmc:intermediary:${mcVersion}`, url: 'https://maven.fabricmc.net/' };
    }
    const loaderLib = { name: entry.loader.maven, url: 'https://maven.quiltmc.org/repository/release/' };

    const quiltVersionJson = {
        id: quiltVersionId,
        inheritsFrom: mcVersion,
        time: new Date().toISOString(),
        releaseTime: new Date().toISOString(),
        type: 'release',
        mainClass,
        arguments: { game: [], jvm: [] },
        libraries: [loaderLib, mappingsLib, ...commonLibs, ...clientLibs].map(lib => ({
            name: lib.name,
            url: lib.url || 'https://maven.quiltmc.org/',
        })),
    };
    fs.writeFileSync(path.join(quiltDir, `${quiltVersionId}.json`), JSON.stringify(quiltVersionJson, null, 2));
    log(`Quilt version JSON written: ${path.join(quiltDir, `${quiltVersionId}.json`)}`);

    // 4) Download Quilt libraries
    const libsDir = path.join(gameDir, 'libraries');
    if (!fs.existsSync(libsDir)) fs.mkdirSync(libsDir, { recursive: true });

    const allLibs = quiltVersionJson.libraries || [];
    let downloaded = 0, skipped = 0;
    const libTasks = [];
    for (const lib of allLibs) {
        const libPath = path.join(libsDir, nameToPath(lib.name));
        if (fs.existsSync(libPath)) { skipped++; continue; }
        const repoUrl = lib.url || 'https://maven.fabricmc.net/';
        const fullUrl = repoUrl + nameToPath(lib.name);
        libTasks.push(async () => {
            try { await downloadFile(fullUrl, libPath); downloaded++; }
            catch (e) { logWarn(`Quilt lib failed: ${lib.name} — ${e.message}`); }
        });
    }
    if (libTasks.length > 0) {
        log(`Downloading ${libTasks.length} Quilt libraries...`);
        await downloadBatch(libTasks, 8);
    }
    log(`Quilt libs: ${downloaded} downloaded, ${skipped} cached`);

    return { versionId: quiltVersionId };
}

// ═══════════════ NEOFORGE INSTALL ═══════════════
async function installNeoForgeLoader(mcVersion, gameDir) {
    log(`Installing NeoForge for MC ${mcVersion}`);
    const versionsDir = path.join(gameDir, 'versions');
    const id = `neoforge-${mcVersion}`;

    const existingJson = path.join(versionsDir, id, `${id}.json`);
    if (fs.existsSync(existingJson)) {
        log(`NeoForge already installed for ${mcVersion}`);
        return { versionId: id };
    }

    // Find the newest NeoForge build for this MC version via maven metadata.
    // NeoForge versions look like 21.4.157 (MC 1.21.4) or 20.1.x (MC 1.20.1).
    const metaXml = await httpGet('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml');
    const versions = [...metaXml.matchAll(/<version>([^<]+)<\/version>/g)].map(m => m[1]).reverse();
    if (!versions.length) throw new Error('Could not fetch NeoForge versions');

    const [maj, mcMinor, mcPatch] = mcVersion.split('.');
    let prefix;
    if (mcVersion === '1.21.5') prefix = '26.0.'; // MC 1.21.5 jumped to NeoForge 26.x
    else prefix = `${mcMinor}.${mcPatch || '0'}.`;
    const stable = versions.filter(v => v.startsWith(prefix) && !/beta|alpha|snapshot/.test(v));
    const pool = stable.length ? stable : versions.filter(v => v.startsWith(prefix));
    if (!pool.length) throw new Error(`No NeoForge build found for MC ${mcVersion}`);
    const nfVersion = pool[0];
    log(`NeoForge version: ${nfVersion}`);

    // Download the NeoForge installer jar and read version.json from inside it
    const nfUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${nfVersion}/neoforge-${nfVersion}-installer.jar`;
    const tmpInstaller = path.join(gameDir, 'temp-neoforge-installer.jar');
    try { await downloadFile(nfUrl, tmpInstaller); }
    catch (e) { throw new Error(`Failed to download NeoForge installer: ${e.message}`); }

    let neoVersionJson;
    try {
        const raw = readZipEntry(tmpInstaller, 'version.json');
        neoVersionJson = JSON.parse(raw.toString('utf8'));
    } catch (e) {
        try { fs.unlinkSync(tmpInstaller); } catch {}
        throw new Error(`Failed to parse NeoForge installer: ${e.message}`);
    }
    try { fs.unlinkSync(tmpInstaller); } catch {}

    // Write the NeoForge version JSON (renamed to our id)
    neoVersionJson.id = id;
    const nfDir = path.join(versionsDir, id);
    if (!fs.existsSync(nfDir)) fs.mkdirSync(nfDir, { recursive: true });
    fs.writeFileSync(path.join(nfDir, `${id}.json`), JSON.stringify(neoVersionJson, null, 2));
    log(`NeoForge version JSON written: ${path.join(nfDir, `${id}.json`)}`);

    // Download NeoForge libraries (they carry absolute URLs in downloads.artifact)
    const libsDir = path.join(gameDir, 'libraries');
    const allLibs = neoVersionJson.libraries || [];
    const libTasks = [];
    let downloaded = 0, skipped = 0;
    for (const lib of allLibs) {
        let libUrl = null, relPath = null;
        if (lib.downloads?.artifact) {
            libUrl = lib.downloads.artifact.url;
            relPath = lib.downloads.artifact.path;
        } else if (lib.name) {
            libUrl = (lib.url || 'https://maven.neoforged.net/releases/') + nameToPath(lib.name);
            relPath = nameToPath(lib.name);
        }
        if (!libUrl || !relPath) continue;
        const libPath = path.join(libsDir, relPath);
        if (fs.existsSync(libPath)) { skipped++; continue; }
        libTasks.push(async () => {
            try { await downloadFile(libUrl, libPath); downloaded++; }
            catch (e) { logWarn(`NeoForge lib failed: ${lib.name} — ${e.message}`); }
        });
    }
    if (libTasks.length > 0) {
        log(`Downloading ${libTasks.length} NeoForge libraries...`);
        await downloadBatch(libTasks, 8);
    }
    log(`NeoForge libs: ${downloaded} downloaded, ${skipped} cached`);

    return { versionId: id };
}

// ═══════════════ FORGE INSTALL ═══════════════
async function installForgeLoader(mcVersion, gameDir) {
    log(`Installing Forge for MC ${mcVersion}`);
    const versionsDir = path.join(gameDir, 'versions');
    const forgeVersionId = `forge-${mcVersion}`;

    const existingJson = path.join(versionsDir, forgeVersionId, `${forgeVersionId}.json`);
    if (fs.existsSync(existingJson)) {
        log(`Forge already installed for ${mcVersion}`);
        return { versionId: forgeVersionId };
    }

    // Fetch Forge installer info
    const promoData = await httpGet('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
    // Find the recommended version for this MC version
    let forgeVersion = null;
    if (promoData?.promos) {
        const key = `${mcVersion}-latest`;
        const keyRec = `${mcVersion}-recommended`;
        forgeVersion = promoData.promos[keyRec] || promoData.promos[key];
    }
    if (!forgeVersion) throw new Error(`No Forge version found for MC ${mcVersion}`);
    log(`Forge version: ${forgeVersion}`);

    // Download the Forge installer jar
    const forgeFullVersion = `${mcVersion}-${forgeVersion}`;
    const installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${forgeFullVersion}/forge-${forgeFullVersion}-installer.jar`;
    const tmpInstaller = path.join(gameDir, 'temp-forge-installer.jar');
    try {
        await downloadFile(installerUrl, tmpInstaller);
    } catch (e) {
        throw new Error(`Failed to download Forge installer: ${e.message}`);
    }

    // Forge (53+, "slim") builds the patched ?:client? jar locally via a
    // binary-patch chain that is not downloadable. Run the installer itself;
    // it downloads all libraries, produces the patched client jar, and
    // writes a version JSON under versions/<mc>-forge-<forgeVersion>/.
    try {
        const javaPath = findJava();
        if (!javaPath) throw new Error('Java not found for Forge installer');

        // The installer requires a launcher_profiles.json to exist
        const profilesPath = path.join(gameDir, 'launcher_profiles.json');
        if (!fs.existsSync(profilesPath)) {
            fs.writeFileSync(profilesPath, '{"profiles":{},"selectedProfile":"(Default)","clientToken":"void","authenticationDatabase":{},"launcherVersion":{}}', 'utf8');
        }

        log(`Running Forge installer: "${javaPath}" -jar ${tmpInstaller} --installClient ${gameDir}`);
        const code = await runProcess(javaPath, ['-jar', tmpInstaller, '--installClient', gameDir], (out) => {
            if (out.trim()) log(`Forge installer: ${out.trim().substring(0, 200)}`);
        });
        if (code !== 0) throw new Error(`Forge installer exited with code ${code}`);
    } finally {
        try { fs.unlinkSync(tmpInstaller); } catch {}
    }

    // The installer writes the version JSON under the installed id
    // (e.g. 1.21.4-forge-54.1.14). Adopt it under our forge-<mc> convention.
    const installedId = `${mcVersion}-forge-${forgeVersion}`;
    const installedDir = path.join(versionsDir, installedId);
    const installedJson = path.join(installedDir, `${installedId}.json`);
    if (!fs.existsSync(installedJson)) throw new Error('Could not locate installed Forge version JSON');

    // Ensure the parent vanilla version JSON exists for launch (the installer
    // only drops the client jar, and our launch resolves inheritsFrom).
    const parentJson = path.join(versionsDir, mcVersion, `${mcVersion}.json`);
    if (!fs.existsSync(parentJson)) {
        try {
            const vj = await getVersionJson(mcVersion);
            const pdir = path.join(versionsDir, mcVersion);
            if (!fs.existsSync(pdir)) fs.mkdirSync(pdir, { recursive: true });
            fs.writeFileSync(parentJson, JSON.stringify(vj, null, 2));
        } catch (e) { logWarn(`Could not fetch parent version JSON after Forge install: ${e.message}`); }
    }

    let forgeVersionJson;
    try { forgeVersionJson = JSON.parse(fs.readFileSync(installedJson, 'utf8')); }
    catch { throw new Error('Could not parse installed Forge version JSON'); }
    forgeVersionJson.id = forgeVersionId;

    // Write the version JSON under our id
    const forgeDir = path.join(versionsDir, forgeVersionId);
    if (!fs.existsSync(forgeDir)) fs.mkdirSync(forgeDir, { recursive: true });
    fs.writeFileSync(path.join(forgeDir, `${forgeVersionId}.json`), JSON.stringify(forgeVersionJson, null, 2));

    return { versionId: forgeVersionId };
}

ipcMain.handle('install-loader', async (event, { loader, mcVersion, gameDir }) => {
    try {
        discordRpc.setInstalling(`Installing ${loader} for ${mcVersion}`);
        if (loader === 'fabric') return await installFabricLoader(mcVersion, gameDir);
        if (loader === 'forge') return await installForgeLoader(mcVersion, gameDir);
        if (loader === 'quilt') return await installQuiltLoader(mcVersion, gameDir);
        if (loader === 'neoforge') return await installNeoForgeLoader(mcVersion, gameDir);
        return { versionId: `${mcVersion}` };
    } catch (e) {
        logError(`Loader install failed: ${e.message}`);
        return { error: e.message };
    } finally {
        discordRpc.setMenu();
    }
});

// ═══════════════ MOD MANAGEMENT ═══════════════
ipcMain.handle('list-installed-mods', async (event, { gameDir }) => {
    const modsDir = path.join(gameDir, 'mods');
    if (!fs.existsSync(modsDir)) return [];
    try {
        return fs.readdirSync(modsDir)
            .filter(f => f.endsWith('.jar'))
            .map(f => {
                const stat = fs.statSync(path.join(modsDir, f));
                return { filename: f, size: stat.size, modified: stat.mtime };
            });
    } catch { return []; }
});

ipcMain.handle('delete-mod', async (event, { gameDir, filename }) => {
    try {
        const modPath = path.join(gameDir, 'mods', filename);
        if (fs.existsSync(modPath)) { fs.unlinkSync(modPath); return { success: true }; }
        return { success: false, error: 'File not found' };
    } catch (e) { return { success: false, error: e.message }; }
});

// ═══════════════ DOWNLOAD ENGINE ═══════════════
function downloadFile(url, destPath, onProgress) {
    return new Promise((resolve, reject) => {
        const dir = path.dirname(destPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const doRequest = (reqUrl, rl = 10) => {
            if (rl <= 0) return reject(new Error('Too many redirects'));
            const mod = reqUrl.startsWith('https') ? https : http;
            mod.get(reqUrl, { headers: { 'User-Agent': 'VoidClient/2.4' } }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    let loc = res.headers.location;
                    if (loc.startsWith('/')) loc = new URL(reqUrl).origin + loc;
                    return doRequest(loc, rl - 1);
                }
                if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
                const total = parseInt(res.headers['content-length'] || '0', 10);
                let downloaded = 0;
                const file = fs.createWriteStream(destPath);
                res.on('data', chunk => { downloaded += chunk.length; if (onProgress) onProgress(downloaded, total); });
                res.pipe(file);
                file.on('finish', () => file.close(resolve));
                file.on('error', err => { try { fs.unlinkSync(destPath); } catch {} reject(err); });
            }).on('error', reject);
        };
        doRequest(url);
    });
}

function sha1(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha1');
        fs.createReadStream(filePath).on('data', d => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
    });
}

// Parallel batch download helper
async function downloadBatch(items, concurrency = 8) {
    let idx = 0;
    async function worker() {
        while (idx < items.length) {
            const i = idx++;
            await items[i]();
        }
    }
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
    await Promise.all(workers);
}

// Run a child process, streaming output to onLine, resolving with exit code
function runProcess(cmd, args, onLine) {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        const handle = (chunk) => {
            stdout += chunk.toString();
            const lines = stdout.split('\n');
            stdout = lines.pop();
            for (const l of lines) { try { onLine?.(l); } catch {} }
        };
        child.stdout.on('data', handle);
        child.stderr.on('data', handle);
        child.on('error', (err) => { resolve(-1); });
        child.on('close', (code) => {
            if (stdout.trim()) { try { onLine?.(stdout); } catch {} }
            resolve(code);
        });
    });
}

// ═══════════════ DOWNLOAD MC ═══════════════
ipcMain.handle('download-minecraft', async (event, { version, gameDir }) => {
    log(`=== DOWNLOAD START: ${version} → ${gameDir} ===`);
    discordRpc.setInstalling(`Installing Minecraft ${version}`);
    const send = (msg) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('download-progress', msg); };

    try {
        send({ text: `Fetching version ${version}...`, progress: 2 });
        const vjsonData = await getVersionJson(version);

        const clientJarUrl = vjsonData.downloads?.client?.url;
        if (!clientJarUrl) throw new Error(`No client jar URL for ${version}`);

        const versionsDir = path.join(gameDir, 'versions', version);
        const librariesDir = path.join(gameDir, 'libraries');
        const assetsDir = path.join(gameDir, 'assets');
        const nativesDir = path.join(versionsDir, 'natives');
        [versionsDir, librariesDir, path.join(assetsDir, 'indexes'), path.join(assetsDir, 'objects'), nativesDir]
            .forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

        // Client jar (with SHA1 integrity verification)
        const clientJarPath = path.join(versionsDir, `${version}.jar`);
        const clientSha1 = vjsonData.downloads?.client?.sha1;
        const verifyClient = async () => {
            if (!fs.existsSync(clientJarPath)) return false;
            if (!clientSha1) return true; // no known hash → assume ok
            const hash = await sha1(clientJarPath);
            if (hash === clientSha1) return true;
            logWarn(`Client jar SHA1 mismatch, re-downloading ${version}`);
            try { fs.unlinkSync(clientJarPath); } catch {}
            return false;
        };
        if (!(await verifyClient())) {
            send({ text: 'Downloading client...', progress: 8 });
            log(`Downloading client jar`);
            await downloadFile(clientJarUrl, clientJarPath, (dl, total) => {
                if (total > 0) send({ text: `Client: ${formatBytes(dl)}/${formatBytes(total)}`, progress: 8 + Math.round(dl / total * 12) });
            });
            // One verification pass after download
            if (clientSha1) {
                const hash = await sha1(clientJarPath);
                if (hash !== clientSha1) throw new Error('Client jar failed SHA1 verification');
            }
        } else {
            log('Client jar already exists, skipping');
        }
        fs.writeFileSync(path.join(versionsDir, `${version}.json`), JSON.stringify(vjsonData, null, 2));

        // Libraries — parallel
        const libraries = vjsonData.libraries || [];
        const totalLibs = libraries.length || 1;
        let libsSkipped = 0, libsDownloaded = 0;
        const libTasks = [];
        for (const lib of libraries) {
            if (!lib.downloads?.artifact) continue;
            const art = lib.downloads.artifact;
            const libPath = path.join(librariesDir, art.path);
            if (fs.existsSync(libPath)) {
                if (art.sha1) {
                    try {
                        const hash = await sha1(libPath);
                        if (hash === art.sha1) { libsSkipped++; continue; }
                        fs.unlinkSync(libPath);
                    } catch {}
                } else { libsSkipped++; continue; }
            }
            libTasks.push(async () => {
                try {
                    libsDownloaded++;
                    await downloadFile(art.url, libPath);
                    if (art.sha1) {
                        const hash = await sha1(libPath);
                        if (hash !== art.sha1) { fs.unlinkSync(libPath); await downloadFile(art.url, libPath); }
                    }
                } catch (e) { logWarn(`Lib failed: ${art.path} — ${e.message}`); }
            });
        }
        if (libTasks.length > 0) {
            send({ text: `Downloading ${libTasks.length} libraries (8x parallel)...`, progress: 20 });
            await downloadBatch(libTasks, 8);
        }
        log(`Libraries: ${libsDownloaded} downloaded, ${libsSkipped} cached`);
        send({ text: `Libraries: ${libsDownloaded} downloaded, ${libsSkipped} cached`, progress: 55 });

        // Assets — parallel
        const assetIndex = vjsonData.assetIndex;
        if (assetIndex) {
            const indexPath = path.join(assetsDir, 'indexes', `${assetIndex.id}.json`);
            if (!fs.existsSync(indexPath)) {
                send({ text: 'Asset index...', progress: 56 });
                await downloadFile(assetIndex.url, indexPath);
            }
            let indexData;
            try { indexData = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch { indexData = null; }
            if (indexData?.objects) {
                const objects = Object.entries(indexData.objects);
                const totalAssets = objects.length || 1;
                let skipped = 0, downloaded = 0;
                const assetTasks = [];
                for (const [name, obj] of objects) {
                    const hash = obj.hash;
                    const sub = hash.substring(0, 2);
                    const objPath = path.join(assetsDir, 'objects', sub, hash);
                    if (fs.existsSync(objPath)) { skipped++; continue; }
                    assetTasks.push(async () => {
                        try {
                            await downloadFile(`https://resources.download.minecraft.net/${sub}/${hash}`, objPath);
                            downloaded++;
                        } catch {}
                    });
                }
                if (assetTasks.length > 0) {
                    send({ text: `Downloading ${assetTasks.length} assets (8x parallel)...`, progress: 56 });
                    // Progress updater
                    const progressInterval = setInterval(() => {
                        send({ text: `Assets: ${downloaded + skipped}/${totalAssets} (${skipped} cached, ${downloaded} new)`, progress: 56 + Math.round((downloaded + skipped) / totalAssets * 28) });
                    }, 500);
                    await downloadBatch(assetTasks, 8);
                    clearInterval(progressInterval);
                    send({ text: `Assets done: ${skipped} cached, ${downloaded} downloaded`, progress: 84 });
                }
                log(`Assets done: ${skipped} cached, ${downloaded} downloaded`);
            }
        }

        // Natives
        if (process.platform === 'win32') {
            for (const lib of (vjsonData.libraries || []).filter(l => l.natives?.windows && l.downloads?.classifiers)) {
                const classifier = lib.natives.windows.replace('${arch}', '64');
                const dl = lib.downloads.classifiers[classifier];
                if (!dl) continue;
                const np = path.join(nativesDir, `${lib.name}-${classifier}.jar`);
                if (fs.existsSync(np)) continue;
                send({ text: `Natives: ${lib.name}`, progress: 85 });
                try { await downloadFile(dl.url, np); } catch {}
            }
            // Extract native DLLs from the natives jars
            try {
                const AdmZip = require('adm-zip');
                let extracted = 0;
                for (const f of fs.readdirSync(nativesDir).filter(f => f.endsWith('.jar'))) {
                    try {
                        const zip = new AdmZip(path.join(nativesDir, f));
                        for (const entry of zip.getEntries()) {
                            const name = entry.entryName.replace(/\\/g, '/');
                            if (!entry.isDirectory && /\.(dll|so|dylib)/i.test(name)) {
                                const outPath = path.join(nativesDir, name.split('/').pop());
                                if (!fs.existsSync(outPath)) {
                                    fs.writeFileSync(outPath, entry.getData());
                                    extracted++;
                                }
                            }
                        }
                    } catch {}
                }
                if (extracted > 0) log(`Extracted ${extracted} native files to ${nativesDir}`);
            } catch (e) { logWarn(`Native extraction failed: ${e.message}`); }
        }

        send({ text: `Minecraft ${version} ready!`, progress: 100 });
        log(`=== DOWNLOAD COMPLETE: ${version} ===`);
        discordRpc.setMenu();
        return { success: true };
    } catch (e) {
        logError(`Download failed: ${e.message}`);
        send({ text: `Error: ${e.message}`, progress: 0 });
        discordRpc.setMenu();
        return { success: false, error: e.message };
    }
});

// ═══════════════ LAUNCH MC ═══════════════
ipcMain.handle('launch-game', async (event, config) => {
    const { version, ram, gameDir, username, javaPath: customJavaPath, authMode = 'offline', jvmArgs: userJvmArgs = '' } = config;
    log(`=== LAUNCH START ===`);
    log(`Version: ${version}, RAM: ${ram}G, Username: ${username}, Auth: ${authMode}`);

    if (!gameDir) { logError('Game directory not set'); return { success: false, error: 'Game directory not set' }; }

    // Resolve the Minecraft session identity
    let session = { username, uuid: null, accessToken: 'void-offline-token', userType: 'offline', xuid: '0' };
    if (authMode === 'microsoft') {
        try {
            const acc = await msAuth.getUsableAccount();
            if (!acc) {
                logError('No Microsoft account — sign in first');
                return { success: false, error: 'Sign in to a Microsoft account first' };
            }
            session = {
                username: acc.username,
                uuid: acc.uuid,
                accessToken: acc.mcToken,
                userType: 'msa',
                xuid: acc.xuid || '0',
            };
            log(`Signed in as ${session.username} (Microsoft)`);
        } catch (e) {
            logError(`Microsoft auth refresh failed: ${e.message}`);
            return { success: false, error: `Microsoft login expired. Please sign in again. (${e.message})` };
        }
    } else {
        if (!session.username?.trim()) { logError('Username is empty'); return { success: false, error: 'Username required' }; }
        // Deterministic offline UUID so your world/skin offline identity is stable
        session.uuid = crypto.createHash('md5').update('OfflinePlayer:' + session.username.trim()).digest('hex');
        session.uuid = session.uuid.slice(0, 8) + '-' + session.uuid.slice(8, 12) + '-' + session.uuid.slice(12, 16) + '-' + session.uuid.slice(16, 20) + '-' + session.uuid.slice(20, 32);
    }

    const javaPath = customJavaPath || findJava();
    if (!javaPath) { logError('Java not found'); return { success: false, error: 'Java not found! Install Java 21+ from https://adoptium.net/' }; }
    log(`Java path: ${javaPath}`);

    const javaVer = getJavaVersion(javaPath);
    const required = getRequiredJava(version);
    log(`Java version: ${javaVer}, Required for MC ${version}: ${required}`);
    if (javaVer > 0 && javaVer < required) {
        const err = `Java ${javaVer} is too old for MC ${version}. Need Java ${required}+.`;
        logError(err);
        return { success: false, error: `${err}\nInstall from https://adoptium.net/` };
    }

    const versionsDir = path.join(gameDir, 'versions');
    const versionDir = path.join(versionsDir, version);
    const vJsonPath = path.join(versionDir, `${version}.json`);
    const clientJarPath = path.join(versionDir, `${version}.jar`);

    // For loader versions (fabric-loader-X, forge-X), the client jar is in the inherited vanilla version dir
    let effectiveClientJar = clientJarPath;
    let vjson;
    try { vjson = JSON.parse(fs.readFileSync(vJsonPath, 'utf8')); } catch {
        return { success: false, error: `Version JSON not found for ${version}. Install the loader first.` };
    }

    // Handle inheritsFrom (Fabric/Forge pattern)
    const librariesDir = path.join(gameDir, 'libraries');
    const classpathEntries = [];
    let patchedClientLib = null;

    if (vjson.inheritsFrom) {
        const parentVersion = vjson.inheritsFrom;
        const parentDir = path.join(versionsDir, parentVersion);
        const parentJsonPath = path.join(parentDir, `${parentVersion}.json`);
        const parentClientJar = path.join(parentDir, `${parentVersion}.jar`);

        // Parent client jar is the actual game jar
        effectiveClientJar = parentClientJar;
        if (!fs.existsSync(parentClientJar)) return { success: false, error: `Base MC jar missing for ${parentVersion}. Download it first.` };

        let parentVjson;
        try { parentVjson = JSON.parse(fs.readFileSync(parentJsonPath, 'utf8')); } catch {
            return { success: false, error: `Parent version JSON not found for ${parentVersion}` };
        }

        // Parent provides the asset index
        if (parentVjson.assetIndex && !vjson.assetIndex) vjson.assetIndex = parentVjson.assetIndex;

        // Merge libraries: parent first, then loader (loader overrides).
        // Deduplicate by group:artifact (e.g. vanilla asm 9.6 vs fabric asm 9.10.1)
        const artId = (lib) => {
            if (!lib?.name) return null;
            const p = lib.name.split(':');
            return p.length >= 2 ? `${p[0]}:${p[1]}` : null;
        };
        const parentLibs = parentVjson.libraries || [];
        const loaderLibs = vjson.libraries || [];
        const loaderArtifacts = new Set(loaderLibs.map(artId).filter(Boolean));
        const mergedLibs = [
            ...parentLibs.filter(l => !loaderArtifacts.has(artId(l))),
            ...loaderLibs,
        ];

        // Forge (slim installs, 53+): the loader ships a patched ":client" jar
        // that REPLACES the vanilla game jar on the classpath.
        patchedClientLib = loaderLibs.find(l => {
            const n = (l.name || '').split(':');
            return n.length === 4 && n[3] === 'client' && l.downloads?.artifact;
        });

        for (const lib of mergedLibs) {
            let libPath = null;
            if (lib.downloads?.artifact) {
                libPath = path.join(librariesDir, lib.downloads.artifact.path);
            }
            if (!libPath && lib.name) {
                libPath = path.join(librariesDir, nameToPath(lib.name));
            }
            if (libPath && fs.existsSync(libPath)) classpathEntries.push(libPath);
        }

        // Merge arguments: parent + loader game args, parent + loader jvm args
        if (!vjson.arguments) vjson.arguments = {};
        if (!vjson.arguments.game) vjson.arguments.game = [];
        if (!vjson.arguments.jvm) vjson.arguments.jvm = [];
        if (parentVjson.arguments?.game) {
            vjson.arguments.game = [...parentVjson.arguments.game.filter(a => typeof a === 'string'), ...vjson.arguments.game.filter(a => typeof a === 'string')];
        }
        if (parentVjson.arguments?.jvm) {
            vjson.arguments.jvm = [...parentVjson.arguments.jvm.filter(a => typeof a === 'string'), ...vjson.arguments.jvm.filter(a => typeof a === 'string')];
        }

        log(`Fabric/Forge: merged ${mergedLibs.length} libraries (parent: ${parentLibs.length}, loader: ${loaderLibs.length})`);
    } else {
        // Vanilla path
        if (!fs.existsSync(clientJarPath)) return { success: false, error: `Download ${version} first` };

        for (const lib of (vjson.libraries || [])) {
            let libPath = null;
            if (lib.downloads?.artifact) {
                libPath = path.join(librariesDir, lib.downloads.artifact.path);
                if (!fs.existsSync(libPath)) libPath = null;
            }
            if (!libPath && lib.name) {
                libPath = path.join(librariesDir, nameToPath(lib.name));
                if (!fs.existsSync(libPath)) libPath = null;
            }
            if (libPath) classpathEntries.push(libPath);
        }
    }

    const mainClass = (typeof vjson.mainClass === 'object' && vjson.mainClass.client) ? vjson.mainClass.client : (vjson.mainClass || 'net.minecraft.client.main.Main');
    const mcVersion = vjson.inheritsFrom || version;

    // NeoForge / modern Forge launch via the module path (-p ...) with
    // BootstrapLauncher, so skip -cp entirely; legacy loaders use plain -cp.
    const useModulePath = /BootstrapLauncher/.test(mainClass);

    // With a patched :client jar (slim Forge), that jar is already on the
    // classpath via mergedLibs; don't also add the vanilla jar.
    if (!patchedClientLib && !useModulePath) classpathEntries.push(effectiveClientJar);
    if (patchedClientLib) log('Forge: using patched :client jar instead of vanilla jar');

    const assetsDir = path.join(gameDir, 'assets');
    // Natives live under the parent (vanilla) version dir for loader versions
    const nativesDir = vjson.inheritsFrom ? path.join(versionsDir, vjson.inheritsFrom, 'natives') : path.join(versionDir, 'natives');
    const assetIndex = vjson.assetIndex?.id || mcVersion;
    // Session UUID: strip dashes for the MC client arg format
    const uuid = (session.uuid || crypto.randomUUID().replace(/-/g, '')).replace(/-/g, '');

    const jvmArgs = [
        `-Xmx${ram}G`, `-Xms${Math.min(parseInt(ram), 2)}G`,
        `-Djava.library.path=${nativesDir}`,
        `-Dminecraft.launcher.brand=VOIDCLIENT`, `-Dminecraft.launcher.version=2.4.1`,
    ];

    const sep = process.platform === 'win32' ? ';' : ':';
    const classpathStr = classpathEntries.join(sep);

    // Full substitution map shared by jvm + game args
    const sub = (s) => s
        .replace(/\$\{auth_player_name\}/g, session.username)
        .replace(/\$\{version_name\}/g, version)
        .replace(/\$\{game_directory\}/g, gameDir)
        .replace(/\$\{assets_root\}/g, assetsDir)
        .replace(/\$\{assets_index_name\}/g, assetIndex)
        .replace(/\$\{auth_uuid\}/g, uuid)
        .replace(/\$\{auth_access_token\}/g, session.accessToken)
        .replace(/\$\{auth_session\}/g, session.accessToken)
        .replace(/\$\{user_type\}/g, session.userType)
        .replace(/\$\{user_properties\}/g, '{}')
        .replace(/\$\{clientid\}|\$\{client_id\}/g, 'voidclient')
        .replace(/\$\{auth_xuid\}/g, session.xuid)
        .replace(/\$\{version_type\}/g, 'VOIDCLIENT')
        .replace(/\$\{launcher_name\}/g, 'VOIDCLIENT')
        .replace(/\$\{launcher_version\}/g, '2.4.1')
        .replace(/\$\{natives_directory\}/g, nativesDir)
        .replace(/\$\{library_directory\}/g, librariesDir)
        .replace(/\$\{classpath_separator\}/g, sep);

    const mcArgs = [];
    if (vjson.minecraftArguments) {
        const legacy = sub(vjson.minecraftArguments);
        mcArgs.push(...(legacy.match(/(?:[^\s"]+|"[^"]*")+/g) || legacy.split(' ')).map(a => a.replace(/^"|"$/g, '')));
    } else if (vjson.arguments?.game) {
        // Modern argument format
        for (const arg of vjson.arguments.game) {
            if (typeof arg === 'string') {
                const resolved = sub(arg);
                // Drop flags whose value is an unresolved placeholder
                if (/\$\{[^}]+\}/.test(resolved)) continue;
                mcArgs.push(resolved);
            }
        }
    } else {
        mcArgs.push(
            '--username', session.username, '--version', version, '--gameDir', gameDir,
            '--assetsDir', assetsDir, '--assetIndex', assetIndex,
            '--uuid', uuid, '--accessToken', session.accessToken,
            '--userType', session.userType, '--versionType', 'VOIDCLIENT'
        );
    }

    // JVM args from version JSON (Fabric/Forge/vanilla may add extra JVM args).
    // We supply our own -cp, so skip ${classpath} -containing tokens and bare -cp.
    if (vjson.arguments?.jvm) {
        for (const arg of vjson.arguments.jvm) {
            if (typeof arg === 'string' && arg.trim() !== '-cp') {
                const resolved = sub(arg);
                if (/\$\{[^}]+\}/.test(resolved)) continue;
                if (resolved.includes('${classpath}')) continue; // we add -cp ourselves
                jvmArgs.push(resolved);
            }
        }
    }

    // Deduplicate identical JVM args (parent + loader versions often repeat
    // them), but flags that pair with a module value (--add-opens,
    // --add-exports, ...) must keep distinct values: dedupe the pair as one unit.
    const VALUE_FLAGS = new Set(['--add-opens', '--add-exports', '--add-modules', '--patch-module']);
    const seen = new Set();
    const dedupedJvm = [];
    for (let i = 0; i < jvmArgs.length; i++) {
        const a = jvmArgs[i];
        let key = a;
        let advance = 1;
        if (VALUE_FLAGS.has(a) && i + 1 < jvmArgs.length) {
            key = `${a} ${jvmArgs[i + 1]}`;
            advance = 2;
        }
        if (seen.has(key)) { i += advance - 1; continue; }
        seen.add(key);
        dedupedJvm.push(a);
        if (advance === 2) { dedupedJvm.push(jvmArgs[i + 1]); i += advance - 1; }
    }

    // NeoForge / modern Forge launch via the module path (-p ...) with
    // BootstrapLauncher; passing a giant -cp alongside causes duplicate
    // class conflicts. (First occurrence is above, before classpath setup.)
    const allArgs = [...dedupedJvm, ...parseExtraJvmArgs(userJvmArgs), ...(useModulePath ? [] : ['-cp', classpathStr]), mainClass, ...mcArgs];

    // Never write tokens into logs or dry-run output — redact the access token
    const redactedArgs = allArgs.map(a => (a === session.accessToken ? '***REDACTED***' : a));
    const redactedCommand = `"${javaPath}" ${redactedArgs.join(' ')}`;
    log(`Launch: ${redactedCommand}`);
    if (process.env.VOID_DRY_RUN === '1') {
        // Test mode: report the full launch command without spawning
        return { success: true, dryRun: true, classpathCount: classpathEntries.length, mainClass, argCount: allArgs.length, command: redactedCommand.substring(0, 1200) };
    }

    try {
        const child = spawn(javaPath, allArgs, { cwd: gameDir, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', d => { stderr += d.toString(); });
        child.on('error', err => {
            logError(`Spawn error: ${err.message}`);
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('launch-error', `Launch error: ${err.message}`);
        });
        child.on('close', code => {
            log(`Minecraft exited with code ${code}`);
            discordRpc.setMenu();
            if (stderr.trim()) log(`stderr: ${stderr.substring(0, 500)}`);
            if (code !== 0 && mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('launch-error', `Minecraft crashed (code ${code}):\n${stderr.substring(0, 600)}`);
            }
        });
        child.unref();
        discordRpc.setInGame(version);
        return { success: true, message: `Minecraft ${version} launched!` };
    } catch (e) {
        logError(`Launch exception: ${e.message}`);
        return { success: false, error: e.message };
    }
});

function nameToPath(name) {
    const p = name.split(':');
    if (p.length < 3) return name.replace(/:/g, '/') + '.jar';
    const [g, a, v, ...r] = p;
    let fn = `${a}-${v}`;
    if (r.length) fn += `-${r[0]}`;
    return `${g.replace(/\./g, '/')}/${a}/${v}/${fn}.jar`;
}

// ═══════════════ MODRINTH ═══════════════
const LOADER_FACET = { forge: 'forge', fabric: 'fabric', neoforge: 'neoforge', quilt: 'quilt' };
const LOADER_ENUM = { forge: 'forge', fabric: 'fabric', neoforge: 'neoforge', quilt: 'quilt' };

ipcMain.handle('modrinth-search', async (event, { query, loader, version, type, index, limit, offset }) => {
    log(`Modrinth search: "${query}" type=${type} loader=${loader} version=${version} index=${index} offset=${offset}`);
    try {
        const projType = type || 'mod';
        const facetsArr = [[`project_type:${projType}`]];
        const facet = LOADER_FACET[loader];
        if (facet && (projType === 'mod' || projType === 'plugin')) facetsArr.push(['categories:' + facet]);
        if (version) facetsArr.push(['versions:' + version]);

        const params = new URLSearchParams();
        params.set('query', query || '');
        params.set('limit', String(limit || 20));
        params.set('index', ['downloads', 'follows', 'newest', 'updated'].includes(index) ? index : 'relevance');
        params.set('facets', JSON.stringify(facetsArr));
        if (offset) params.set('offset', String(offset));

        let data = await httpGet(`https://api.modrinth.com/v2/search?${params}`);
        let hits = data.hits || [];

        if (!hits.length && version) {
            const f2 = facetsArr.filter(f => !f[0]?.startsWith('versions:'));
            params.set('facets', JSON.stringify(f2));
            data = await httpGet(`https://api.modrinth.com/v2/search?${params}`);
            hits = data.hits || [];
        }

        log(`Modrinth: ${hits.length} results, total=${data.total_hits || 0}`);
        return {
            results: hits.map(h => ({
                slug: h.slug, title: h.title, description: h.description || '',
                downloads: h.downloads || 0, icon_url: h.icon_url || '',
                author: h.author || 'Unknown', versions: h.versions || [],
                categories: h.categories || [], project_id: h.project_id || h.slug
            })),
            total: data.total_hits || 0
        };
    } catch (e) { logError(`Modrinth search failed: ${e.message}`); return []; }
});

ipcMain.handle('modrinth-versions', async (event, { projectId, loader, mcVersion }) => {
    try {
        const params = new URLSearchParams();
        if (mcVersion) params.set('game_versions', JSON.stringify([mcVersion]));
        const loaderEnum = LOADER_ENUM[loader];
        if (loaderEnum) params.set('loaders', JSON.stringify([loaderEnum]));

        const data = await httpGet(`https://api.modrinth.com/v2/project/${projectId}/version?${params}`);
        return Array.isArray(data) ? data.map(v => ({
            id: v.id, name: v.name, version_number: v.version_number,
            files: (v.files || []).map(f => ({ url: f.url, filename: f.filename, size: f.size }))
        })) : [];
    } catch { return []; }
});

ipcMain.handle('modrinth-detail', async (event, { projectId }) => {
    try {
        const p = await httpGet(`https://api.modrinth.com/v2/project/${projectId}`);
        return {
            title: p.title, slug: p.slug, author: p.author || 'Unknown',
            description: p.description || '', body: p.body || '',
            downloads: p.downloads || 0, follows: p.followers || 0,
            icon_url: p.icon_url || '', loaders: p.loaders || [],
            categories: p.categories || [], game_versions: p.game_versions || [],
            gallery: (p.gallery || []).map(g => ({ url: g.url, title: g.title || '', featured: !!g.featured }))
        };
    } catch (e) { logError(`Modrinth detail failed: ${e.message}`); return null; }
});

// ═══════════════ AVATAR (player head via main-process network) ═══════════════
ipcMain.handle('avatar-fetch', async (event, name) => {
    if (!name || !/^[A-Za-z0-9_]{1,16}$/.test(name)) return null;
    const providers = [
        `https://mc-heads.net/avatar/${encodeURIComponent(name)}/88`,
        `https://minotar.net/helm/${encodeURIComponent(name)}/88`
    ];
    for (const url of providers) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'VOIDCLIENT/1.0' } });
            if (res.ok) {
                const buf = Buffer.from(await res.arrayBuffer());
                if (buf.length > 500 && buf[0] === 0x89 && buf[1] === 0x50) {
                    return 'data:image/png;base64,' + buf.toString('base64');
                }
            }
        } catch {}
    }
    return null;
});

ipcMain.handle('install-mod', async (event, { fileUrl, filename, gameDir, target }) => {
    log(`Installing to ${target || 'mods'}: ${filename}`);
    try {
        const destDir = path.join(gameDir, target || 'mods');
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
        const base = filename.replace(/-[\d.]+(-[\w]+)?\.jar$/, '');
        fs.readdirSync(destDir).filter(f => f.startsWith(base) && f.endsWith('.jar')).forEach(f => {
            try { fs.unlinkSync(path.join(destDir, f)); } catch {}
        });
        await downloadFile(fileUrl, path.join(destDir, filename));
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
});

// ═══════════════ HELPERS ═══════════════
function formatBytes(b) { return b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(1) + ' MB'; }
function getFallbackVersions() {
    return [
        { id: '1.21.4', type: 'release' }, { id: '1.21.3', type: 'release' }, { id: '1.21.2', type: 'release' },
        { id: '1.21.1', type: 'release' }, { id: '1.21', type: 'release' }, { id: '1.20.6', type: 'release' },
        { id: '1.20.4', type: 'release' }, { id: '1.20.1', type: 'release' }, { id: '1.19.4', type: 'release' },
        { id: '1.18.2', type: 'release' }, { id: '1.16.5', type: 'release' }, { id: '1.12.2', type: 'release' },
        { id: '1.7.10', type: 'release' },
    ];
}
