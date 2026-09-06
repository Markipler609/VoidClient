// ═══════════════════════════════════════════════════════════════
//  DISCORD RICH PRESENCE — shows "Playing VOID CLIENT" on Discord.
//
//  IMPORTANT: replace DISCORD_APP_ID with the Client ID of your
//  Discord application. Create one at
//  https://discord.com/developers/applications → New Application.
//  Then upload the launcher icon as an Art Asset with the key
//  "void_logo" (Rich Presence → Art Assets) so the big image shows.
//  You can also override the ID at runtime with the
//  VOID_DISCORD_APP_ID environment variable.
// ═══════════════════════════════════════════════════════════════

const DISCORD_APP_ID = '1545736322801602610';
const DISCORD_INVITE_URL = 'https://discord.gg/pxkffhb54v';

let client = null;
let connected = false;
let current = null;
let logFn = (...args) => console.log(...args);

const JOIN_BUTTON = { label: 'Join Discord', url: DISCORD_INVITE_URL };

function appId() {
    return process.env.VOID_DISCORD_APP_ID || DISCORD_APP_ID;
}

function setLogger(fn) {
    if (typeof fn === 'function') logFn = fn;
}

async function init() {
    if (client) return;
    try {
        const { Client } = require('@xhayper/discord-rpc');
        client = new Client({ clientId: appId(), transport: { type: 'ipc' } });
        client.on('ready', () => {
            connected = true;
            logFn('[RPC] Discord connected');
            if (current) apply(current);
        });
        client.on('disconnected', () => {
            connected = false;
            logFn('[RPC] Discord disconnected');
        });
        await Promise.race([
            client.login(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout waiting for Discord')), 6000)),
        ]);
    } catch (e) {
        if (client) { try { await client.destroy(); } catch {} }
        client = null;
        logFn(`[RPC] Discord not available: ${e.message}`);
    }
}

async function apply(presence) {
    if (!client || !client.user) return;
    try {
        if (presence) await client.user.setActivity(presence);
        else await client.user.clearActivity();
    } catch (e) { /* ignore transient rpc errors */ }
}

function setPresence(p) {
    current = p;
    if (connected) apply(p);
}

function setMenu() {
    setPresence({
        details: 'VOID CLIENT',
        state: 'Browsing the void',
        startTimestamp: Date.now(),
        largeImageKey: 'void_logo',
        largeImageText: 'VOID CLIENT',
        buttons: [JOIN_BUTTON],
        instance: false,
    });
}

function setInGame(version) {
    setPresence({
        details: 'VOID CLIENT',
        state: `Playing Minecraft ${version}`,
        startTimestamp: Date.now(),
        largeImageKey: 'void_logo',
        largeImageText: 'VOID CLIENT',
        buttons: [JOIN_BUTTON],
        instance: true,
    });
}

function setInstalling(step) {
    setPresence({
        details: 'VOID CLIENT',
        state: step || 'Setting things up…',
        startTimestamp: Date.now(),
        largeImageKey: 'void_logo',
        largeImageText: 'VOID CLIENT',
        buttons: [JOIN_BUTTON],
        instance: false,
    });
}

async function shutdown() {
    if (!client) return;
    try { if (client.user) await client.user.clearActivity(); } catch {}
    try { await client.destroy(); } catch {}
    client = null;
    connected = false;
}

module.exports = { init, setMenu, setInGame, setInstalling, shutdown, setLogger };