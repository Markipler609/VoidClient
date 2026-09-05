/* ═══════════════ VOID CLIENT — WEBSITE ═══════════════ */
(function () {
    'use strict';

    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const isCoarse = window.matchMedia('(pointer: coarse)').matches;

    /* ──────────────────────────────────────────────
       LIVE BAYER DITHER BACKGROUND
       Same GLSL as the launcher (zavalit port).
       Click ripples + a continuous trail that follows the pointer.
    ────────────────────────────────────────────── */
    const canvas = document.getElementById('dither-bg');
    const gl = canvas ? canvas.getContext('webgl2', { alpha: true, antialias: false, premultipliedAlpha: false }) : null;

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

    if (gl) {
        function compile(type, src) {
            const s = gl.createShader(type);
            gl.shaderSource(s, src);
            gl.compileShader(s);
            return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
        }
        const vs = compile(gl.VERTEX_SHADER, VS);
        const fs = compile(gl.FRAGMENT_SHADER, FS);
        if (vs && fs) {
            const prog = gl.createProgram();
            gl.attachShader(prog, vs);
            gl.attachShader(prog, fs);
            gl.linkProgram(prog);
            if (gl.getProgramParameter(prog, gl.LINK_STATUS)) {
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

                function resize() {
                    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
                    const w = Math.floor(window.innerWidth * dpr);
                    const h = Math.floor(window.innerHeight * dpr);
                    if (canvas.width !== w || canvas.height !== h) {
                        canvas.width = w; canvas.height = h;
                        gl.viewport(0, 0, w, h);
                    }
                }
                resize();
                window.addEventListener('resize', resize);

                function pushRipple(clientX, clientY) {
                    const r = canvas.getBoundingClientRect();
                    const now = performance.now() / 1000;
                    clicks[clickIx * 2] = (clientX - r.left) * (canvas.width / r.width);
                    clicks[clickIx * 2 + 1] = (r.height - (clientY - r.top)) * (canvas.height / r.height);
                    clickTimes[clickIx] = now;
                    clickIx = (clickIx + 1) % 10;
                }

                let lastX = -1e9, lastY = -1e9;
                window.addEventListener('pointermove', (e) => {
                    const dx = e.clientX - lastX, dy = e.clientY - lastY;
                    if (dx * dx + dy * dy > 12 * 12) {
                        pushRipple(e.clientX, e.clientY);
                        lastX = e.clientX; lastY = e.clientY;
                    }
                });
                window.addEventListener('pointerdown', (e) => pushRipple(e.clientX, e.clientY));

                gl.uniform3f(uColor, 1, 1, 1);
                gl.uniform1f(uPixelSize, 4);
                gl.uniform1i(uShapeType, 0);

                (function render(now) {
                    requestAnimationFrame(render);
                    gl.uniform2f(uResolution, canvas.width, canvas.height);
                    gl.uniform1f(uTime, now / 1000);
                    gl.uniform2fv(uClickPos, clicks);
                    gl.uniform1fv(uClickTimes, clickTimes);
                    gl.clear(gl.COLOR_BUFFER_BIT);
                    gl.drawArrays(gl.TRIANGLES, 0, 3);
                })(performance.now());
            }
        }
    }

    /* ──────────────────────────────────────────────
       CURSOR RING (lagged follower, expands on links)
    ────────────────────────────────────────────── */
    const ring = document.getElementById('cursor-ring');
    if (ring && !isCoarse) {
        let tx = -100, ty = -100, x = -100, y = -100, show = false;
        const hotSel = 'a, button, .win-play, .launcher-window, .feature-card, .wt-btn, .ticker';
        let hot = false;

        document.addEventListener('pointermove', (e) => {
            tx = e.clientX; ty = e.clientY;
            if (!show) { show = true; x = tx; y = ty; ring.classList.add('on'); }
        });
        document.addEventListener('pointerleave', () => {
            show = false; ring.classList.remove('on');
        });
        document.addEventListener('pointerover', (e) => {
            hot = !!e.target.closest(hotSel);
            ring.classList.toggle('hover', hot);
        });

        const ease = prefersReduced ? 1 : 0.28;
        (function loop() {
            x += (tx - x) * ease;
            y += (ty - y) * ease;
            const s = hot ? 1.65 : 1;
            ring.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${s})`;
            requestAnimationFrame(loop);
        })();
    }

    /* ──────────────────────────────────────────────
       SCROLL PROGRESS + NAV STATE
    ────────────────────────────────────────────── */
    const progress = document.getElementById('scroll-progress');
    const nav = document.getElementById('site-nav');
    function onScroll() {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        const p = max > 0 ? window.scrollY / max : 0;
        if (progress) progress.style.transform = `scaleX(${p})`;
        if (nav) nav.classList.toggle('scrolled', window.scrollY > 16);
    }
    if (progress || nav) {
        document.addEventListener('scroll', onScroll, { passive: true });
        onScroll();
    }

    /* ──────────────────────────────────────────────
       SCROLL REVEALS (manual visibility check — reliable everywhere)
    ────────────────────────────────────────────── */
    const revealEls = Array.prototype.slice.call(document.querySelectorAll('.reveal'));
    function revealInView() {
        const vh = window.innerHeight;
        for (const el of revealEls) {
            if (el.classList.contains('in')) continue;
            const r = el.getBoundingClientRect();
            if (r.top < vh * 0.88 && r.bottom > 0) el.classList.add('in');
        }
    }
    document.addEventListener('scroll', revealInView, { passive: true });
    window.addEventListener('resize', revealInView);
    revealInView();

    /* ──────────────────────────────────────────────
       ANIMATED COUNTERS
    ────────────────────────────────────────────── */
    function animateCount(el) {
        const target = parseFloat(el.dataset.count);
        const decimals = parseInt(el.dataset.decimals || '0', 10);
        const dur = 1600;
        const t0 = performance.now();
        function fmt(v) {
            const s = v.toFixed(decimals);
            return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        }
        function step(now) {
            const t = Math.min((now - t0) / dur, 1);
            const eased = 1 - Math.pow(1 - t, 4);
            el.textContent = fmt(target * eased);
            if (t < 1) requestAnimationFrame(step);
            else el.textContent = fmt(target);
        }
        requestAnimationFrame(step);
    }
    const counters = document.querySelectorAll('[data-count]');
    if (!prefersReduced && 'IntersectionObserver' in window) {
        const cio = new IntersectionObserver((entries) => {
            for (const en of entries) {
                if (en.isIntersecting) { animateCount(en.target); cio.unobserve(en.target); }
            }
        }, { threshold: 0.6 });
        counters.forEach((el) => cio.observe(el));
    } else {
        counters.forEach((el) => { el.textContent = fmtCount(el); });
    }
    function fmtCount(el) {
        const dec = parseInt(el.dataset.decimals || '0', 10);
        return Number(el.dataset.count).toFixed(dec).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    /* ──────────────────────────────────────────────
       TILT CARDS + GLARE
    ────────────────────────────────────────────── */
    const tiltEls = document.querySelectorAll('.tilt');
    if (!isCoarse && !prefersReduced && tiltEls.length) {
        tiltEls.forEach((card) => {
            const max = parseFloat(card.dataset.tiltMax || '9');
            card.addEventListener('pointermove', (e) => {
                const r = card.getBoundingClientRect();
                const px = (e.clientX - r.left) / r.width;
                const py = (e.clientY - r.top) / r.height;
                card.style.setProperty('--ry', ((px - 0.5) * 2 * max).toFixed(2) + 'deg');
                card.style.setProperty('--rx', (-(py - 0.5) * 2 * max).toFixed(2) + 'deg');
                card.style.setProperty('--gx', (px * 100).toFixed(1) + '%');
                card.style.setProperty('--gy', (py * 100).toFixed(1) + '%');
            });
            card.addEventListener('pointerleave', () => {
                card.style.setProperty('--rx', '0deg');
                card.style.setProperty('--ry', '0deg');
                card.style.setProperty('--gx', '50%');
                card.style.setProperty('--gy', '0%');
            });
        });
    }

    /* ──────────────────────────────────────────────
       MAGNETIC BUTTONS
    ────────────────────────────────────────────── */
    const magnets = document.querySelectorAll('.magnetic');
    if (!isCoarse && !prefersReduced && magnets.length) {
        magnets.forEach((btn) => {
            btn.dataset._mr = Math.min(parseFloat(btn.dataset.magnet || '14'), 20);
            btn.addEventListener('pointermove', (e) => {
                const r = btn.getBoundingClientRect();
                const dx = e.clientX - (r.left + r.width / 2);
                const dy = e.clientY - (r.top + r.height / 2);
                const m = btn.dataset._mr;
                btn.style.transform = `translate(${(dx / r.width) * m}px, ${(dy / r.height) * m * 0.6}px)`;
            });
            btn.addEventListener('pointerleave', () => { btn.style.transform = ''; });
        });
    }

    /* ──────────────────────────────────────────────
       SMOOTH ANCHORS (native smooth + predictable offset)
    ────────────────────────────────────────────── */
    document.querySelectorAll('a[data-smooth]').forEach((a) => {
        a.addEventListener('click', (e) => {
            const id = a.getAttribute('href');
            if (!id || id === '#' || id.charAt(0) !== '#') return;
            const target = document.querySelector(id);
            if (!target) return;
            e.preventDefault();
            if (prefersReduced) {
                target.scrollIntoView();
            } else {
                const y = target.getBoundingClientRect().top + window.scrollY - (target.id === 'top' ? 8 : 64);
                window.scrollTo({ top: y, behavior: 'smooth' });
            }
        });
    });

    /* subtle sound on primary CTAs — tiny, guarded, starts after first gesture */
    let muted = false;
    let ctx = null;
    document.addEventListener('pointerdown', function ghostInit() {
        if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { ctx = null; } }
    }, { once: true });
    function tone(f, dur, delay) {
        if (muted || !ctx || ctx.state !== 'running') return;
        const t = ctx.currentTime + (delay || 0);
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(f, t);
        o.frequency.exponentialRampToValueAtTime(f * 0.5, t + dur);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.02, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g).connect(ctx.destination);
        o.start(t); o.stop(t + dur + 0.02);
    }
    document.addEventListener('pointerdown', (e) => {
        const hit = e.target.closest('.btn, .win-play');
        if (!hit) return;
        if (ctx && ctx.state === 'suspended') ctx.resume();
        tone(520, 0.09, 0);
        tone(780, 0.08, 0.05);
    }, true);
})();