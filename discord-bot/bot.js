require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActivityType } = require('discord.js');

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const PREFIX = process.env.BOT_PREFIX || '!';
const REPO = process.env.REPO || 'Markipler609/VoidClient';
const HEALTH_BASE = process.env.HEALTH_BASE || 'http://x95027pc.beget.tech';
const ADMIN_ROLE_IDS = (process.env.ADMIN_ROLE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID || null;

if (!TOKEN) {
    console.error('DISCORD_BOT_TOKEN is not set. Copy .env.example to .env and fill it in.');
    process.exit(1);
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) VOIDDiscordBot/1.0';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

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
    if (!ADMIN_ROLE_IDS.length) return true;
    return msg.member && msg.member.roles.cache.some(role => ADMIN_ROLE_IDS.includes(role.id));
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

client.on('messageCreate', async (msg) => {
    if (msg.author.bot || !msg.guild) return;
    if (!msg.content.startsWith(PREFIX)) return;
    const parts = msg.content.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = (parts.shift() || '').toLowerCase();
    const args = parts;
    const text = args.join(' ').trim();

    if (cmd === 'help') {
        return msg.channel.send(
            '**VOID CLIENT bot**\n' +
            '`' + PREFIX + 'help` — this message\n' +
            '`' + PREFIX + 'latest` — latest release info\n' +
            '`' + PREFIX + 'announce <text>` — post an announcement\n' +
            '`' + PREFIX + 'announce-update <version>` — release announcement for a version\n' +
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

client.login(TOKEN);