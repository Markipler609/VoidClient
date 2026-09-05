const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ═══════════════ STATE ═══════════════
let allVersions = [];
let loaderSupport = { forge: [], fabric: [], neoforge: [], quilt: [] };
let currentVersionFilter = 'release';
let selectedVersion = '1.21.4';
let selectedLoader = 'vanilla';
let ram = 4;
let gameDir = path.join(os.homedir(), '.voidclient');
let javaPath = null;
let javaVersion = 0;
let particlesEnabled = true;
let customBgPath = null;
let customBgEnabled = false;
let customVideoPath = null;
let videoSoundEnabled = false;
let videoVolume = 1;
let uiSoundsEnabled = true;
let settingsBlocksOrder = [];
let jvmArgs = '';
let profiles = [];
let installedVersions = [];
let currentEffect = 'dither';
let authMode = 'offline';
let msUsername = null;
let lastMsSignedIn = null;
let msFlashT = null;
let msPollTimer = null;
let lang = 'en';

// Theme state
let theme = {
    accent: '#ffffff', bg: '#050505', text: '#ffffff', textDim: '#666666',
    border: '#141414', glass: '#0a0a0a', sidebar: '#0a0a0a',
    glassBlur: 20, particleOpacity: 60, sidebarBlur: 24, modCardBlur: 14
};

// ═══════════════ INIT ═══════════════
document.addEventListener('DOMContentLoaded', async () => {
    loadSettings();
    window.VIOnLangChange = (code) => { lang = code; saveSettings(); resyncAllCustomSelects(); };
    window.VI.onApply = () => { resyncAllCustomSelects(); };
    window.VI.setLang(lang);
    const langTrigger = document.getElementById('lang-trigger');
    const langDropdown = document.getElementById('lang-dropdown');
    if (langTrigger && langDropdown) {
        const clearLangOpen = () => {
            langDropdown.classList.remove('open');
            const card = langDropdown.closest('.settings-card');
            if (card) card.classList.remove('lang-open');
        };
        langTrigger.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = langDropdown.classList.contains('open');
            clearLangOpen();
            if (!isOpen) {
                langDropdown.classList.add('open');
                const card = langDropdown.closest('.settings-card');
                if (card) card.classList.add('lang-open');
            }
        });
        document.addEventListener('click', clearLangOpen);
        langDropdown.addEventListener('click', (e) => { if (e.target.closest('.lang-option')) clearLangOpen(); });
    }
    initTitlebar();
    initSidebar();
    initCursorDot();
    initLeverToggles();
    initVersionPanel();
    initModsPanel();
    initSettingsPanel();
    initLogButton();
    initCustomizeModal();
    initProfileControls();
    initMicrosoftAuth();
    updateHomeStats();
    renderProfiles();
    applyTheme();
    await loadVersions();
    await checkJava();
    safeStartParticles();
    applyCustomBg();
    applyCustomVideo();
    updateProfile();
    document.getElementById('username-input').addEventListener('input', updateProfile);
});

// ═══════════════ SETTINGS PERSISTENCE ═══════════════
function settingsPath() { return path.join(gameDir, 'void-settings.json'); }
function loadSettings() {
    try {
        if (fs.existsSync(settingsPath())) {
            const s = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
            if (s.ram) ram = s.ram;
            if (s.gameDir) gameDir = s.gameDir;
            if (s.javaPath) javaPath = s.javaPath;
            if (s.username) document.getElementById('username-input').value = s.username;
            if (s.selectedVersion) selectedVersion = s.selectedVersion;
            if (s.selectedLoader) selectedLoader = s.selectedLoader;
            if (s.particlesEnabled !== undefined) particlesEnabled = s.particlesEnabled;
            if (s.customBgPath) customBgPath = s.customBgPath;
            if (s.customBgEnabled !== undefined) customBgEnabled = s.customBgEnabled;
            if (s.customVideoPath) customVideoPath = s.customVideoPath;
            if (s.videoSoundEnabled !== undefined) videoSoundEnabled = s.videoSoundEnabled;
            if (s.videoVolume !== undefined) videoVolume = s.videoVolume;
            if (s.uiSoundsEnabled !== undefined) uiSoundsEnabled = s.uiSoundsEnabled;
            if (s.currentEffect) currentEffect = (s.currentEffect === 'pointcloud' || s.currentEffect === 'smoke') ? 'dither' : s.currentEffect;
            if (s.authMode) authMode = s.authMode;
            if (s.theme) theme = { ...theme, ...s.theme };
            if (s.settingsBlocksOrder) settingsBlocksOrder = s.settingsBlocksOrder;
            if (s.jvmArgs !== undefined) jvmArgs = s.jvmArgs;
            if (s.profiles) profiles = s.profiles;
            if (s.lang) lang = s.lang;
        }
    } catch {}
}
function saveSettings() {
    try {
        const s = {
            ram, gameDir, javaPath, selectedVersion, selectedLoader, particlesEnabled,
            customBgPath, customBgEnabled, customVideoPath, videoSoundEnabled, videoVolume, uiSoundsEnabled, currentEffect, theme,
            authMode,
            settingsBlocksOrder,
            jvmArgs,
            profiles,
            lang,
            username: document.getElementById('username-input')?.value || 'VoidPlayer'
        };
        if (!fs.existsSync(gameDir)) fs.mkdirSync(gameDir, { recursive: true });
        fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
    } catch {}
}

// ═══════════════ TITLEBAR ═══════════════
function initTitlebar() {
    document.getElementById('btn-min').onclick = () => ipcRenderer.send('window-minimize');
    document.getElementById('btn-max').onclick = () => ipcRenderer.send('window-maximize');
    document.getElementById('btn-close').onclick = () => ipcRenderer.send('window-close');
    document.getElementById('btn-customize').onclick = () => {
        document.getElementById('customize-modal').classList.toggle('hidden');
    };
}

// ═══════════════ SIDEBAR ═══════════════
function showPanel(name) {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.panel === name));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    const panel = document.getElementById(`panel-${name}`);
    if (panel) panel.classList.add('active');
}

function initSidebar() {
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => showPanel(btn.dataset.panel));
    });
}

// ═══════════════ LEVER TOGGLES ═══════════════
function initLeverToggles() {
    document.querySelectorAll('.lever').forEach(lever => {
        lever.addEventListener('click', () => {
            const active = lever.dataset.active === 'true';
            lever.dataset.active = active ? 'false' : 'true';
            handleLeverChange(lever.id, !active);
        });
    });
    document.getElementById('lever-particles').dataset.active = String(particlesEnabled);
    document.getElementById('lever-video-sound').dataset.active = String(!videoSoundEnabled);
    document.getElementById('lever-ui-sounds').dataset.active = String(uiSoundsEnabled);
}

function handleLeverChange(id, value) {
    if (id === 'lever-particles') {
        particlesEnabled = value;
        document.getElementById('particles').classList.toggle('hidden', !value);
        const dC = document.getElementById('dither-canvas');
        if (dC) dC.classList.toggle('hidden', !value);
    } else if (id === 'lever-video-sound') {
        videoSoundEnabled = !value;
        const vid = document.getElementById('custom-video');
        vid.muted = value;
    } else if (id === 'lever-ui-sounds') {
        uiSoundsEnabled = value;
    }
    saveSettings();
}

function applyCustomBg() {
    const el = document.getElementById('custom-bg');
    if (customBgPath && fs.existsSync(customBgPath)) {
        el.style.backgroundImage = `url("file:///${customBgPath.replace(/\\/g, '/')}")`;
        el.classList.remove('hidden');
    } else {
        el.classList.add('hidden');
    }
}

function applyCustomVideo() {
    const vid = document.getElementById('custom-video');
    if (customVideoPath && fs.existsSync(customVideoPath)) {
        vid.src = `file:///${customVideoPath.replace(/\\/g, '/')}`;
        vid.muted = !videoSoundEnabled;
        vid.volume = videoVolume;
        vid.classList.remove('hidden');
        vid.play().catch(() => {});
    } else {
        vid.classList.add('hidden');
        vid.pause();
    }
}

async function loadHeadImage(avatar, name) {
    const cacheKey = 'avatar_' + name.toLowerCase();
    let dataUrl = localStorage.getItem(cacheKey);
    if (!dataUrl || !dataUrl.startsWith('data:image/')) {
        dataUrl = await ipcRenderer.invoke('avatar-fetch', name);
        if (dataUrl) { try { localStorage.setItem(cacheKey, dataUrl); } catch {} }
    }
    avatar.onerror = () => { avatar.style.display = 'none'; };
    if (dataUrl && dataUrl.startsWith('data:image/')) { avatar.src = dataUrl; avatar.style.display = 'block'; }
    else avatar.style.display = 'none';
}

function updateProfile() {
    const offlineName = document.getElementById('username-input').value.trim() || 'Player';
    const name = msUsername || offlineName;
    document.getElementById('titlebar-profile-name').textContent = name;
    const avatar = document.getElementById('titlebar-avatar');
    if (name && name !== 'Player') loadHeadImage(avatar, name);
    else { avatar.removeAttribute('src'); avatar.style.display = 'none'; }
}

// ═══════════════ VERSION PANEL ═══════════════
function initVersionPanel() {
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentVersionFilter = btn.dataset.filter;
            renderVersions();
        });
    });

    const trigger = document.getElementById('loader-trigger');
    const dropdown = document.getElementById('loader-dropdown');
    trigger.addEventListener('click', (e) => { e.stopPropagation(); dropdown.classList.toggle('open'); });
    document.addEventListener('click', () => dropdown.classList.remove('open'));
    document.querySelectorAll('#loader-dropdown .select-option').forEach(opt => {
        opt.addEventListener('click', () => {
            selectedLoader = opt.dataset.value;
            trigger.textContent = opt.textContent;
            dropdown.querySelectorAll('.select-option').forEach(o => o.classList.remove('active'));
            opt.classList.add('active');
            dropdown.classList.remove('open');
            const supported = selectedLoader !== 'vanilla' ? loaderSupport[selectedLoader] : null;
            if (supported && supported.length && !supported.includes(selectedVersion)) {
                const first = allVersions.find(v => supported.includes(v.id) &&
                    (currentVersionFilter === 'all' || v.type === currentVersionFilter));
                if (first) selectedVersion = first.id;
            }
            renderVersions();
            updateHomeStats();
            checkJava();
            saveSettings();
        });
    });
    trigger.textContent = document.querySelector(`#loader-dropdown .select-option[data-value="${selectedLoader}"]`)?.textContent || 'Vanilla';

    document.getElementById('ram-minus').onclick = () => { ram = Math.max(1, ram - 1); updateRamDisplay(); };
    document.getElementById('ram-plus').onclick = () => { ram = Math.min(32, ram + 1); updateRamDisplay(); };
    updateRamDisplay();
    document.getElementById('btn-manage-version').onclick = () => showPanel('versions');
}

function updateRamDisplay() {
    document.getElementById('ram-display').textContent = `${ram} GB`;
    document.getElementById('settings-ram-display').textContent = `${ram} GB`;
    document.getElementById('stat-ram').textContent = `${ram} GB`;
    saveSettings();
}

function renderVersions() {
    const grid = document.getElementById('version-grid');
    const instList = document.getElementById('installed-list');
    const filter = currentVersionFilter;
    if (filter === 'installed') {
        grid.classList.add('hidden');
        instList.classList.remove('hidden');
        if (!installedVersions.length) loadInstalled();
        else renderInstalled();
        return;
    }
    grid.classList.remove('hidden');
    instList.classList.add('hidden');
    if (!allVersions.length) {
        grid.innerHTML = `<div class="mod-empty">${VI.t('versions.loading')}</div>`;
        return;
    }
    let filtered = allVersions.filter(v => filter === 'all' || v.type === filter);
    const supported = selectedLoader !== 'vanilla' ? loaderSupport[selectedLoader] : null;
    if (supported && supported.length) {
        const set = new Set(supported);
        filtered = filtered.filter(v => set.has(v.id));
    }
    grid.innerHTML = '';
    if (!filtered.length) {
        grid.innerHTML = `<div class="mod-empty">${VI.t('versions.none', { loader: selectedLoader, filter: filter === 'all' ? 'range' : filter })}</div>`;
        return;
    }
    for (const v of filtered) {
        const item = document.createElement('div');
        item.className = `version-item${v.id === selectedVersion ? ' active' : ''}`;
        let badge;
        if (v.type === 'snapshot') badge = '<span class="ver-badge snapshot">SNAPSHOT</span>';
        else if (v.type === 'old_beta') badge = '<span class="ver-badge beta">BETA</span>';
        else if (v.type === 'old_alpha') badge = '<span class="ver-badge alpha">ALPHA</span>';
        else badge = '<span class="ver-type">Release</span>';
        item.innerHTML = `<div class="ver-id">${v.id}</div>${badge}`;
        item.onclick = () => {
            selectedVersion = v.id;
            grid.querySelectorAll('.version-item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            updateHomeStats();
            checkJava();
            saveSettings();
        };
        grid.appendChild(item);
    }
}

async function loadVersions() {
    try {
        allVersions = await ipcRenderer.invoke('get-versions');
        loaderSupport = await ipcRenderer.invoke('get-loader-game-versions').catch(() => loaderSupport);
        renderVersions();
        renderModFilterVersions();
        updateHomeStats();
    } catch {}
}

function updateHomeStats() {
    document.getElementById('stat-version').textContent = selectedVersion;
    document.getElementById('stat-loader').textContent = selectedLoader.charAt(0).toUpperCase() + selectedLoader.slice(1);
    document.getElementById('stat-ram').textContent = `${ram} GB`;
    document.getElementById('build-title').textContent = selectedVersion;
    document.getElementById('build-sub').textContent = selectedLoader.charAt(0).toUpperCase() + selectedLoader.slice(1);
}

// ═══════════════ JAVA ═══════════════
async function checkJava() {
    const detected = await ipcRenderer.invoke('find-java');
    javaPath = detected;
    const info = await ipcRenderer.invoke('check-java-version', detected);
    javaVersion = info.version || 0;
    const javaName = javaPath ? VI.t('settings.javaShort', { v: javaVersion || '?' }) : VI.t('settings.notFound');
    document.getElementById('stat-java').textContent = javaName;
    document.getElementById('settings-java-info').textContent = javaPath || VI.t('settings.notFound');
    document.getElementById('settings-java-version').textContent = javaVersion ? VI.t('settings.javaShort', { v: javaVersion }) : '—';
    document.getElementById('java-path-display').textContent = javaPath || VI.t('settings.autoDetect');

    const required = getRequiredJava(selectedVersion);
    if (javaVersion > 0 && javaVersion < required) showJavaWarning(required);
    else hideJavaWarning();
}

function getRequiredJava(mcVersion) {
    const parts = (mcVersion || '').split('.');
    const minor = parseInt(parts[1]) || 0;
    if (minor >= 21) return 21;
    if (minor >= 17) return 17;
    if (minor >= 16) return 16;
    return 8;
}

function showJavaWarning(required) {
    let el = document.querySelector('.java-warning');
    if (!el) {
        el = document.createElement('div');
        el.className = 'java-warning';
        el.innerHTML = `<strong>${VI.t('java.warning')}</strong><br>${VI.t('java.req', { req: required, cur: javaVersion })}.
            <a href="https://adoptium.net/" target="_blank" style="color:#ff8888;text-decoration:underline;">${VI.t('java.download', { req: required })}</a>`;
        document.getElementById('home-status').appendChild(el);
    }
    el.classList.add('visible');
}
function hideJavaWarning() { document.querySelector('.java-warning')?.classList.remove('visible'); }

// ═══════════════ CUSTOM SELECTS ═══════════════
function csOptionsHTML(select) {
    let html = '';
    [...select.children].forEach(child => {
        if (child.tagName === 'OPTGROUP') {
            html += `<div class="select-group">${escapeHtml(child.label)}</div>`;
            [...child.options].forEach(opt => {
                html += `<div class="select-option${opt.selected ? ' active' : ''}" data-value="${escapeHtml(opt.value)}">${escapeHtml(opt.textContent)}</div>`;
            });
        } else if (child.tagName === 'OPTION') {
            html += `<div class="select-option${child.selected ? ' active' : ''}" data-value="${escapeHtml(child.value)}">${escapeHtml(child.textContent)}</div>`;
        }
    });
    return html;
}

function initCustomSelect(select) {
    if (!select || select.dataset.csReady) return;
    select.dataset.csReady = '1';
    select.classList.add('cs-hidden');
    const wrapper = document.createElement('div');
    wrapper.className = 'custom-select';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'select-trigger';
    const dropdown = document.createElement('div');
    dropdown.className = 'select-dropdown';
    select.parentNode.insertBefore(wrapper, select);
    wrapper.appendChild(trigger);
    wrapper.appendChild(dropdown);
    wrapper.appendChild(select);

    const build = () => { dropdown.innerHTML = csOptionsHTML(select); };
    const sync = () => {
        const cur = select.options[select.selectedIndex];
        if (cur) trigger.textContent = cur.textContent;
        dropdown.querySelectorAll('.select-option').forEach(o => o.classList.toggle('active', o.dataset.value === select.value));
    };

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasOpen = dropdown.classList.contains('open');
        document.querySelectorAll('.custom-select .select-dropdown').forEach(d => d.classList.remove('open'));
        if (!wasOpen) dropdown.classList.add('open');
    });
    document.addEventListener('click', () => dropdown.classList.remove('open'));
    dropdown.addEventListener('click', (e) => {
        const opt = e.target.closest('.select-option');
        if (!opt) return;
        select.value = opt.dataset.value;
        dropdown.classList.remove('open');
        select.dispatchEvent(new Event('change'));
        sync();
    });
    build();
    sync();
}

function resyncCustomSelect(id) {
    const select = document.getElementById(id);
    if (!select || !select.dataset.csReady) return;
    const cs = select.closest('.custom-select');
    if (!cs) return;
    const dropdown = cs.querySelector('.select-dropdown');
    const trigger = cs.querySelector('.select-trigger');
    if (dropdown) {
        dropdown.innerHTML = csOptionsHTML(select);
    }
    const cur = select.options[select.selectedIndex];
    if (trigger && cur) trigger.textContent = cur.textContent;
}

function resyncAllCustomSelects() {
    document.querySelectorAll('.custom-select select.cs-hidden').forEach(s => resyncCustomSelect(s.id));
}

function initCustomModSelects() {
    ['mod-type-select', 'mod-loader-select', 'mod-version-select', 'mod-sort-select'].forEach(id => initCustomSelect(document.getElementById(id)));
}

// ═══════════════ MODS PANEL ═══════════════
let modOffset = 0;
let modTotal = 0;
const MOD_PAGE = 20;

function initModsPanel() {
    document.getElementById('btn-mod-search').onclick = () => searchMods();
    document.getElementById('mod-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchMods(); });
    document.getElementById('btn-refresh-mods').onclick = loadInstalledMods;
    document.getElementById('btn-mod-prev').onclick = () => runModSearch({ page: Math.max(1, Math.floor(modOffset / MOD_PAGE)), reset: false });
    document.getElementById('btn-mod-next').onclick = () => runModSearch({ page: Math.floor(modOffset / MOD_PAGE) + 2, reset: false });
    ['mod-type-select', 'mod-loader-select', 'mod-version-select', 'mod-sort-select'].forEach(id => {
        document.getElementById(id).addEventListener('change', () => searchMods());
    });
    const loaderSel = document.getElementById('mod-loader-select');
    if (selectedLoader && selectedLoader !== 'vanilla') loaderSel.value = selectedLoader;
    initModDrawer();
    initCustomModSelects();
    searchMods();
    loadInstalledMods();
}

function renderModFilterVersions() {
    const sel = document.getElementById('mod-version-select');
    if (!sel || !allVersions.length) return;
    sel.innerHTML = '<option value="any" data-i18n="mods.anyVersion">' + VI.t('mods.anyVersion') + '</option>';
    const groups = [
        { label: VI.t('filter.release'), types: ['release'] },
        { label: VI.t('filter.snapshot'), types: ['snapshot'] },
        { label: VI.t('filter.beta'), types: ['old_beta'] },
        { label: VI.t('filter.alpha'), types: ['old_alpha'] },
    ];
    for (const g of groups) {
        const list = allVersions.filter(v => v && v.id && g.types.includes(v.type));
        if (!list.length) continue;
        const og = document.createElement('optgroup');
        og.label = g.label;
        for (const v of list) {
            const o = document.createElement('option');
            o.value = v.id;
            o.textContent = v.id;
            og.appendChild(o);
        }
        sel.appendChild(og);
    }
    const current = selectedVersion && [...sel.options].some(o => o.value === selectedVersion) ? selectedVersion : 'any';
    sel.value = current;
    resyncCustomSelect('mod-version-select');
}

async function loadInstalledMods() {
    const container = document.getElementById('installed-mods-list');
    const mods = await ipcRenderer.invoke('list-installed-mods', { gameDir });
    if (!mods.length) { container.innerHTML = `<div class="mod-empty">${VI.t('mods.noInstalled')}</div>`; return; }
    container.innerHTML = '';
    for (const mod of mods) {
        const row = document.createElement('div');
        row.className = 'mod-installed-row';
        const sizeMB = (mod.size / (1024 * 1024)).toFixed(1);
        row.innerHTML = `
            <div class="mod-installed-info">
                <span class="mod-installed-name">${mod.filename}</span>
                <span class="mod-installed-size">${sizeMB} MB</span>
            </div>
            <button class="btn-secondary btn-danger btn-delete-mod" data-file="${mod.filename}">${VI.t('mods.delete')}</button>`;
        row.querySelector('.btn-delete-mod').onclick = async (e) => {
            const file = e.target.dataset.file;
            e.target.textContent = '...';
            e.target.disabled = true;
            const result = await ipcRenderer.invoke('delete-mod', { gameDir, filename: file });
            if (result.success) { showToast(VI.t('mods.deleted', { file }), 'success'); loadInstalledMods(); }
            else { showToast(result.error || VI.t('mods.deleteFailed'), 'error'); e.target.textContent = VI.t('mods.delete'); e.target.disabled = false; }
        };
        container.appendChild(row);
    }
}

function searchMods() { runModSearch({ page: 1, reset: true }); }

async function runModSearch({ page = 1, reset = false }) {
    const query = document.getElementById('mod-search').value.trim();
    const type = document.getElementById('mod-type-select').value;
    const loader = document.getElementById('mod-loader-select').value;
    const version = document.getElementById('mod-version-select').value;
    const index = document.getElementById('mod-sort-select').value;
    const container = document.getElementById('mod-results');

    modOffset = (page - 1) * MOD_PAGE;
    if (reset) container.innerHTML = `<div class="mod-empty">${VI.t('mods.loading')}</div>`;

    const data = await ipcRenderer.invoke('modrinth-search', {
        query, type,
        loader: loader === 'any' ? '' : loader,
        version: version === 'any' ? '' : version,
        index, limit: MOD_PAGE, offset: modOffset
    });
    const results = data.results || [];
    modTotal = data.total || 0;

    if (!results.length) {
        if (reset) container.innerHTML = `<div class="mod-empty">${VI.t('mods.nothing')}</div>`;
        updateModPager(page);
        return;
    }

    container.innerHTML = '';
    appendModCards(results, { type, loader, version });
    updateModPager(page);
}

function updateModPager(page) {
    const pager = document.getElementById('mod-pager');
    const totalPages = Math.max(1, Math.ceil(modTotal / MOD_PAGE));
    document.getElementById('mod-pager-info').textContent = VI.t('pager.page', { p: page, total: totalPages });
    document.getElementById('btn-mod-prev').disabled = page <= 1;
    document.getElementById('btn-mod-next').disabled = page >= totalPages || modTotal === 0;
    pager.classList.toggle('hidden', modTotal === 0);
}

function appendModCards(mods, ctx) {
    const container = document.getElementById('mod-results');
    for (const mod of mods) {
        const card = document.createElement('div');
        card.className = 'mod-card';
        card.innerHTML = `
            <img class="mod-icon" src="${mod.icon_url || ''}" onerror="this.style.display='none'" alt="">
            <div class="mod-info">
                <div class="mod-title">${mod.title}</div>
                <div class="mod-author">${VI.t('mods.by', { author: mod.author })}</div>
                <div class="mod-desc">${mod.description || ''}</div>
                <div class="mod-actions">
                    <button class="btn-secondary btn-install" data-project="${mod.project_id || mod.slug}" data-type="${ctx.type}">${VI.t('mods.install')}</button>
                    <span class="mod-dl">${(mod.downloads || 0).toLocaleString()} ${VI.t('mods.downloads')}</span>
                </div>
            </div>`;
        card.addEventListener('click', () => openModDrawer(mod.project_id || mod.slug));
        card.querySelector('.btn-install').onclick = async (e) => {
            e.stopPropagation();
            const btn = e.target;
            const projType = btn.dataset.type;
            const ver = ctx.version === 'any' ? selectedVersion : ctx.version;
            const ld = (projType === 'mod' || projType === 'plugin') && ctx.loader !== 'any' ? ctx.loader : '';
            btn.textContent = VI.t('mods.loadingBtn'); btn.disabled = true;
            const versions = await ipcRenderer.invoke('modrinth-versions', { projectId: btn.dataset.project, loader: ld, mcVersion: ver });
            if (!versions.length) { btn.textContent = VI.t('mods.noVersions'); btn.disabled = false; return; }
            const file = versions[0].files[0];
            if (!file) { btn.textContent = VI.t('mods.noFile'); btn.disabled = false; return; }
            btn.textContent = VI.t('mods.installing');
            const targetMap = { mod: 'mods', plugin: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks', datapack: 'datapacks' };
            const target = targetMap[projType] || 'downloads';
            const result = await ipcRenderer.invoke('install-mod', { fileUrl: file.url, filename: file.filename, gameDir, target });
            if (result.success) {
                btn.outerHTML = `<span class="mod-installed">${target === 'mods' ? VI.t('mods.installedTag') : VI.t('mods.downloadedTag')}</span>`;
                showToast(target === 'mods' ? VI.t('mods.installedMsg', { name: versions[0].name }) : VI.t('mods.downloaded', { name: versions[0].name, target }), 'success');
                if (target === 'mods') loadInstalledMods();
            } else { btn.textContent = VI.t('mods.error'); btn.disabled = false; showToast(result.error || VI.t('mods.installFailed'), 'error'); }
        };
        container.appendChild(card);
    }
}

// ═══════════════ MODRINTH DETAILS DRAWER ═══════════════
function initModDrawer() {
    document.getElementById('btn-close-mod-drawer').onclick = closeModDrawer;
    document.getElementById('mod-drawer-overlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeModDrawer(); });
    const lb = document.getElementById('mod-lightbox');
    lb.addEventListener('click', () => lb.classList.add('hidden'));
    const gal = document.getElementById('mod-drawer-gallery');
    document.getElementById('gal-prev').onclick = () => gal.scrollBy({ left: -gal.clientWidth * 0.8, behavior: 'smooth' });
    document.getElementById('gal-next').onclick = () => gal.scrollBy({ left: gal.clientWidth * 0.8, behavior: 'smooth' });
}

function closeModDrawer() { document.getElementById('mod-drawer-overlay').classList.add('hidden'); }

async function openModDrawer(projectId) {
    const overlay = document.getElementById('mod-drawer-overlay');
    document.getElementById('mod-drawer-title').textContent = VI.t('mods.drawer.title');
    document.getElementById('mod-drawer-author').textContent = '';
    const icon = document.getElementById('mod-drawer-icon');
    icon.src = ''; icon.style.display = 'none';
    document.getElementById('mod-drawer-gallery').innerHTML = '';
    document.getElementById('mod-drawer-meta').innerHTML = '';
    document.getElementById('mod-drawer-desc').textContent = VI.t('mods.drawer.loading');
    overlay.classList.remove('hidden');

    const d = await ipcRenderer.invoke('modrinth-detail', { projectId });
    if (!d) {
        document.getElementById('mod-drawer-desc').textContent = VI.t('mods.drawer.failed');
        return;
    }

    document.getElementById('mod-drawer-title').textContent = d.title;
    document.getElementById('mod-drawer-author').textContent = VI.t('mods.by', { author: d.author });
    if (d.icon_url) { icon.src = d.icon_url; icon.style.display = 'block'; }

    const gallery = document.getElementById('mod-drawer-gallery');
    const galPrev = document.getElementById('gal-prev');
    const galNext = document.getElementById('gal-next');
    if (d.gallery && d.gallery.length) {
        gallery.innerHTML = d.gallery.map(g =>
            `<img src="${g.url}" alt="${(g.title || '').replace(/"/g, '&quot;')}" loading="lazy" onerror="this.style.display='none'">`
        ).join('');
        gallery.querySelectorAll('img').forEach(img => img.addEventListener('click', () => {
            document.getElementById('mod-lightbox-img').src = img.src;
            document.getElementById('mod-lightbox').classList.remove('hidden');
        }));
        galPrev.classList.remove('hidden');
        galNext.classList.remove('hidden');
    } else {
        gallery.innerHTML = '';
        galPrev.classList.add('hidden');
        galNext.classList.add('hidden');
    }

    const tags = []
        .concat(d.categories || [])
        .concat(d.loaders || [])
        .concat(d.game_versions && d.game_versions.length ? ['MC ' + d.game_versions[0]] : [])
        .slice(0, 8)
        .map(t => `<span class="mod-drawer-tag">${t}</span>`)
        .join('');
    const meta = `<span>${VI.t('mods.drawer.downloads', { n: (d.downloads || 0).toLocaleString() })}</span>` +
        `<span>${VI.t('mods.drawer.follows', { n: (d.follows || 0).toLocaleString() })}</span>` +
        (tags ? `<span>${tags}</span>` : '');
    document.getElementById('mod-drawer-meta').innerHTML = meta;
    document.getElementById('mod-drawer-desc').textContent = mdToText(d.body && d.body.trim() ? d.body : d.description);
}

function mdToText(md) {
    return (md || '')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/(#{1,6}\s*)/g, '')
        .replace(/\*\*([^*]*)\*\*/g, '$1')
        .replace(/\*([^*]*)\*/g, '$1')
        .replace(/^>\s?/gm, '')
        .replace(/^\s*[-*+]\s+/gm, '\u2022 ')
        .replace(/^\s*\d+\.\s+/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ═══════════════ SETTINGS PANEL ═══════════════
function applySettingsBlockOrder() {
    if (!settingsBlocksOrder || !settingsBlocksOrder.length) return;
    const grid = document.getElementById('settings-grid');
    const byId = new Map([...grid.querySelectorAll('.settings-card')].map(c => [c.dataset.block, c]));
    for (const id of settingsBlocksOrder) {
        const card = byId.get(id);
        if (card) grid.appendChild(card);
    }
}

function setSettingsDragMode(editing) {
    const grid = document.getElementById('settings-grid');
    grid.classList.toggle('drag-editing', editing);
    const btn = document.getElementById('btn-edit-settings');
    btn.textContent = editing ? VI.t('settings.done') : VI.t('settings.edit');
    grid.querySelectorAll('.settings-card').forEach(card => {
        card.draggable = editing;
        card.classList.toggle('drag-sortable', editing);
    });
    if (!editing) saveSettings();
}

function initSettingsPanel() {
    applySettingsBlockOrder();

    const editBtn = document.getElementById('btn-edit-settings');
    editBtn.onclick = () => setSettingsDragMode(!document.getElementById('settings-grid').classList.contains('drag-editing'));

    const sGrid = document.getElementById('settings-grid');
    const settingsFlipPrev = new Map();
    const captureSettingsPositions = () => {
        settingsFlipPrev.clear();
        sGrid.querySelectorAll('.settings-card').forEach(c => settingsFlipPrev.set(c, c.getBoundingClientRect()));
    };
    const playSettingsFlip = (exclude) => {
        sGrid.querySelectorAll('.settings-card').forEach(c => {
            if (c === exclude) return;
            const r1 = settingsFlipPrev.get(c);
            if (!r1) return;
            const r2 = c.getBoundingClientRect();
            const dx = r1.left - r2.left, dy = r1.top - r2.top;
            if (!dx && !dy) return;
            c.style.transition = 'none';
            c.style.transform = `translate(${dx}px, ${dy}px)`;
            void c.offsetWidth;
            c.style.transition = 'transform 0.3s cubic-bezier(.22,.61,.36,1)';
            c.style.transform = '';
        });
    };
    sGrid.addEventListener('dragstart', e => {
        const card = e.target.closest('.settings-card');
        if (!card) return;
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', card.dataset.block); } catch {}
    });
    sGrid.addEventListener('dragover', e => {
        e.preventDefault();
        const dragging = sGrid.querySelector('.settings-card.dragging');
        if (!dragging) return;
        const target = e.target.closest('.settings-card');
        if (!target || target === dragging) return;
        const rect = target.getBoundingClientRect();
        const after = e.clientX > rect.left + rect.width / 2;
        if ((after && dragging.previousElementSibling === target) || (!after && dragging.nextElementSibling === target)) return;
        const ref = after ? target.nextSibling : target;
        if (ref === dragging) return;
        if (after && !ref) return;
        captureSettingsPositions();
        sGrid.insertBefore(dragging, ref);
        playSettingsFlip(dragging);
    });
    sGrid.addEventListener('dragend', () => {
        sGrid.querySelectorAll('.settings-card').forEach(c => {
            c.classList.remove('dragging');
            c.style.transform = '';
            c.style.transition = '';
        });
        settingsBlocksOrder = [...sGrid.querySelectorAll('.settings-card')].map(c => c.dataset.block);
        saveSettings();
    });

    document.getElementById('btn-open-folder').onclick = async () => {
        const res = await ipcRenderer.invoke('open-game-folder', gameDir);
        if (!res || res.error) showToast(VI.t('settings.couldNotOpen'), 'error');
    };

    document.getElementById('btn-select-dir').onclick = async () => {
        const dir = await ipcRenderer.invoke('select-directory');
        if (dir) { gameDir = dir; document.getElementById('game-dir-display').textContent = dir; saveSettings(); }
    };
    document.getElementById('btn-select-java').onclick = async () => {
        const exe = await ipcRenderer.invoke('select-java-exe');
        if (exe) { javaPath = exe; document.getElementById('java-path-display').textContent = exe; saveSettings(); await checkJava(); }
    };
    document.getElementById('settings-ram-minus').onclick = () => { ram = Math.max(1, ram - 1); updateRamDisplay(); };
    document.getElementById('settings-ram-plus').onclick = () => { ram = Math.min(32, ram + 1); updateRamDisplay(); };

    const jvmEl = document.getElementById('txt-jvm-args');
    jvmEl.value = jvmArgs;
    jvmEl.addEventListener('input', () => { jvmArgs = jvmEl.value; saveSettings(); });

    // Image/GIF background
    document.getElementById('btn-select-bg').onclick = async () => {
        const img = await ipcRenderer.invoke('select-image');
        if (img) { customBgPath = img; applyCustomBg(); saveSettings(); showToast(VI.t('settings.bgSet'), 'success'); }
    };
    document.getElementById('btn-clear-bg').onclick = () => {
        customBgPath = null; applyCustomBg(); saveSettings();
    };

    // Video background
    document.getElementById('btn-select-video').onclick = async () => {
        const vid = await ipcRenderer.invoke('select-video');
        if (vid) { customVideoPath = vid; applyCustomBg(); applyCustomVideo(); saveSettings(); showToast(VI.t('settings.videoSet'), 'success'); }
    };
    document.getElementById('btn-clear-video').onclick = () => {
        customVideoPath = null;
        const vidEl = document.getElementById('custom-video');
        vidEl.classList.add('hidden'); vidEl.pause(); vidEl.src = '';
        saveSettings();
    };

    document.getElementById('game-dir-display').textContent = gameDir;

    // Video volume
    const volEl = document.getElementById('rng-video-volume');
    const volVal = document.getElementById('val-video-volume');
    volEl.value = Math.round(videoVolume * 100);
    volVal.textContent = volEl.value + '%';
    volEl.addEventListener('input', () => {
        videoVolume = parseInt(volEl.value, 10) / 100;
        volVal.textContent = volEl.value + '%';
        const vid = document.getElementById('custom-video');
        if (vid) {
            vid.volume = videoVolume;
            if (videoVolume > 0) vid.muted = !videoSoundEnabled;
        }
        saveSettings();
    });
}

// ═══════════════ CUSTOMIZE MODAL ═══════════════
function initCustomizeModal() {
    const modal = document.getElementById('customize-modal');
    document.getElementById('btn-close-customize').onclick = () => modal.classList.add('hidden');
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });

    // Color pickers
    const colorMap = {
        'clr-accent': 'accent', 'clr-bg': 'bg', 'clr-text': 'text',
        'clr-text-dim': 'textDim', 'clr-border': 'border', 'clr-glass': 'glass', 'clr-sidebar': 'sidebar'
    };
    for (const [id, key] of Object.entries(colorMap)) {
        const el = document.getElementById(id);
        el.value = theme[key];
        el.addEventListener('input', () => { theme[key] = el.value; applyTheme(); saveSettings(); });
    }

    // Sliders
    const sliderMap = {
        'rng-blur': ['glassBlur', 'val-blur', 'px'],
        'rng-particle-opacity': ['particleOpacity', 'val-particle-opacity', '%'],
        'rng-sidebar-blur': ['sidebarBlur', 'val-sidebar-blur', 'px'],
        'rng-mod-card-blur': ['modCardBlur', 'val-mod-card-blur', 'px'],
    };
    for (const [id, [key, valId, unit]] of Object.entries(sliderMap)) {
        const el = document.getElementById(id);
        const valEl = document.getElementById(valId);
        el.value = theme[key];
        valEl.textContent = theme[key] + unit;
        el.addEventListener('input', () => { theme[key] = parseInt(el.value); valEl.textContent = el.value + unit; applyTheme(); saveSettings(); });
    }

    // Effect buttons
    document.querySelectorAll('.effect-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.effect-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentEffect = btn.dataset.effect;
            safeStartParticles();
            saveSettings();
        });
    });
    document.querySelectorAll('.effect-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`.effect-btn[data-effect="${currentEffect}"]`)?.classList.add('active');

    // Presets
    const presets = {
        midnight: { accent: '#7b68ee', bg: '#0a0a1a', text: '#e0e0ff', textDim: '#5555aa', border: '#1a1a3a', glass: '#0d0d2a', sidebar: '#0d0d2a', glassBlur: 20, particleOpacity: 55, sidebarBlur: 24 },
        neon: { accent: '#00ff88', bg: '#000000', text: '#00ff88', textDim: '#006633', border: '#003318', glass: '#001a0d', sidebar: '#001a0d', glassBlur: 16, particleOpacity: 70, sidebarBlur: 20 },
        arctic: { accent: '#88ccff', bg: '#0a1520', text: '#ccddff', textDim: '#446688', border: '#152535', glass: '#0c1a28', sidebar: '#0c1a28', glassBlur: 24, particleOpacity: 50, sidebarBlur: 28 },
        sunset: { accent: '#ff6b35', bg: '#1a0a05', text: '#ffddcc', textDim: '#885533', border: '#3a1a0a', glass: '#200e06', sidebar: '#200e06', glassBlur: 18, particleOpacity: 55, sidebarBlur: 22 },
        void: { accent: '#ffffff', bg: '#050505', text: '#ffffff', textDim: '#666666', border: '#141414', glass: '#0a0a0a', sidebar: '#0a0a0a', glassBlur: 20, particleOpacity: 60, sidebarBlur: 24 },
    };
    document.querySelectorAll('.preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const p = presets[btn.dataset.preset];
            theme = { ...presets.void, ...(p || {}), modCardBlur: theme.modCardBlur ?? 14 };
            refreshCustomizeUI();
            applyTheme();
            saveSettings();
            showToast(VI.t('cust.presetMsg', { name: btn.textContent }), 'success');
        });
    });
}

function refreshCustomizeUI() {
    const colorMap = { 'clr-accent': 'accent', 'clr-bg': 'bg', 'clr-text': 'text', 'clr-text-dim': 'textDim', 'clr-border': 'border', 'clr-glass': 'glass', 'clr-sidebar': 'sidebar' };
    for (const [id, key] of Object.entries(colorMap)) { document.getElementById(id).value = theme[key]; }
    document.getElementById('rng-blur').value = theme.glassBlur; document.getElementById('val-blur').textContent = theme.glassBlur + 'px';
    document.getElementById('rng-particle-opacity').value = theme.particleOpacity; document.getElementById('val-particle-opacity').textContent = theme.particleOpacity + '%';
    document.getElementById('rng-sidebar-blur').value = theme.sidebarBlur; document.getElementById('val-sidebar-blur').textContent = theme.sidebarBlur + 'px';
    document.getElementById('rng-mod-card-blur').value = theme.modCardBlur; document.getElementById('val-mod-card-blur').textContent = theme.modCardBlur + 'px';
}

function applyTheme() {
    const r = document.documentElement.style;
    r.setProperty('--accent', theme.accent);
    r.setProperty('--bg', theme.bg);
    r.setProperty('--text', theme.text);
    r.setProperty('--text-dim', theme.textDim);
    r.setProperty('--text-mid', theme.textDim + 'aa');
    r.setProperty('--glass-border', theme.border);
    r.setProperty('--glass', theme.glass);
    r.setProperty('--surface', theme.glass + '88');
    r.setProperty('--surface-hover', theme.glass + 'cc');
    r.setProperty('--surface-active', theme.glass + 'ee');
    r.setProperty('--accent-dim', theme.accent + '22');
    r.setProperty('--glass-blur', theme.glassBlur + 'px');
    r.setProperty('--particle-opacity', theme.particleOpacity / 100);
    r.setProperty('--sidebar-blur', theme.sidebarBlur + 'px');
    r.setProperty('--mod-card-blur', (theme.modCardBlur ?? 14) + 'px');
    document.querySelector('.bottom-nav').style.background = hexToRgba(theme.sidebar, 0.8);
}

function hexToRgba(hex, a) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${a})`;
}

// ═══════════════ LOG VIEWER ═══════════════
async function initLogButton() {
    document.getElementById('btn-open-log').onclick = async () => {
        const logPath = await ipcRenderer.invoke('get-log-path');
        if (logPath) { require('electron').shell.showItemInFolder(logPath); }
    };
}

// ═══════════════ MICROSOFT AUTH ═══════════════
function initMicrosoftAuth() {
    // Point the vault at the active gameDir (persisted by the time we init)
    ipcRenderer.invoke('msa-configure', { gameDir });

    document.getElementById('auth-mode-offline').onclick = () => setAuthMode('offline');
    document.getElementById('auth-mode-microsoft').onclick = () => setAuthMode('microsoft');

    document.getElementById('btn-close-ms-login').onclick = closeMSLogin;
    document.getElementById('ms-login-modal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeMSLogin(); });

    setAuthMode(authMode);
    refreshMSStatus();
}

function setAuthMode(mode) {
    authMode = mode;
    document.getElementById('auth-mode-offline').classList.toggle('active', mode === 'offline');
    document.getElementById('auth-mode-microsoft').classList.toggle('active', mode === 'microsoft');
    document.getElementById('auth-offline-box').classList.toggle('hidden', mode !== 'offline');
    document.getElementById('auth-ms-box').classList.toggle('hidden', mode !== 'microsoft');
    saveSettings();
}

async function refreshMSStatus(opts = {}) {
    const st = await ipcRenderer.invoke('msa-status');
    const nameEl = document.getElementById('ms-account-name');
    const subEl = document.getElementById('ms-account-sub');
    const btnLogin = document.getElementById('btn-ms-login');
    const btnLogout = document.getElementById('btn-ms-logout');
    const justSigned = !!opts.justLoggedIn && !!st.signedIn;

    if (!st.configured) {
        nameEl.textContent = 'Not configured';
        subEl.textContent = st.error || 'Set VOID_MSA_CLIENT_ID or MICROSOFT_CLIENT_ID in src/microsoft-auth.js';
        btnLogin.classList.add('hidden'); btnLogout.classList.add('hidden');
        lastMsSignedIn = false;
        return;
    }
    if (st.signedIn) {
        msUsername = st.username;
        nameEl.textContent = st.username;
        subEl.textContent = VI.t('ms.signedInSub');
        btnLogin.classList.add('hidden');
        btnLogout.classList.remove('hidden');
        btnLogout.onclick = async () => {
            await ipcRenderer.invoke('msa-logout');
            msUsername = null; lastMsSignedIn = false; refreshMSStatus(); showToast(VI.t('play.signedOut'), 'success');
        };
        if (justSigned) {
            const card = document.getElementById('ms-account');
            card.classList.remove('just-signed');
            void card.offsetWidth;
            card.classList.add('just-signed');
            if (msFlashT) clearTimeout(msFlashT);
            msFlashT = setTimeout(() => card.classList.remove('just-signed'), 1800);
        }
    } else {
        msUsername = null;
        nameEl.textContent = VI.t('ms.notSignedIn');
        subEl.textContent = VI.t('ms.sub');
        btnLogout.classList.add('hidden');
        btnLogin.classList.remove('hidden');
        btnLogin.onclick = startMSLogin;
    }
    lastMsSignedIn = st.signedIn;
    updateProfile();
}

function startMSLogin() { _startMSLoginImpl(); }

let loginSession = 0;

async function _startMSLoginImpl() {
    // Invalidate any previously running poll loop (its device_code is stale).
    loginSession++;
    const session = loginSession;
    if (msPollTimer) { clearTimeout(msPollTimer); msPollTimer = null; }

    const st = await ipcRenderer.invoke('msa-login-start');
    if (st.error) { showToast(VI.t('ms.signInFailed', { error: st.error }), 'error'); return; }

    const modal = document.getElementById('ms-login-modal');
    document.getElementById('ms-login-modal').classList.remove('hidden');
    document.getElementById('ms-code-wrap').classList.remove('hidden');
    document.getElementById('ms-code-status').classList.add('hidden');
    document.getElementById('ms-progress-fill').style.width = '0%';
    document.getElementById('ms-code').textContent = st.userCode;
    document.getElementById('ms-uri').href = st.verificationUri;
    document.getElementById('btn-open-ms-page').href = st.verificationUri;
    document.getElementById('ms-modal-hint').textContent = VI.t('ms.hint');

    // Poll for approval
    const interval = Math.max(st.interval || 5, 3);
    const totalMs = (st.expiresIn || 900) * 1000;
    const t0 = Date.now();
    const poll = async () => {
        if (session !== loginSession) return; // stale session, superseded
        const res = await ipcRenderer.invoke('msa-login-poll', st.deviceCode);
        if (session !== loginSession) return;
        const elapsed = Date.now() - t0;
        document.getElementById('ms-progress-fill').style.width = Math.min(100, (elapsed / totalMs) * 100) + '%';
        if (res.success) {
            loginSession++;
            refreshMSStatus({ justLoggedIn: true });
            closeMSLogin();
            showToast(VI.t('play.signedInAs', { name: res.username }), 'success');
            return;
        }
        if (res.error) {
            loginSession++;
            closeMSLogin();
            showToast(VI.t('ms.signInFailed', { error: res.error }), 'error');
            return;
        }
        msPollTimer = setTimeout(poll, (res.slow ? interval + 5 : interval) * 1000);
    };
    msPollTimer = setTimeout(poll, interval * 1000);
}

function closeMSLogin() {
    loginSession++; // invalidate running poll
    if (msPollTimer) { clearTimeout(msPollTimer); msPollTimer = null; }
    document.getElementById('ms-login-modal').classList.add('hidden');
}

// ═══════════════ LAUNCH ═══════════════
document.getElementById('btn-play').onclick = () => playGame();

function playButtonHTML() {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> ${VI.t('play')}`;
}

async function playGame(inst = null) {
    if (authMode === 'microsoft' && !msUsername) {
        showToast(VI.t('play.signInFirst'), 'error');
        startMSLogin();
        return;
    }
    const username = authMode === 'microsoft' ? (msUsername || 'Player') : document.getElementById('username-input').value.trim();
    if (!username) { showToast(VI.t('play.enterUsername'), 'error'); return; }

    const btn = document.getElementById('btn-play');
    btn.disabled = true;
    btn.innerHTML = VI.t('play.downloading');
    showProgress(VI.t('progress.download'), 0);

    let launchVersion = selectedVersion;
    if (!inst) {
        // Install the loader first
        if (selectedLoader !== 'vanilla') {
            showProgress(VI.t('progress.installingLoader', { loader: selectedLoader }), 5);
            const loaderResult = await ipcRenderer.invoke('install-loader', { loader: selectedLoader, mcVersion: selectedVersion, gameDir });
            if (loaderResult.error) {
                showToast(VI.t('loader.installFailed', { error: loaderResult.error }), 'error');
                hideProgress(); btn.disabled = false; btn.innerHTML = playButtonHTML();
                return;
            }
            launchVersion = loaderResult.versionId;
            showToast(VI.t('loader.installed', { loader: selectedLoader, version: launchVersion }), 'success');
        }

        // Download MC files (client jar, vanilla libs, assets)
        showProgress(VI.t('progress.downloadingMc', { version: selectedVersion }), 10);
        const dl = await ipcRenderer.invoke('download-minecraft', { version: selectedVersion, gameDir });
        if (!dl.success) { showToast(dl.error, 'error'); hideProgress(); btn.disabled = false; btn.innerHTML = playButtonHTML(); return; }
    } else {
        launchVersion = inst.id;
    }

    hideProgress();
    btn.innerHTML = VI.t('play.launching');
    showToast(VI.t('launch.launching', { version: launchVersion }), 'success');

    const launch = await ipcRenderer.invoke('launch-game', { version: launchVersion, ram: String(ram), gameDir, username, javaPath, authMode, jvmArgs });
    setTimeout(() => { btn.disabled = false; btn.innerHTML = playButtonHTML(); }, 2000);
    if (!launch.success) showToast(launch.error, 'error');
}

// ═══════════════ INSTALLED VERSIONS ═══════════════
async function loadInstalled() {
    try {
        installedVersions = await ipcRenderer.invoke('list-installed-versions', { gameDir }) || [];
    } catch { installedVersions = []; }
    renderInstalled();
}

function installedMeta(v) {
    const loaderName = v.loader ? v.loader.charAt(0).toUpperCase() + v.loader.slice(1) : 'Vanilla';
    const parts = [loaderName];
    if (v.size != null) parts.push(`${(v.size / 1048576).toFixed(v.size > 1048576 ? 0 : 1)} MB`);
    if (v.id === selectedVersion) parts.push(VI.t('installed.selected'));
    return parts.join(' \u00b7 ');
}

function renderInstalled() {
    const container = document.getElementById('installed-list');
    if (!installedVersions.length) {
        container.innerHTML = `<div class="mod-empty">${VI.t('installed.empty')}</div>`;
        return;
    }
    container.innerHTML = '';
    for (const v of installedVersions) {
        const row = document.createElement('div');
        row.className = 'installed-row' + (v.id === selectedVersion ? ' selected' : '');
        row.innerHTML = `
            <div class="installed-info">
                <div class="installed-name"></div>
                <div class="installed-meta"></div>
            </div>
            <div class="installed-actions">
                <button class="btn-secondary ia-play">${VI.t('installed.play')}</button>
                <button class="btn-secondary ia-reinstall">${VI.t('installed.reinstall')}</button>
                <button class="btn-secondary btn-danger ia-delete">${VI.t('installed.delete')}</button>
            </div>`;
        row.querySelector('.installed-name').textContent = v.id;
        row.querySelector('.installed-meta').textContent = installedMeta(v);
        row.querySelector('.ia-play').onclick = () => playGame(v);
        row.querySelector('.ia-reinstall').onclick = () => reinstallVersion(v);
        row.querySelector('.ia-delete').onclick = () => deleteVersion(v);
        container.appendChild(row);
    }
}

async function reinstallVersion(v) {
    if (!confirm(VI.t('installed.reinstallQ', { id: v.id }))) return;
    showProgress(VI.t('progress.removing'), 2);
    await ipcRenderer.invoke('delete-version', { gameDir, id: v.id });
    showProgress(VI.t('progress.installingLoader', { loader: v.id }), 6);
    const mc = v.mcVersion || v.id;
    if (v.loader && v.loader !== 'vanilla') {
        const r = await ipcRenderer.invoke('install-loader', { loader: v.loader, mcVersion: mc, gameDir });
        if (r.error) { showToast(VI.t('loader.reinstallFailed', { error: r.error }), 'error'); hideProgress(); return; }
    }
    const dl = await ipcRenderer.invoke('download-minecraft', { version: mc, gameDir });
    if (!dl.success) { showToast(dl.error, 'error'); hideProgress(); return; }
    hideProgress();
    showToast(VI.t('installed.reinstalled', { id: v.id }), 'success');
    loadInstalled();
}

async function deleteVersion(v) {
    if (!confirm(VI.t('installed.deleteQ', { id: v.id }))) return;
    const res = await ipcRenderer.invoke('delete-version', { gameDir, id: v.id });
    if (res && res.error) { showToast(res.error, 'error'); return; }
    showToast(VI.t('installed.deleted', { id: v.id }), 'success');
    loadInstalled();
}

// ═══════════════ PROFILES ═══════════════
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderProfiles() {
    const chips = document.getElementById('profile-chips');
    const empty = document.getElementById('profile-empty');
    chips.innerHTML = '';
    if (!profiles.length) { empty.style.display = ''; return; }
    empty.style.display = 'none';
    for (const p of profiles) {
        const chip = document.createElement('div');
        chip.className = 'profile-chip' + (p.version === selectedVersion && p.loader === selectedLoader ? ' active' : '');
        chip.innerHTML = `<span class="pc-name">${escapeHtml(p.name)}</span><span>${escapeHtml(p.version)}</span><button class="pc-del" title="Delete">\u00d7</button>`;
        chip.querySelector('.pc-del').onclick = (e) => { e.stopPropagation(); deleteProfile(p); };
        chip.onclick = () => applyProfile(p);
        chips.appendChild(chip);
    }
}

function applyProfile(p) {
    selectedVersion = p.version;
    selectedLoader = p.loader;
    ram = p.ram || ram;
    javaPath = p.javaPath || null;
    jvmArgs = p.jvmArgs || '';
    updateRamDisplay();
    const jvmEl = document.getElementById('txt-jvm-args');
    if (jvmEl) jvmEl.value = jvmArgs;
    document.getElementById('java-path-display').textContent = javaPath || VI.t('settings.autoDetect');
    document.getElementById('loader-trigger').textContent = p.loader.charAt(0).toUpperCase() + p.loader.slice(1);
    document.querySelectorAll('#loader-dropdown .select-option').forEach(o => o.classList.toggle('active', o.dataset.value === p.loader));
    renderVersions();
    updateHomeStats();
    checkJava();
    renderProfiles();
    saveSettings();
    showToast(VI.t('profile.loaded', { name: p.name }), 'success');
}

function deleteProfile(p) {
    if (!confirm(VI.t('profile.deleteQ', { name: p.name }))) return;
    profiles = profiles.filter(x => x.id !== p.id);
    saveSettings();
    renderProfiles();
}

function openProfilePrompt() {
    const modal = document.getElementById('profile-prompt-modal');
    document.getElementById('profile-name-input').value = '';
    modal.classList.remove('hidden');
    setTimeout(() => document.getElementById('profile-name-input').focus(), 80);
}

function closeProfilePrompt() {
    document.getElementById('profile-prompt-modal').classList.add('hidden');
}

function initProfileControls() {
    document.getElementById('btn-profile-save').onclick = openProfilePrompt;
    document.getElementById('btn-close-profile-prompt').onclick = closeProfilePrompt;
    document.getElementById('btn-profile-cancel').onclick = closeProfilePrompt;
    document.getElementById('btn-profile-ok').onclick = () => {
        const name = document.getElementById('profile-name-input').value.trim();
        if (!name) { showToast(VI.t('profile.nameReq'), 'error'); return; }
        profiles.push({ id: 'p' + Date.now().toString(36), name, version: selectedVersion, loader: selectedLoader, ram, javaPath, jvmArgs });
        saveSettings();
        renderProfiles();
        closeProfilePrompt();
        showToast(VI.t('profile.saved', { name }), 'success');
    };
    const modal = document.getElementById('profile-prompt-modal');
    modal.addEventListener('click', e => { if (e.target === modal) closeProfilePrompt(); });
    document.getElementById('profile-name-input').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('btn-profile-ok').click(); });
}

// ═══════════════ PROGRESS ═══════════════
function showProgress(text, pct) {
    document.getElementById('progress-wrap').classList.remove('hidden');
    document.getElementById('progress-text').textContent = text;
    document.getElementById('progress-fill').style.width = `${pct}%`;
}
function hideProgress() { document.getElementById('progress-wrap').classList.add('hidden'); }
ipcRenderer.on('download-progress', (e, msg) => showProgress(msg.text, msg.progress));
ipcRenderer.on('launch-error', (e, msg) => showToast(msg, 'error'));

function showToast(msg, type = '') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = `toast visible ${type}`;
    clearTimeout(el._timeout);
    el._timeout = setTimeout(() => el.classList.remove('visible'), 4000);
}

// ═══════════════ PARTICLE EFFECTS ═══════════════
let particleRAF = null;
let ditherRipple = () => {};

// ──── STARFIELD: drifting twinkling stars ────
function effectStarfield(ctx, W, H, canvas) {
    const N = Math.max(60, Math.floor((W * H) / 6000));
    const stars = [];
    for (let i = 0; i < N; i++) {
        stars.push({
            x: Math.random() * W, y: Math.random() * H,
            r: Math.random() * 1.4 + 0.3,
            s: Math.random() * 0.35 + 0.05,
            p: Math.random() * Math.PI * 2,
            tw: Math.random() * 0.02 + 0.006
        });
    }
    draw(0);
    function draw() {
        particleRAF = requestAnimationFrame(draw);
        if (!particlesEnabled) { ctx.clearRect(0, 0, W, H); return; }
        ctx.fillStyle = hexToRgba(theme.bg, 0.45);
        ctx.fillRect(0, 0, W, H);
        for (const st of stars) {
            st.y += st.s;
            st.x += st.s * 0.25;
            st.p += st.tw;
            if (st.y > H + 2) { st.y = -2; st.x = Math.random() * W; }
            if (st.x > W + 2) st.x = 0;
            const a = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(st.p));
            ctx.globalAlpha = a;
            ctx.fillStyle = theme.accent;
            ctx.beginPath(); ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalAlpha = 1;
    }
}

// ──── MATRIX RAIN ────
function effectMatrix(ctx, W, H, canvas) {
    const size = 16;
    const cols = Math.max(1, Math.ceil(W / size));
    const drops = [];
    for (let i = 0; i < cols; i++) drops.push(Math.random() * -50);
    const chars = 'アイウエオカキクケコサシスセソタチツテト0123456789ABCDEF$#*';
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, W, H);
    draw();
    function draw() {
        particleRAF = requestAnimationFrame(draw);
        if (!particlesEnabled) { ctx.clearRect(0, 0, W, H); return; }
        ctx.fillStyle = hexToRgba(theme.bg, 0.16);
        ctx.fillRect(0, 0, W, H);
        ctx.font = `${size}px monospace`;
        for (let c = 0; c < cols; c++) {
            const ch = chars[Math.floor(Math.random() * chars.length)];
            ctx.fillStyle = theme.accent;
            ctx.fillText(ch, c * size, drops[c] * size);
            if (drops[c] * size > H && Math.random() > 0.975) drops[c] = 0;
            drops[c]++;
        }
    }
}

// ──── AURORA: flowing gradient ribbons ────
function effectAurora(ctx, W, H, canvas) {
    const bands = 3;
    let t = 0;
    draw();
    function draw() {
        particleRAF = requestAnimationFrame(draw);
        if (!particlesEnabled) { ctx.clearRect(0, 0, W, H); return; }
        t += 0.0045;
        ctx.clearRect(0, 0, W, H);
        ctx.globalCompositeOperation = 'lighter';
        for (let b = 0; b < bands; b++) {
            ctx.beginPath();
            ctx.moveTo(0, H);
            for (let x = 0; x <= W; x += 8) {
                const y = H * (0.30 + 0.22 * b)
                    + Math.sin(x * 0.006 + t * (1.2 + b * 0.4) + b * 2.0) * H * 0.13
                    + Math.sin(x * 0.013 - t * 0.8) * H * 0.05;
                ctx.lineTo(x, y);
            }
            ctx.lineTo(W, H);
            ctx.lineTo(0, H);
            ctx.closePath();
            const g = ctx.createLinearGradient(0, H * 0.2, 0, H);
            g.addColorStop(0, hexToRgba(theme.accent, 0.26 - b * 0.06));
            g.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = g;
            ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
    }
}

// ──── GALAXY: rotating spiral ────
function effectGalaxy(ctx, W, H, canvas) {
    const N = 1000;
    const pts = [];
    const cx = W / 2, cy = H / 2;
    for (let i = 0; i < N; i++) {
        const arm = i % 2;
        const r = Math.pow(Math.random(), 0.7) * Math.min(W, H) * 0.46;
        pts.push({ r, ang: r * 0.24 + arm * Math.PI + Math.random() * 0.5, drift: (Math.random() - 0.5) * 0.08 });
    }
    let rot = 0;
    draw();
    function draw() {
        particleRAF = requestAnimationFrame(draw);
        if (!particlesEnabled) { ctx.clearRect(0, 0, W, H); return; }
        rot += 0.0035;
        ctx.clearRect(0, 0, W, H);
        ctx.globalCompositeOperation = 'lighter';
        for (const p of pts) {
            const a = p.ang + rot + p.drift;
            const x = cx + Math.cos(a) * p.r;
            const y = cy + Math.sin(a) * p.r;
            const tw = 0.35 + 0.65 * Math.abs(Math.sin(a * 3 + rot * 4));
            ctx.globalAlpha = tw;
            ctx.fillStyle = theme.accent;
            ctx.beginPath(); ctx.arc(x, y, 1.1 + p.r * 0.004, 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath(); ctx.arc(cx, cy, 3.2, 0, Math.PI * 2); ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
    }
}

function startParticles() {
    if (particleRAF) cancelAnimationFrame(particleRAF);
    const canvas = document.getElementById('particles');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width = window.innerWidth;
    const H = canvas.height = window.innerHeight;

    if (!particlesEnabled) { if (ctx) ctx.clearRect(0, 0, W, H); return; }

    switch (currentEffect) {
        case 'starfield': effectStarfield(ctx, W, H, canvas); break;
        case 'dither': effectDither(canvas); break;
        case 'matrix': effectMatrix(ctx, W, H, canvas); break;
        case 'aurora': effectAurora(ctx, W, H, canvas); break;
        case 'galaxy': effectGalaxy(ctx, W, H, canvas); break;
        default: effectDither(canvas);
    }

    const dC = document.getElementById('dither-canvas');
    if (currentEffect === 'dither' && dC) { canvas.style.opacity = '0'; dC.classList.remove('hidden'); }
    else if (dC) { canvas.style.opacity = ''; dC.classList.add('hidden'); }
}

function fallbackToDither(canvas) {
    if (particleRAF) cancelAnimationFrame(particleRAF);
    currentEffect = 'dither';
    document.querySelectorAll('.effect-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.effect-btn[data-effect="dither"]')?.classList.add('active');
    effectDither(canvas);
}

function safeStartParticles() {
    try { startParticles(); }
    catch (err) {
        console.error('[effects] failed to start:', currentEffect, err);
        fallbackToDither(document.getElementById('particles'));
    }
}

// ──── DITHER: faithful port of zavalit/bayer-dithering-webgl-demo ────
function effectDither(canvas) {
    let gl = canvas.getContext('webgl2', { alpha: true, antialias: false, premultipliedAlpha: false });
    if (!gl) {
        let dCanvas = document.getElementById('dither-canvas');
        if (!dCanvas) {
            dCanvas = document.createElement('canvas');
            dCanvas.id = 'dither-canvas';
            document.body.appendChild(dCanvas);
        }
        dCanvas.width = window.innerWidth;
        dCanvas.height = window.innerHeight;
        canvas.style.opacity = '0';
        gl = dCanvas.getContext('webgl2', { alpha: true, antialias: false, premultipliedAlpha: false });
        if (!gl) { canvas.style.opacity = ''; return; }
        canvas = dCanvas;
    }

    const VS = `#version 300 es
in vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }`;

    const FS = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform vec3  uColor;
uniform vec2  uResolution;
uniform float uTime;
uniform float uPixelSize;
uniform int   uShapeType;

const int MAX_CLICKS = 10;
uniform vec2  uClickPos[MAX_CLICKS];
uniform float uClickTimes[MAX_CLICKS];

float Bayer2(vec2 a){ a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
#define Bayer4(a) (Bayer2(0.5 * (a)) * 0.25 + Bayer2(a))
#define Bayer8(a) (Bayer4(0.5 * (a)) * 0.25 + Bayer2(a))

float hash11(float n){ return fract(sin(n) * 43758.5453); }

float vnoise(vec3 p)
{
    vec3 ip = floor(p);
    vec3 fp = fract(p);

    float n000 = hash11(dot(ip + vec3(0.0,0.0,0.0), vec3(1.0,57.0,113.0)));
    float n100 = hash11(dot(ip + vec3(1.0,0.0,0.0), vec3(1.0,57.0,113.0)));
    float n010 = hash11(dot(ip + vec3(0.0,1.0,0.0), vec3(1.0,57.0,113.0)));
    float n110 = hash11(dot(ip + vec3(1.0,1.0,0.0), vec3(1.0,57.0,113.0)));
    float n001 = hash11(dot(ip + vec3(0.0,0.0,1.0), vec3(1.0,57.0,113.0)));
    float n101 = hash11(dot(ip + vec3(1.0,0.0,1.0), vec3(1.0,57.0,113.0)));
    float n011 = hash11(dot(ip + vec3(0.0,1.0,1.0), vec3(1.0,57.0,113.0)));
    float n111 = hash11(dot(ip + vec3(1.0,1.0,1.0), vec3(1.0,57.0,113.0)));

    vec3 w = fp*fp*fp*(fp*(fp*6.0-15.0)+10.0);

    float x00 = mix(n000, n100, w.x);
    float x10 = mix(n010, n110, w.x);
    float x01 = mix(n001, n101, w.x);
    float x11 = mix(n011, n111, w.x);

    float y0 = mix(x00, x10, w.y);
    float y1 = mix(x01, x11, w.y);

    return mix(y0, y1, w.z) * 2.0 - 1.0;
}

float fbm2(vec2 uv, float t)
{
    vec3 p = vec3(uv * 4.0, t);
    float amp = 1.0;
    float freq = 1.0;
    float sum = 1.0;
    for (int i = 0; i < 5; ++i)
    {
        sum += amp * vnoise(p * freq);
        freq *= 1.25;
        amp *= 1.0;
    }
    return sum * 0.5 + 0.5;
}

float maskCircle(vec2 p, float cov)
{
    float r = sqrt(cov) * 0.25;
    float d = length(p - 0.5) - r;
    float aa = 0.5 * fwidth(d);
    return cov * (1.0 - smoothstep(-aa, aa, d * 2.0));
}

float maskTriangle(vec2 p, vec2 id, float cov)
{
    bool flip = mod(id.x + id.y, 2.0) > 0.5;
    if (flip) p.x = 1.0 - p.x;
    float r = sqrt(cov);
    float d = p.y - r * (1.0 - p.x);
    float aa = fwidth(d);
    return cov * clamp(0.5 - d / aa, 0.0, 1.0);
}

float maskDiamond(vec2 p, float cov)
{
    float r = sqrt(cov) * 0.564;
    return step(abs(p.x - 0.49) + abs(p.y - 0.49), r);
}

void main()
{
    float pixelSize = uPixelSize;
    vec2 fragCoord = gl_FragCoord.xy - uResolution * 0.5;
    float aspectRatio = uResolution.x / uResolution.y;

    vec2 pixelId = floor(fragCoord / pixelSize);
    vec2 pixelUV = fract(fragCoord / pixelSize);

    float cellPixelSize = 8.0 * pixelSize;
    vec2 cellId = floor(fragCoord / cellPixelSize);
    vec2 cellCoord = cellId * cellPixelSize;

    vec2 uv = cellCoord / uResolution * vec2(aspectRatio, 1.0);

    float feed = fbm2(uv, uTime * 0.05);
    feed = feed * 0.5 - 0.65;

    const float speed = 0.17;
    const float thickness = 0.13;
    const float dampT = 2.2;
    const float dampR = 24.0;

    for (int i = 0; i < MAX_CLICKS; ++i)
    {
        vec2 pos = uClickPos[i];
        if (pos.x < 0.0) continue;

        vec2 cuv = ((pos - uResolution * 0.5 - cellPixelSize * 0.5) / uResolution) * vec2(aspectRatio, 1.0);

        float t = max(uTime - uClickTimes[i], 0.0);
        float r = distance(uv, cuv);

        float waveR = speed * t;
        float ring = exp(-pow((r - waveR) / thickness, 2.0));
        float atten = exp(-dampT * t) * exp(-dampR * r);
        feed = max(feed, ring * atten);
    }

    float bayer = Bayer8(fragCoord / uPixelSize) - 0.5;
    float bw = step(0.5, feed + bayer);

    float coverage = bw;
    float M;
    if      (uShapeType == 1) M = maskCircle(pixelUV, coverage);
    else if (uShapeType == 2) M = maskTriangle(pixelUV, pixelId, coverage);
    else if (uShapeType == 3) M = maskDiamond(pixelUV, coverage);
    else                      M = coverage;

    fragColor = vec4(uColor, M);
}`;

    function compile(type, src) {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.error(gl.getShaderInfoLog(s)); return null; }
        return s;
    }
    const vs = compile(gl.VERTEX_SHADER, VS);
    const fs = compile(gl.FRAGMENT_SHADER, FS);
    if (!vs || !fs) return;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.error(gl.getProgramInfoLog(prog)); return; }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);

    const uResolution = gl.getUniformLocation(prog, 'uResolution');
    const uTime = gl.getUniformLocation(prog, 'uTime');
    const uColor = gl.getUniformLocation(prog, 'uColor');
    const uPixelSize = gl.getUniformLocation(prog, 'uPixelSize');
    const uShapeType = gl.getUniformLocation(prog, 'uShapeType');
    const uClickPos = gl.getUniformLocation(prog, 'uClickPos');
    const uClickTimes = gl.getUniformLocation(prog, 'uClickTimes');

    const clicks = new Float32Array(20);
    const clickTimes = new Float32Array(10);
    clicks.fill(-1);
    clickTimes.fill(-10);
    let clickIx = 0;
    const pushRipple = (clientX, clientY) => {
        const r = canvas.getBoundingClientRect();
        clicks[clickIx * 2] = (clientX - r.left) * (canvas.width / r.width);
        clicks[clickIx * 2 + 1] = (r.height - (clientY - r.top)) * (canvas.height / r.height);
        clickTimes[clickIx] = performance.now() / 1000;
        clickIx = (clickIx + 1) % 10;
    };
    ditherRipple = pushRipple;
    if (!canvas.dataset.ditherReady) {
        canvas.dataset.ditherReady = '1';
        let lastX = -1e9, lastY = -1e9;
        window.addEventListener('pointermove', e => {
            const dx = e.clientX - lastX, dy = e.clientY - lastY;
            if (dx * dx + dy * dy > 12 * 12) {
                ditherRipple(e.clientX, e.clientY);
                lastX = e.clientX; lastY = e.clientY;
            }
        });
        window.addEventListener('pointerdown', e => ditherRipple(e.clientX, e.clientY));
    }

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform3f(uColor, 1, 1, 1);
    gl.uniform1f(uPixelSize, 4);
    gl.uniform1i(uShapeType, 0);

    function render(now) {
        particleRAF = requestAnimationFrame(render);
        if (!particlesEnabled) { gl.clear(gl.COLOR_BUFFER_BIT); return; }
        gl.useProgram(prog);
        gl.uniform2f(uResolution, canvas.width, canvas.height);
        gl.uniform1f(uTime, now / 1000);
        gl.uniform2fv(uClickPos, clicks);
        gl.uniform1fv(uClickTimes, clickTimes);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    particleRAF = requestAnimationFrame(render);
}

// ═══════════════ CUSTOM CURSOR ═══════════════
function initCursorDot() {
    const dot = document.getElementById('cursor-dot');
    if (!dot) return;
    let tx = -100, ty = -100, x = -100, y = -100, show = false;
    const overSel = 'button, a, select, input, label, textarea, .nav-btn, .select-trigger, .effect-btn, .slider-row, .settings-card';
    document.addEventListener('mousemove', (e) => {
        tx = e.clientX; ty = e.clientY;
        if (!show) { show = true; x = tx; y = ty; dot.classList.add('visible'); }
    });
    document.addEventListener('mouseleave', () => { show = false; dot.classList.remove('visible'); });
    document.addEventListener('mouseover', (e) => {
        dot.classList.toggle('over', !!e.target.closest(overSel));
    });
    (function loop() {
        x += (tx - x) * 0.3;
        y += (ty - y) * 0.3;
        dot.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${dot.classList.contains('over') ? 1.7 : 1})`;
        requestAnimationFrame(loop);
    })();
}

// ═══════════════ UI SOUNDS ═══════════════
let _audioCtx = null;
function ensureAudioCtx() {
    if (!_audioCtx) { try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {} }
    return _audioCtx;
}

function uiTone(t, freq, dur, type) {
    const ctx = ensureAudioCtx(); if (!ctx) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.5, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.045, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t); osc.stop(t + dur + 0.02);
}

function playUiSound(kind) {
    if (!uiSoundsEnabled) return;
    const ctx = ensureAudioCtx(); if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const t = ctx.currentTime;
    if (kind === 'nav') { uiTone(t, 280, 0.07, 'sine'); uiTone(t + 0.055, 400, 0.08, 'sine'); }
    else if (kind === 'toggle') { uiTone(t, 480, 0.09, 'triangle'); }
    else if (kind === 'open') { uiTone(t, 240, 0.1, 'sine'); uiTone(t + 0.07, 360, 0.09, 'sine'); }
    else { uiTone(t, 320, 0.06, 'sine'); }
}

document.addEventListener('click', (e) => {
    if (!uiSoundsEnabled) return;
    const el = e.target && e.target.closest ? e.target.closest('button, .select-option, .gal-arrow') : null;
    if (!el) return;
    if (el.classList.contains('lever') || el.classList.contains('select-option') || el.classList.contains('filter-btn') || el.classList.contains('gal-arrow')) playUiSound('toggle');
    else if (el.classList.contains('nav-btn')) playUiSound('nav');
    else playUiSound('click');
}, true);

window.addEventListener('resize', () => { safeStartParticles(); });
