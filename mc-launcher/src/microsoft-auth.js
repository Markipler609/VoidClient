// ═══════════════════════════════════════════════════════════════════════════
//  Microsoft Account authentication for VOID CLIENT.
//
//  Uses the OAuth 2.0 Device Authorization Grant ("device code flow") with the
//  Microsoft identity platform, then the Xbox Live / XSTS / Minecraft login
//  chain to obtain a Minecraft access token and the player profile.
//
//  Tokens are persisted encrypted via electron.safeStorage (DPAPI on Windows).
//  No token/secret is ever written to logs by this module.
//
//  CLIENT ID: register an Azure app (portal.azure.com → Microsoft Entra ID →
//  App registrations → New). Set "Supported account types" to
//  "Personal Microsoft accounts only" (or any directory), and enable it as a
//  native/public client with redirect "https://login.microsoftonline.com/common/
//  oauth2/nativeclient". Paste the Application (client) ID below.
// ═══════════════════════════════════════════════════════════════════════════

const { safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

// ▼▼▼ YOUR REGISTERED AZURE APPLICATION CLIENT ID ▼▼▼
//
// Two ways to provide it (never commit a real one to a public repo):
//   1. Set the VOID_MSA_CLIENT_ID environment variable (recommended for forks),
//   2. Or paste it directly below.
// Публичный Client ID от Prism Launcher (open source, используется для проверки).
// Если делаете свой релиз — зарегистрируйте свой Client ID в Azure и впишите его сюда.
const CLIENT_ID = process.env.VOID_MSA_CLIENT_ID || 'c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb';
const AUTH_SCOPE = 'XboxLive.signin offline_access';
const ACCOUNT_FILE = 'void-account.json';

// Re-login via refresh token when the cached Minecraft token is older than this
const MC_TOKEN_MAX_AGE_MS = 7 * 3600 * 1000;

let vaultDir = path.join(require('os').homedir(), '.voidclient');

function setVaultDir(dir) { vaultDir = dir; }
function vaultPath() { return path.join(vaultDir, ACCOUNT_FILE); }

function isConfigured() { return typeof CLIENT_ID === 'string' && CLIENT_ID.length > 0; }

// ────────────────────────── HTTP helpers ──────────────────────────
function postJson(url, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const payload = JSON.stringify(body);
        const req = https.request(u, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'Accept': 'application/json',
                'User-Agent': 'VoidClient/2.4',
                ...headers,
            },
        }, (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => {
                let parsed = data;
                try { parsed = JSON.parse(data); } catch {}
                if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
                else reject(new Error(((parsed && (parsed.error_description || parsed.error || parsed.message)) || `HTTP ${res.statusCode}`)));
            });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.write(payload);
        req.end();
    });
}

function formPost(url, params, opts = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const body = new URLSearchParams(params).toString();
        const req = https.request(u, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
                'Accept': 'application/json',
            },
        }, (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => {
                let parsed = data;
                try { parsed = JSON.parse(data); } catch {}
                if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
                else if (opts.resolveErrors) resolve({ _httpError: true, ...(parsed && typeof parsed === 'object' ? parsed : {}) });
                else reject(new Error(((parsed && (parsed.error_description || parsed.error || parsed.message)) || `HTTP ${res.statusCode}`)));
            });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.write(body);
        req.end();
    });
}

function getJson(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'VoidClient/2.4', ...headers } }, (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => {
                let parsed = data;
                try { parsed = JSON.parse(data); } catch {}
                if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
                else reject(new Error(((parsed && (parsed.error || parsed.message || parsed.error_description)) || `HTTP ${res.statusCode}`)));
            });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

// ────────────────────────── OAuth device flow ──────────────────────────
async function requestDeviceCode() {
    const res = await formPost('https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode', {
        client_id: CLIENT_ID,
        scope: AUTH_SCOPE,
    });
    return {
        deviceCode: res.device_code,
        userCode: res.user_code,
        verificationUri: res.verification_uri,
        expiresIn: res.expires_in,
        interval: res.interval,
        message: res.message,
    };
}

async function pollForToken(deviceCode) {
    // Device-flow polling keeps returning HTTP 400 with error JSON until the
    // user approves ("authorization_pending"). We capture those as fields.
    const res = await formPost('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: CLIENT_ID,
        device_code: deviceCode,
    }, { resolveErrors: true });
    return {
        accessToken: res.access_token,
        refreshToken: res.refresh_token,
        scope: res.scope,
        expiresIn: res.expires_in,
        error: res.error,
        errorDescription: res.error_description,
    };
}

// ────────────────────────── Xbox / Minecraft chain ──────────────────────────
async function xblAuthenticate(msaAccessToken) {
    const res = await postJson('https://user.auth.xboxlive.com/user/authenticate', {
        Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msaAccessToken}` },
        RelyingParty: 'http://auth.xboxlive.com',
        TokenType: 'JWT',
    }, { 'x-xbl-contract-version': '1' });
    return { token: res.Token, uhs: res.DisplayClaims.xui[0].uhs };
}

async function xstsAuthorize(xblToken) {
    const res = await postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
        Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
        RelyingParty: 'rp://api.minecraftservices.com/',
        TokenType: 'JWT',
    }, { 'x-xbl-contract-version': '1' });
    const claims = res.DisplayClaims.xui[0];
    return { token: res.Token, xuid: claims.xui ? claims.xui : claims.xuid, uhs: claims.uhs };
}

async function minecraftLoginWithXbox(uhs, xstsToken) {
    const res = await postJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
        identityToken: `XBL3.0 x=${uhs};${xstsToken}`,
    });
    return res.access_token;
}

async function getMinecraftProfile(mcToken) {
    try {
        const res = await getJson('https://api.minecraftservices.com/minecraft/profile', { Authorization: `Bearer ${mcToken}` });
        if (!res || !res.name) return null;
        return {
            id: res.id || null,          // dashed uuid
            username: res.name,
            skins: (res.skins || []).map((s) => s.url),
        };
    } catch {
        return null;
    }
}

// ────────────────────────── Token vault (encrypted) ──────────────────────────
function encrypt(text) {
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
        return `enc:${safeStorage.encryptString(text).toString('base64')}`;
    }
    // Fallback (unsupported platform): obfuscate but never store plaintext.
    const iv = crypto.randomBytes(16);
    const key = crypto.createHash('sha256').update('void-client-local-vault').digest();
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let enc = cipher.update(text, 'utf8');
    enc = Buffer.concat([enc, cipher.final()]);
    return `obf:${iv.toString('base64')}:${enc.toString('base64')}`;
}

function decrypt(stored) {
    try {
        if (!stored) return null;
        if (stored.startsWith('enc:')) {
            if (!safeStorage.isEncryptionAvailable()) return null;
            return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
        }
        if (stored.startsWith('obf:')) {
            const [ivB64, encB64] = stored.slice(4).split(':');
            const key = crypto.createHash('sha256').update('void-client-local-vault').digest();
            const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivB64, 'base64'));
            let dec = decipher.update(Buffer.from(encB64, 'base64'));
            dec = Buffer.concat([dec, decipher.final()]);
            return dec.toString('utf8');
        }
    } catch {}
    return null;
}

// Stored account shape: { mode, username, uuid, xuid, refreshToken, mcToken, obtainedAt }
function loadStoredAccount() {
    try {
        if (!fs.existsSync(vaultPath())) return null;
        const raw = JSON.parse(fs.readFileSync(vaultPath(), 'utf8'));
        return {
            mode: 'microsoft',
            username: decrypt(raw.username) || 'Player',
            uuid: decrypt(raw.uuid) || null,
            xuid: decrypt(raw.xuid) || '',
            refreshToken: decrypt(raw.refreshToken) || null,
            mcToken: decrypt(raw.mcToken) || null,
            obtainedAt: raw.obtainedAt || 0,
        };
    } catch { return null; }
}

function saveVault(fields) {
    const enc = (v) => (v ? encrypt(String(v)) : null);
    const data = {
        username: enc(fields.username),
        uuid: enc(fields.uuid),
        xuid: enc(fields.xuid),
        refreshToken: enc(fields.refreshToken),
        mcToken: enc(fields.mcToken),
        obtainedAt: fields.obtainedAt || Date.now(),
    };
    fs.writeFileSync(vaultPath(), JSON.stringify(data, null, 2));
}

// ────────────────────────── Public API ──────────────────────────
// Full login once the user has authorized the device code in the browser.
// Returns the Minecraft account (username/uuid/mcToken/xuid/refreshToken).
// If a pollResult from a prior pollForToken() call is supplied, it is reused
// instead of polling again (the device code is single-use).
async function finalizeLogin(deviceCode, pollResult) {
    const poll = pollResult || await pollForToken(deviceCode);
    if (poll.error) throw new Error(poll.errorDescription || poll.error);
    if (!poll.accessToken) throw new Error('No access token in response');

    const xbl = await xblAuthenticate(poll.accessToken);
    const xsts = await xstsAuthorize(xbl.token);
    const mcToken = await minecraftLoginWithXbox(xbl.uhs, xsts.token);

    const profile = await getMinecraftProfile(mcToken);
    if (!profile) throw new Error('Microsoft account has no Minecraft purchase / profile');

    const account = {
        mode: 'microsoft',
        username: profile.username,
        uuid: profile.id ? profile.id.replace(/-/g, '') : null,
        xuid: xsts.xuid || '',
        refreshToken: poll.refreshToken,
        mcToken,
        obtainedAt: Date.now(),
    };
    saveVault(account);
    return account;
}

// Load a usable Microsoft account: returns existing mcToken if fresh enough,
// otherwise refreshes via refreshToken and re-runs the MC login chain.
async function getUsableAccount() {
    const stored = loadStoredAccount();
    if (!stored || !stored.refreshToken) return null;

    const fresh = stored.mcToken && Date.now() - (stored.obtainedAt || 0) < MC_TOKEN_MAX_AGE_MS;
    if (fresh && stored.username && stored.uuid) return stored;

    try {
        const refreshed = await formPost('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
            grant_type: 'refresh_token',
            client_id: CLIENT_ID,
            scope: AUTH_SCOPE,
            refresh_token: stored.refreshToken,
        });
        if (!refreshed.access_token) throw new Error('Refresh failed');

        const xbl = await xblAuthenticate(refreshed.access_token);
        const xsts = await xstsAuthorize(xbl.token);
        const mcToken = await minecraftLoginWithXbox(xbl.uhs, xsts.token);
        const profile = await getMinecraftProfile(mcToken);

        const account = {
            mode: 'microsoft',
            username: (profile && profile.username) || stored.username,
            uuid: (profile && profile.id) ? profile.id.replace(/-/g, '') : stored.uuid,
            xuid: xsts.xuid || stored.xuid,
            refreshToken: refreshed.refresh_token || stored.refreshToken,
            mcToken,
            obtainedAt: Date.now(),
        };
        saveVault(account);
        return account;
    } catch (e) {
        // Refresh token expired/revoked → force re-login
        removeAccount();
        throw e;
    }
}

function removeAccount() {
    try { if (fs.existsSync(vaultPath())) fs.unlinkSync(vaultPath()); } catch {}
}

function hasAccount() {
    return !!loadStoredAccount();
}

module.exports = {
    setVaultDir,
    isConfigured,
    requestDeviceCode,
    pollForToken,
    finalizeLogin,
    getUsableAccount,
    removeAccount,
    hasAccount,
    loadStoredAccount,
};