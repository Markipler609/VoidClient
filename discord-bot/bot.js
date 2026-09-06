require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActivityType } = require('discord.js');

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const PREFIX = process.env.BOT_PREFIX || '!';
const REPO = process.env.REPO || 'Markipler609/VoidClient';
const HEALTH_BASE = process.env.HEALTH_BASE || 'http://x95027pc.beget.tech';
const ADMIN_ROLE_IDS = (process.env.ADMIN_ROLE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const GUILD_IDS = (process.env.GUILD_ID || '').split(',').map(s => s.trim()).filter(Boolean);
const ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID || null;
const AI_BASE = process.env.AI_BASE || 'http://localhost:20128/v1';
const AI_KEY = process.env.AI_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'minimax-m2.5';

if (!TOKEN) {
    console.error('DISCORD_BOT_TOKEN is not set. Copy .env.example to .env and fill it in.');
    process.exit(1);
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) VOIDDiscordBot/1.0';

const SYSTEM_PROMPT = 'You are the VOID CLIENT assistant — a Discord AI helper for the VOID CLIENT Minecraft launcher community. You help with releases, skins, launcher setup, troubleshooting and general questions about VOID CLIENT. Be concise and friendly, answer in the user\'s language. Keep the conversation context in mind.';
const MEMORY_TURNS = 14;
const chatMem = new Map();

const BASE_INTENTS = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];

function startClient(withContentIntent) {
    const intents = withContentIntent ? [...BASE_INTENTS, GatewayIntentBits.MessageContent] : BASE_INTENTS;
    const client = new Client({ intents: intents });

function makeCheck(name, url, expected) {
    return async () => {
        try {
            const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
            const body = await r.text();
            return { name, code: r.status, expected, detail: body };
        } catch (e) {
            return { name, code: 'ERR', expected, detail: e.message };
        }
    };
}

const CHECKS = [
    makeCheck('counter', HEALTH_BASE + '/counter.php', 200),
    makeCheck('site', HEALTH_BASE + '/', 200),
    makeCheck('telemetry', HEALTH_BASE + '/api/telemetry.php?health=1', 200),
    makeCheck('stats401', HEALTH_BASE + '/api/stats.php', 401),
    makeCheck('pages', 'https://markipler609.github.io/VoidClient/version.json', 200),
    makeCheck('feed', 'https://markipler609.github.io/VoidClient/feed.xml', 200),
];

function allowed(msg) {
    const uid = msg.author.id;
    if (ADMIN_USER_IDS.includes(uid)) return true;
    const unames = [msg.author.username, msg.author.globalName].filter(Boolean).map(n => n.toLowerCase().replace(/#\d+$/, ''));
    if (unames.some(n => ADMIN_USERNAMES.includes(n))) return true;
    if (ADMIN_ROLE_IDS.length) {
        return msg.member && msg.member.roles.cache.some(role => ADMIN_ROLE_IDS.includes(role.id));
    }
    return false;
}

async function askAI(history) {
    if (!AI_KEY) return 'AI is not configured (AI_KEY missing in .env).';
    try {
        const r = await fetch(AI_BASE + '/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AI_KEY },
            body: JSON.stringify({ model: AI_MODEL, messages: [{ role: 'system', content: SYSTEM_PROMPT }].concat(history), max_tokens: 500 }),
            signal: AbortSignal.timeout(60000),
        });
        if (r.status !== 200) {
            const t = await r.text().catch(() => '');
            return 'AI error HTTP ' + r.status + (t ? ': ' + t.slice(0, 200) : '');
        }
        const j = await r.json();
        const content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
        return String(content).slice(0, 1500) || '(no response)';
    } catch (e) {
        return 'AI request failed: ' + (e && e.message);
    }
}

async function latestRelease(version) {
    const url = version
        ? `https://api.github.com/repos/${REPO}/releases/tags/v${version}`
        : `https://api.github.com/repos/${REPO}/releases/latest`;
    const r = await fetch(url, { headers: { 'User-Agent': 'VOID-discord-bot', 'Accept': 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
    if (r.status !== 200) return null;
    return r.json();
}

function releaseEmbed(release) {
    const tag = release.tag_name || '';
    const ver = tag.replace(/^v/i, '');
    const desc = (release.body || '').split('\n').slice(0, 8).join('\n').slice(0, 1024) || '*No release notes.*';
    const assets = (release.assets || []).map(a => a.name).filter(n => !n.endsWith('.blockmap'));
    const embed = new EmbedBuilder()
        .setTitle(`🚀 VOID CLIENT ${ver} is out!`)
        .setURL(release.html_url || `https://github.com/${REPO}/releases/tag/${tag}`)
        .setDescription(desc)
        .setColor(0x2b2bff)
        .setTimestamp(new Date(release.published_at));
    if (assets.length) {
        embed.addFields({ name: 'Downloads', value: '`' + assets.join('`\n`') + '`', inline: false });
    }
    return embed;
}

async function targetChannel(msg) {
    if (!ANNOUNCE_CHANNEL_ID) return msg.channel;
    return msg.guild.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(() => null);
}

client.once('ready', () => {
    console.log(`[VOID BOT] online as ${client.user.tag}`);
    client.user.setPresence({ activities: [{ name: 'VOID CLIENT updates', type: ActivityType.Watching }], status: 'online' });
});

function commandFrom(msg) {
    if (!msg.content) return null;
    let content = msg.content;
    const mentioned = msg.mentions && msg.mentions.has(msg.client.user.id);
    if (!mentioned && !content.startsWith(PREFIX)) return null;
    if (mentioned) content = content.replace(/<@!?\d+>/g, ' ').trim();
    if (!content) return null;
    if (content.startsWith(PREFIX)) content = content.slice(PREFIX.length).trim();
    const parts = content.split(/\s+/).filter(Boolean);
    if (!parts.length) return null;
    const cmd = parts.shift().toLowerCase();
    return { cmd, args: parts, text: parts.join(' ').trim() };
}

client.on('messageCreate', async (msg) => {
    if (msg.author.bot || !msg.guild) return;
    if (GUILD_IDS.length && !GUILD_IDS.includes(msg.guild.id)) return;
    const parsed = commandFrom(msg);
    if (!parsed) return;
    const { cmd, args, text } = parsed;

    if (cmd === 'help') {
        return msg.channel.send(
            '**VOID CLIENT bot — commands**\n' +
            'Use `' + PREFIX + 'cmd` or `@VOID CLIENT Updates cmd`:\n' +
            '`' + PREFIX + 'help` — this message\n' +
            '`' + PREFIX + 'latest` — latest release info\n' +
            '`' + PREFIX + 'announce <text>` — post an announcement\n' +
            '`' + PREFIX + 'announce-update <version>` — release announcement for a version\n' +
            '`' + PREFIX + 'ask <text>` — ask the AI assistant (remembers context)\n' +
            '`' + PREFIX + 'reset` — clear your AI context\n' +
            '`' + PREFIX + 'status` — ecosystem health check'
        );
    }
    if (!allowed(msg)) return msg.reply('You need a moderator role to use this bot.');

    if (cmd === 'latest') {
        const rel = await latestRelease();
        if (!rel) return msg.reply('Could not fetch the latest release.');
        return msg.channel.send({ embeds: [releaseEmbed(rel)] });
    }

    if (cmd === 'announce') {
        const channel = await targetChannel(msg);
        if (!channel) return msg.reply('Announcement channel not found.');
        const embed = new EmbedBuilder()
            .setTitle('📢 VOID CLIENT')
            .setDescription(text || '*empty announcement*')
            .setColor(0x2b2bff)
            .setTimestamp();
        return channel.send({ embeds: [embed] });
    }

    if (cmd === 'announce-update') {
        const ver = args[0];
        if (!ver) return msg.reply('Usage: `' + PREFIX + 'announce-update <version>` e.g. `' + PREFIX + 'announce-update 1.0.3`');
        const rel = await latestRelease(ver);
        if (!rel) return msg.reply(`No release found for v${ver}.`);
        const channel = await targetChannel(msg);
        if (!channel) return msg.reply('Announcement channel not found.');
        return channel.send({ embeds: [releaseEmbed(rel)] });
    }

    if (cmd === 'ask') {
        if (!text) return msg.reply('Usage: `' + PREFIX + 'ask <question>`');
        const key = `${msg.guild.id}:${msg.channel.id}:${msg.author.id}`;
        const history = chatMem.get(key) || [];
        history.push({ role: 'user', content: text.slice(0, 1200) });
        const send = history.slice(-MEMORY_TURNS);
        await msg.channel.sendTyping();
        const answer = await askAI(send);
        send.push({ role: 'assistant', content: answer.slice(0, 1500) });
        chatMem.set(key, send.slice(-MEMORY_TURNS));
        const chunks = answer.match(/[\s\S]{1,1950}/g) || ['(no response)'];
        for (const c of chunks) await msg.channel.send(c);
        return;
    }

    if (cmd === 'reset') {
        chatMem.delete(`${msg.guild.id}:${msg.channel.id}:${msg.author.id}`);
        return msg.reply('🧠 Context cleared for you.');
    }

if (cmd === 'status') {
        const results = await Promise.all(CHECKS.map(fn => fn()));
        const lines = results.map(r => {
            const mark = r.code === r.expected ? '✅' : (r.code === 403 ? '⚠️' : '❌');
            return `${mark} **${r.name}** — HTTP ${r.code} (expected ${r.expected})`;
        });
        const ok = results.every(r => r.code === r.expected || r.code === 403);
        const embed = new EmbedBuilder()
            .setTitle(ok ? '🟢 Ecosystem healthy' : '🔴 Ecosystem degraded')
            .setDescription(lines.join('\n'))
            .setColor(ok ? 0x2ecc71 : 0xe74c3c)
            .setTimestamp();
        return msg.channel.send({ embeds: [embed] });
    }
});

client.once('ready', () => {
    console.log(`[VOID BOT] online as ${client.user.tag}`);
    client.user.setPresence({ activities: [{ name: 'VOID CLIENT updates', type: ActivityType.Watching }], status: 'online' });
});

client.login(TOKEN).catch((err) => {
    if (withContentIntent && String(err && err.message).includes('disallowed intents')) {
        console.warn('[VOID BOT] Message Content intent disabled in portal — falling back to @-mention commands');
        startClient(false);
    } else {
        console.error('[VOID BOT] login failed:', (err && err.message) || err);
        process.exit(1);
    }
});
}

startClient(true);