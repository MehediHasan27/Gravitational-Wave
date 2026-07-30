/* ============================================================
   main.js — timeline, wavefront, tear, and reassembly
   ------------------------------------------------------------
   One clock. One chirp function (window.GWChirp, shared with the
   audio engine so picture and sound cannot drift).

   Act structure after the merge, all driven off `shockT`, seconds
   since the collision:

     RIP     the wavefront sweeps outward and everything it reaches
             fails: content is thrown along its radial direction and
             fades, while jagged wedges open from the epicentre and
             black out the spacetime lattice behind it
     VOID    nothing. The page does not exist for a third of a second
     REFORM  the page is rebuilt out of dust: particles converge on
             the silhouette of where the content was, and the real DOM
             crossfades back in underneath them as they land
     SETTLE  wedges healed, remnant ringing down, trigger re-armed

   Per frame this writes:
     --w --tr --tv    -> every [data-warp] element
     --tear-g         -> :root, for the lattice and structural frames
     --shock-r        -> the two fixed ring overlays
     transform        -> #shake only (translate/rotate, nothing else)
     canvas           -> #rip (wedges) and #dust (particles)
     uniforms         -> the shader
   ============================================================ */

(function () {
  'use strict';

  const $  = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
  const lerp  = (a, b, t) => a + (b - a) * t;
  const easeOut = t => 1 - Math.pow(1 - t, 3);
  const easeInOut = t => t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2;

  /* ---------------- timeline (seconds) ---------------- */
  const T_CHARGE   = 0.45;
  const T_INSPIRAL = 6.00;
  const T_MERGE    = T_CHARGE + T_INSPIRAL;
  const T_FREEZE   = 0.10;   // held frame at the moment of merger
  const T_RIP      = 0.70;
  const T_VOID     = 0.30;
  const T_REFORM   = 2.40;
  const T_SETTLE   = 1.60;
  const T_END      = T_MERGE + T_RIP + T_VOID + T_REFORM + T_SETTLE;

  /* The tear rides the primary wavefront, so both fronts are the same
     front. Speed is set so it clears the largest plausible viewport
     inside T_RIP — a slower wave would still be tearing during the
     void, and the two acts would smear into each other. */
  const FRONT_SPEED = 2600;
  const TEAR_RAMP   = 0.26;   // seconds from intact to fully gone

  const WAVES = [
    { delay: 0.00, speed: FRONT_SPEED, amp: 1.00, width: 190 },
    { delay: 0.14, speed: 2000,        amp: 0.44, width: 250 }
  ];

  const DUST_MAX  = 2600;
  const DUST_STEP = 5;       // sampling grid, px

  /* ---------------- element refs ---------------- */
  const els = {
    hero:     $('#hero'),
    canvas:   $('#bh'),
    title:    $('#title'),
    trigger:  $('#trigger'),
    hint:     $('#hint'),
    lens:     $('#shockLens'),
    glow:     $('#shockGlow'),
    flash:    $('#flash'),
    grain:    $('#grain'),
    shake:    $('#shake'),
    page:     $('#page'),
    rip:      $('#rip'),
    dust:     $('#dust'),
    soundBtn: $('#soundToggle'),
    soundLbl: $('.sound-label'),
    disp:     $('#gw-disp'),
    turb:     $('#gw-turb'),
    form:     $('#signup'),
    email:    $('#email'),
    formNote: $('#formNote')
  };

  const root = document.documentElement;

  /* ---------------- quality / preferences ---------------- */
  const prefersReduced =
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const quality = {
    svgFilter: !prefersReduced && (navigator.hardwareConcurrency || 4) > 4,
    dpr: Math.min(window.devicePixelRatio || 1, 1.75),
    degraded: false
  };

  /* localStorage throws outright in Safari private mode and in
     sandboxed iframes, which would take the whole script down before
     the first frame. The preference is a nicety; the page is not. */
  function prefGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function prefSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  const AMP = { full: 1, reduced: 0.34, off: 0 };
  let intensity = prefGet('gw-intensity') ||
                  (prefersReduced ? 'reduced' : 'full');

  function applyIntensity(v) {
    intensity = v;
    prefSet('gw-intensity', v);
    root.style.setProperty('--amp', String(AMP[v]));
    document.body.classList.toggle('int-off', v === 'off');
    $$('.intensity button').forEach(b =>
      b.setAttribute('aria-current', String(b.dataset.int === v)));
  }

  /* ============================================================
     1. Fragment the type
     ------------------------------------------------------------
     The headline splits per glyph and short copy splits per word,
     because the tear breaks along whatever the smallest independent
     box is. Whole paragraphs are left intact — 400 fragments would
     cost more per frame than it buys visually.
     ============================================================ */
  function buildTitle() {
    const LINES = ['Two black holes', 'become one'];
    const frag = document.createDocumentFragment();
    LINES.forEach((line, li) => {
      line.split(' ').forEach((word, wi) => {
        if (wi > 0) frag.appendChild(document.createTextNode(' '));
        const w = document.createElement('span');
        w.className = 'word';
        w.setAttribute('aria-hidden', 'true');
        for (const ch of word) {
          const s = document.createElement('span');
          s.textContent = ch;
          s.setAttribute('data-warp', 'text');
          w.appendChild(s);
        }
        frag.appendChild(w);
      });
      if (li < LINES.length - 1) frag.appendChild(document.createElement('br'));
    });
    els.title.appendChild(frag);
  }

  function splitWords() {
    $$('[data-split="word"]').forEach(el => {
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      if (!text) return;
      const label = el.getAttribute('aria-label') || text;
      el.textContent = '';
      el.setAttribute('aria-label', label);
      /* the element itself must NOT be a warp target once its words
         are, or parent and child transforms compound */
      el.removeAttribute('data-warp');
      text.split(' ').forEach((word, i) => {
        if (i > 0) el.appendChild(document.createTextNode(' '));
        const s = document.createElement('span');
        s.className = 'frag';
        s.textContent = word;
        s.setAttribute('data-warp', 'text');
        s.setAttribute('aria-hidden', 'true');
        el.appendChild(s);
      });
    });
  }

  /* ============================================================
     2. Grain texture, generated rather than shipped
     ============================================================ */
  function buildGrain(size) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const img = g.createImageData(size, size);
    const d = img.data;
    /* dark noise, meant to be screened onto a black page */
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.pow(Math.random(), 2.2) * 96;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    root.style.setProperty('--grain-src', 'url(' + c.toDataURL() + ')');
  }

  /* ============================================================
     3. Warp targets — document-space centres cached once
     ============================================================ */
  let targets = [];

  function measure() {
    const sy = window.scrollY || window.pageYOffset;
    const sx = window.scrollX || window.pageXOffset;
    targets = $$('[data-warp]').map(el => {
      const r = el.getBoundingClientRect();
      return {
        el: el,
        cx: r.left + sx + r.width  / 2,
        cy: r.top  + sy + r.height / 2,
        size: Math.max(r.width, r.height),
        w: 0, tr: 0, tv: 0,
        dist: 0, distN: 0,
        dirty: false, torn: false
      };
    });
  }

  let measureTimer = 0;
  function scheduleMeasure() {
    clearTimeout(measureTimer);
    measureTimer = setTimeout(() => { measure(); sizeCanvases(); }, 140);
  }

  /* ============================================================
     4. Renderer
     ============================================================ */
  const bh = window.BlackHole.create(els.canvas);
  if (!bh) {
    els.canvas.style.background =
      'radial-gradient(60% 45% at 50% 72%, #ffe9a8 0%, #ff9a3c 12%, ' +
      '#b4188e 30%, #3a1173 52%, #0b1046 74%, #050507 100%)';
  } else {
    bh.setDpr(quality.dpr);
  }

  /* ============================================================
     5. State
     ============================================================ */
  const S = {
    running: false,
    t0: 0,
    useAudioClock: false,
    audioT0: 0,
    elapsed: 0,
    trauma: 0,
    flash: 0,
    merged: false,
    shockT: 0,
    orbit: 0,
    spin: 0,
    epi: { x: 0, y: 0 },        // viewport coords
    epiDoc: { x: 0, y: 0 },     // document coords, frozen at merge
    heroR: 0,
    maxR: 2000,
    tearG: 0,
    reformP: 0,
    ripOpen: 0,
    scrub: null                 // debug only: pins the clock
  };

  function nowSec() {
    if (S.scrub !== null) return S.scrub;
    return (S.useAudioClock && window.GWAudio.hasCtx())
      ? window.GWAudio.now() - S.audioT0
      : (performance.now() - S.t0) / 1000;
  }

  /* ============================================================
     6. Wavefront
     ============================================================ */
  function waveAt(dist) {
    let sum = 0;
    for (let i = 0; i < WAVES.length; i++) {
      const W = WAVES[i];
      const t = S.shockT - W.delay;
      if (t <= 0) continue;
      const u = (t * W.speed - dist) / W.width;
      if (u < -1.9 || u > 1.9) continue;
      /* peak displacement at the front, one sign reversal behind it:
         a crude stand-in for the quadrupolar polarity flip */
      const prof = Math.exp(-u * u * 2.4) * Math.cos(u * Math.PI * 1.15);
      sum += prof * (1 / (1 + dist / 820)) * Math.exp(-t * 0.55) * W.amp;
    }
    return sum;
  }

  function frontRadius() { return Math.max(0, S.shockT) * FRONT_SPEED; }

  /* ============================================================
     7. Tear + reassembly phase math
     ============================================================ */
  function phases() {
    const st = S.shockT;
    const reformT = st - (T_RIP + T_VOID);
    S.reformP = clamp01(reformT / T_REFORM);
    /* wedges snap open, hold through the void, then heal */
    S.ripOpen = clamp01(st / 0.32) * (1 - clamp01((S.reformP - 0.04) / 0.62));
    S.tearG = clamp01(st / 0.5) * (1 - clamp01((S.reformP - 0.50) / 0.36));
  }

  /* Per-element tear, two channels. Returns [displacement, fade].
     Outbound they move together. Inbound the displacement collapses in
     0.06 of the reform while the fade is still 1, so the element lands
     back on its real coordinates invisible and then materialises there.
     The dust does the travelling; if the DOM travelled too you would
     see it mid-flight beside its own particles. */
  const TEAR_OUT = [0, 0];
  function tearAt(dist, distN) {
    TEAR_OUT[0] = TEAR_OUT[1] = 0;
    if (S.shockT <= 0) return TEAR_OUT;
    const gone = clamp01((S.shockT - dist / FRONT_SPEED) / TEAR_RAMP);
    if (gone <= 0) return TEAR_OUT;
    /* staggered: what was closest to the merger reforms first */
    const start = 0.46 + 0.16 * distN;
    const snap = clamp01((S.reformP - start) / 0.06);
    const back = clamp01((S.reformP - start) / 0.32);
    TEAR_OUT[0] = gone * (1 - snap);
    TEAR_OUT[1] = gone * (1 - back);
    return TEAR_OUT;
  }

  /* ============================================================
     8. #rip — the wedges. Opaque black, hot white edges. Widest in
        the middle so the remnant itself stays visible at the base.
     ============================================================ */
  const RIP = { cracks: [], ctx: null, w: 0, h: 0, dpr: 1 };

  function buildRip() {
    const n = 8;
    RIP.cracks = [];
    for (let i = 0; i < n; i++) {
      const jag = [];
      for (let k = 0; k <= 11; k++) jag.push(Math.random() * 2 - 1);
      RIP.cracks.push({
        a: (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.5,
        jag: jag,
        /* narrow on purpose: eight wedges at the old widths left almost
           no page between them, and the remnant is the point of the
           shot — the tear frames it, it does not replace it */
        w: 13 + Math.random() * 30,
        len: 0.66 + Math.random() * 0.62
      });
    }
  }

  function drawRip() {
    const c = RIP.ctx;
    if (!c) return;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, RIP.w, RIP.h);
    const open = S.ripOpen * (intensity === 'off' ? 0 : Math.min(1, AMP[intensity] * 1.6));
    if (open <= 0.004) return;

    const front = frontRadius();
    c.scale(RIP.dpr, RIP.dpr);
    c.translate(S.epi.x, S.epi.y);

    for (let i = 0; i < RIP.cracks.length; i++) {
      const k = RIP.cracks[i];
      const L = Math.min(front * k.len, S.maxR * 1.5);
      if (L < 10) continue;
      const N = k.jag.length - 1;
      const px = [], py = [], qx = [], qy = [];
      for (let j = 0; j <= N; j++) {
        const t = j / N;
        const r = t * L;
        const wid = Math.pow(Math.sin(Math.PI * t), 0.7) * k.w * open;
        const ang = k.a + k.jag[j] * 0.11;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        px.push(ca * r - sa * wid); py.push(sa * r + ca * wid);
        qx.push(ca * r + sa * wid); qy.push(sa * r - ca * wid);
      }
      c.beginPath();
      c.moveTo(px[0], py[0]);
      for (let j = 1; j <= N; j++) c.lineTo(px[j], py[j]);
      for (let j = N; j >= 0; j--) c.lineTo(qx[j], qy[j]);
      c.closePath();
      c.fillStyle = '#000';
      c.fill();
      c.strokeStyle = 'rgba(255,255,255,' + (0.9 * open).toFixed(3) + ')';
      c.lineWidth = 1.3;
      c.shadowColor = 'rgba(255,255,255,.85)';
      c.shadowBlur = 18 * open;
      c.stroke();
      c.shadowBlur = 0;
    }
  }

  /* ============================================================
     9. #dust — particle reassembly
     ------------------------------------------------------------
     Targets are sampled from an offscreen silhouette of the page:
     real letterforms for the headline (fillText with the computed
     font), dashes along each text line for body copy, outlines for
     boxes. Positions are stored in DOCUMENT space so scrolling
     between build and playback stays correct.
     ============================================================ */
  const DUST = { p: null, n: 0, ctx: null, w: 0, h: 0, dpr: 1, builtAt: -1e9 };

  function lineRects(el) {
    try {
      const rg = document.createRange();
      rg.selectNodeContents(el);
      return Array.prototype.slice.call(rg.getClientRects());
    } catch (e) { return []; }
  }

  function buildDust() {
    const W = Math.max(1, window.innerWidth);
    const H = Math.max(1, window.innerHeight);
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    const o = off.getContext('2d');
    o.fillStyle = '#fff';
    o.strokeStyle = '#fff';
    o.textBaseline = 'middle';
    /* centred, not left-aligned: the glyph rects carry the element's
       negative letter-spacing, so drawing from r.left lands each
       letter off its own box and the whole word reads doubled */
    o.textAlign = 'center';

    const seen = new Set();

    /* headline: true letterforms */
    $$('.title .word span').forEach(sp => {
      const r = sp.getBoundingClientRect();
      if (r.bottom < 0 || r.top > H || r.width < 1) return;
      const cs = getComputedStyle(sp);
      o.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
      o.fillText(sp.textContent, r.left + r.width * 0.5, r.top + r.height * 0.54);
      seen.add(sp);
    });

    targets.forEach(t => {
      if (seen.has(t.el)) return;
      const el = t.el;
      const br = el.getBoundingClientRect();
      if (br.bottom < -40 || br.top > H + 40 || br.width < 2) return;

      if (el.getAttribute('data-warp') === 'box') {
        /* boxes: outline plus two interior rules, so a card reads as
           a card rather than as a solid slab of dust */
        o.lineWidth = 2;
        o.strokeRect(br.left + 1, br.top + 1, br.width - 2, br.height - 2);
        for (let k = 1; k <= 2; k++) {
          const y = br.top + (br.height * k) / 3;
          o.fillRect(br.left + br.width * 0.12, y, br.width * 0.5, 1.6);
        }
        return;
      }

      /* text: dashes along each line box */
      const fs = parseFloat(getComputedStyle(el).fontSize) || 14;
      lineRects(el).forEach(r => {
        if (r.bottom < 0 || r.top > H || r.width < 4) return;
        const h = Math.max(2, Math.min(r.height * 0.5, fs * 0.46));
        const y = r.top + r.height * 0.5 - h / 2;
        let x = r.left;
        while (x < r.right - 2) {
          const dash = Math.min(6 + Math.random() * 34, r.right - x);
          o.fillRect(x, y, dash, h);
          x += dash + 4 + Math.random() * 7;
        }
      });
    });

    /* sample the silhouette */
    const data = o.getImageData(0, 0, W, H).data;
    const pts = [];
    for (let y = 0; y < H; y += DUST_STEP) {
      for (let x = 0; x < W; x += DUST_STEP) {
        if (data[(y * W + x) * 4 + 3] > 90) pts.push(x, y);
      }
    }

    /* budget: keep a random subset rather than the top-left corner */
    let count = pts.length / 2;
    const budget = Math.round(DUST_MAX * (intensity === 'reduced' ? 0.45 : 1));
    let keep = Math.min(count, budget);
    const idx = new Uint32Array(count);
    for (let i = 0; i < count; i++) idx[i] = i;
    for (let i = count - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp;
    }

    const sy = window.scrollY || window.pageYOffset;
    const sx = window.scrollX || window.pageXOffset;
    const ex = S.epi.x, ey = S.epi.y;

    /* 5 floats per particle: tx, ty, sx, sy, delay — flat and typed,
       because this is touched 2600 times a frame */
    const p = new Float32Array(keep * 5);
    for (let i = 0; i < keep; i++) {
      const k = idx[i] * 2;
      const vx = pts[k], vy = pts[k + 1];
      let dx = vx - ex, dy = vy - ey;
      const len = Math.max(Math.hypot(dx, dy), 1);
      const push = len + 260 + Math.random() * 520;
      const rot = (Math.random() - 0.5) * 0.95;
      const cr = Math.cos(rot), sr = Math.sin(rot);
      const ux = dx / len, uy = dy / len;
      const o5 = i * 5;
      p[o5]     = vx + sx;
      p[o5 + 1] = vy + sy;
      p[o5 + 2] = ex + sx + (ux * cr - uy * sr) * push;
      p[o5 + 3] = ey + sy + (ux * sr + uy * cr) * push;
      p[o5 + 4] = clamp01(len / (S.maxR * 0.9));
    }

    DUST.p = p;
    DUST.n = keep;
    DUST.builtAt = sy;
  }

  function drawDust() {
    const c = DUST.ctx;
    if (!c) return;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, DUST.w, DUST.h);
    if (!DUST.p || intensity === 'off') return;

    const rp = S.reformP;
    if (rp <= 0 || rp >= 1) return;

    /* Cloud brightness: up fast, then out just ahead of the real DOM
       arriving. The two windows have to barely overlap — run them
       together and every glyph reads as a double exposure. */
    const cloud = Math.min(1, rp * 8) * (1 - clamp01((rp - 0.48) / 0.30));
    if (cloud <= 0.004) return;

    const sy = window.scrollY || window.pageYOffset;
    const sx = window.scrollX || window.pageXOffset;
    const p = DUST.p, n = DUST.n;

    c.scale(DUST.dpr, DUST.dpr);
    c.globalAlpha = cloud;
    c.fillStyle = '#ffffff';

    for (let i = 0; i < n; i++) {
      const o5 = i * 5;
      const pr = clamp01((rp - p[o5 + 4] * 0.42) / 0.5);
      if (pr <= 0) continue;
      const e = easeOut(pr);
      const x = p[o5 + 2] + (p[o5]     - p[o5 + 2]) * e - sx;
      const y = p[o5 + 3] + (p[o5 + 1] - p[o5 + 3]) * e - sy;
      /* size carries per-particle brightness, so the whole cloud
         draws under one globalAlpha instead of 2600 state changes */
      const s = 0.9 + 1.5 * pr;
      c.fillRect(x, y, s, s);
    }
    c.globalAlpha = 1;
  }

  function sizeCanvases() {
    const d = Math.min(window.devicePixelRatio || 1, 1.5);
    [[els.rip, RIP], [els.dust, DUST]].forEach(pair => {
      const el = pair[0], o = pair[1];
      const w = Math.max(1, Math.round(window.innerWidth  * d));
      const h = Math.max(1, Math.round(window.innerHeight * d));
      if (el.width !== w || el.height !== h) { el.width = w; el.height = h; }
      o.ctx = o.ctx || el.getContext('2d');
      o.w = w; o.h = h; o.dpr = d;
    });
  }

  /* ============================================================
     10. Per-frame DOM writes
     ============================================================ */
  function writeWarp() {
    const sy = window.scrollY || window.pageYOffset;
    const sx = window.scrollX || window.pageXOffset;
    const ex = S.epi.x + sx;
    const ey = S.epi.y + sy;
    const rippling = S.shockT > 0 && S.shockT < T_RIP + 0.4;
    const tearing  = S.merged && S.reformP < 1;

    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];

      let w = 0;
      if (rippling) {
        const dx = t.cx - ex, dy = t.cy - ey;
        w = clamp(waveAt(Math.sqrt(dx * dx + dy * dy)), -1.7, 1.7);
      }
      let tr = 0, tv = 0;
      if (tearing) {
        const o = tearAt(t.dist, t.distN);
        tr = o[0]; tv = o[1];
      }

      /* only write when the value actually moved: at ~150 targets this
         is the difference between 300 style writes a frame and 30 */
      if (w !== t.w && (Math.abs(w - t.w) > 0.0015 || w === 0)) {
        t.w = w;
        t.el.style.setProperty('--w', w.toFixed(4));
      }
      if (tr !== t.tr && (Math.abs(tr - t.tr) > 0.002 || tr === 0 || tr === 1)) {
        t.tr = tr;
        t.el.style.setProperty('--tr', tr.toFixed(4));
      }
      if (tv !== t.tv && (Math.abs(tv - t.tv) > 0.002 || tv === 0 || tv === 1)) {
        t.tv = tv;
        t.el.style.setProperty('--tv', tv.toFixed(4));
      }
      t.dirty = w !== 0 || tr !== 0 || tv !== 0;
    }

    root.style.setProperty('--tear-g',
      (S.tearG * (intensity === 'off' ? 0 : 1)).toFixed(4));
  }

  /* frozen at the merge instant: direction and spin of each fragment,
     and its distance from the epicentre. Written once, not per frame. */
  function armTear() {
    const sy = window.scrollY || window.pageYOffset;
    const sx = window.scrollX || window.pageXOffset;
    S.epiDoc.x = S.epi.x + sx;
    S.epiDoc.y = S.epi.y + sy;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const dx = t.cx - S.epiDoc.x, dy = t.cy - S.epiDoc.y;
      const d = Math.max(Math.hypot(dx, dy), 1);
      t.dist = d;
      t.distN = clamp01(d / (S.maxR * 0.9));
      const st = t.el.style;
      st.setProperty('--tx', (dx / d).toFixed(4));
      st.setProperty('--ty', (dy / d).toFixed(4));
      /* small fragments tumble, big slabs barely rotate — a whole
         400px button at 45deg reads as a bug, a single glyph at 45deg
         reads as debris */
      const spin = 50 * clamp(140 / Math.max(t.size, 40), 0.2, 1);
      st.setProperty('--rot', ((Math.random() * 2 - 1) * spin).toFixed(2));
    }
  }

  function setWarpHints(on) {
    for (let i = 0; i < targets.length; i++) {
      targets[i].el.classList.toggle('warping', on);
    }
  }

  /* trauma model: amplitude is trauma squared, so it decays
     perceptually fast and never reads as a loop */
  function writeShake() {
    if (intensity === 'off') { els.shake.style.transform = ''; return; }
    const a = S.trauma * S.trauma * AMP[intensity];
    if (a < 0.0008) { els.shake.style.transform = ''; return; }
    const x = (Math.random() * 2 - 1) * 28 * a;
    const y = (Math.random() * 2 - 1) * 28 * a;
    const r = (Math.random() * 2 - 1) * 1.4 * a;
    els.shake.style.transform =
      'translate3d(' + x.toFixed(2) + 'px,' + y.toFixed(2) + 'px,0) ' +
      'rotate(' + r.toFixed(3) + 'deg)';
  }

  function writeOverlays() {
    root.style.setProperty('--shock-x', S.epi.x.toFixed(1) + 'px');
    root.style.setProperty('--shock-y', S.epi.y.toFixed(1) + 'px');

    const amp = AMP[intensity];
    const r = frontRadius();
    const alive = S.shockT > 0 && r < S.maxR * 1.35;

    if (alive && amp > 0) {
      const fade = clamp01(1 - r / (S.maxR * 1.2));
      els.lens.style.setProperty('--shock-r', r.toFixed(1) + 'px');
      els.glow.style.setProperty('--shock-r', r.toFixed(1) + 'px');
      els.lens.style.opacity = (fade * amp).toFixed(3);
      els.glow.style.opacity = (fade * 0.9 * amp).toFixed(3);
    } else {
      els.lens.style.opacity = '0';
      els.glow.style.opacity = '0';
    }

    els.flash.style.opacity = (S.flash * 0.85 * (amp > 0 ? 1 : 0)).toFixed(3);
    els.grain.style.opacity =
      clamp(S.trauma * 0.5 + S.flash * 0.2 + S.tearG * 0.28, 0, 0.6).toFixed(3);
  }

  /* The only true pixel-level warp of live text. Expensive, so: hero
     subtree only, and the filter property is removed when idle. */
  let filterOn = false;
  function writeHeroFilter() {
    if (!quality.svgFilter || intensity === 'off') {
      if (filterOn) { els.hero.style.filter = ''; filterOn = false; }
      return;
    }
    const scale = (S.trauma * 30 + Math.abs(waveAt(S.heroR)) * 26 + S.flash * 18)
                  * AMP[intensity];
    if (scale > 0.6) {
      els.disp.setAttribute('scale', scale.toFixed(2));
      els.turb.setAttribute('baseFrequency',
        (0.0035 + S.trauma * 0.010).toFixed(5) + ' ' +
        (0.0110 + S.trauma * 0.022).toFixed(5));
      if (!filterOn) { els.hero.style.filter = 'url(#gw-displace)'; filterOn = true; }
    } else if (filterOn) {
      els.hero.style.filter = '';
      els.disp.setAttribute('scale', '0');
      filterOn = false;
    }
  }

  /* ============================================================
     11. Physics -> uniforms
     ============================================================ */
  const IDLE_OMEGA = 0.34;

  function updatePhysics(dt) {
    if (!bh) return;
    const st = bh.state;
    let chirp = 1, omega = IDLE_OMEGA;

    if (!S.running) {
      /* Idle, and also the re-arm path. Slow on purpose: the remnant
         has to un-merge and drift apart again, and snapping it looks
         like a bug rather than a reset. */
      const k = 1 - Math.pow(0.30, dt);
      st.sep   = lerp(st.sep,   0.42, k);
      st.tilt  = lerp(st.tilt,  0.45, k);
      st.zoom  = lerp(st.zoom,  1.00, k);
      st.glow  = lerp(st.glow,  1.00, k);
      st.merge = lerp(st.merge, 0,    k);
      st.wobble = lerp(st.wobble, 0, 1 - Math.pow(0.02, dt));
      st.shock = 0; st.flash = 0;
    } else {
      const e = S.elapsed;
      if (e < T_CHARGE) {
        const k = e / T_CHARGE;
        st.glow = lerp(1.0, 1.10, k);
        st.zoom = lerp(1.0, 1.04, k);
      } else if (e < T_MERGE) {
        const x = (e - T_CHARGE) / T_INSPIRAL;
        chirp = window.GWChirp(x);
        /* Real f_orb at plunge is ~130 Hz, which on a screen is a grey
           disc. The exponent is a deliberate time-dilation. */
        omega = 0.42 * Math.pow(chirp, 1.62);
        st.sep  = 0.42 / Math.pow(chirp, 0.667);         // Kepler
        if (x > 0.86) st.sep *= lerp(1, 0.30, (x - 0.86) / 0.14);
        st.tilt = lerp(0.45, 0.92, easeInOut(clamp01(x * 1.15)));
        st.zoom = lerp(1.04, 1.18, easeOut(x));
        st.glow = lerp(1.10, 1.28, x * x);
        S.trauma = Math.max(S.trauma, 0.055 + 0.24 * Math.pow(x, 4));
      } else {
        const rd = e - T_MERGE;
        st.merge = clamp01(rd / 0.22);
        st.sep = lerp(st.sep, 0, clamp01(rd / 0.18));
        st.wobble = Math.exp(-rd * 2.4) * Math.sin(rd * Math.PI * 2 * 4.2);
        st.tilt = lerp(st.tilt, 0.92, 1 - Math.pow(0.15, dt));
        st.zoom = lerp(st.zoom, 1.06, 1 - Math.pow(0.25, dt));
        st.glow = lerp(st.glow, 1.05, 1 - Math.pow(0.4, dt));
        st.shock = rd < 2.0 ? rd * 1.1 : 0;
        omega = 0.42 * Math.pow(7.4, 1.62) * Math.exp(-rd * 0.9) + 0.5;
      }
    }

    /* Gas time and advection freeze at the merge instant. The held
       frame is what makes the impact land; more motion is more noise. */
    const frozen = S.merged && S.elapsed < T_MERGE + T_FREEZE;
    if (!frozen) {
      S.orbit += dt * omega;
      S.spin  += dt * omega * 3.0;
      st.t    += dt;
    }
    st.angle = S.orbit;
    st.spin  = S.spin;
    st.flash = S.flash;
  }

  /* ============================================================
     12. Frame loop
     ============================================================ */
  let last = performance.now();
  const ft = { acc: 0, n: 0 };
  let paused = false;

  function frame(now) {
    requestAnimationFrame(frame);
    if (paused) { last = now; return; }

    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.1) dt = 0.1;          // tab-return / stall guard
    if (dt <= 0) return;

    ft.acc += dt; ft.n++;
    if (ft.n >= 45) {
      const avg = ft.acc / ft.n;
      if (avg > 0.026 && !quality.degraded) {
        quality.degraded = true;
        if (bh) bh.setDpr(1.0);
        document.body.classList.add('perf-low');
      }
      if (avg > 0.034 && quality.svgFilter) {
        quality.svgFilter = false;
        els.hero.style.filter = '';
        filterOn = false;
      }
      ft.acc = 0; ft.n = 0;
    }

    if (S.running) {
      S.elapsed = nowSec();
      if (!S.merged && S.elapsed >= T_MERGE) fireMerge();
      if (S.merged) S.shockT = S.elapsed - T_MERGE;
      if (S.elapsed >= T_END) finish();
    }

    /* epicentre: mirrors the shader's aspect-aware world unit and its
       0.27 downward offset exactly */
    const hr = els.hero.getBoundingClientRect();
    const unit = Math.min(hr.width / 0.86, hr.height);
    S.epi.x = hr.left + hr.width * 0.5;
    S.epi.y = hr.top + hr.height * 0.5 + unit * 0.27;
    S.heroR = unit * 0.27;
    S.maxR = Math.hypot(window.innerWidth, window.innerHeight) * 0.75 + 400;

    S.trauma *= Math.pow(0.905, dt * 60);
    S.flash  *= Math.pow(0.760, dt * 60);
    if (S.trauma < 0.0005) S.trauma = 0;
    if (S.flash  < 0.0008) S.flash  = 0;

    phases();
    updatePhysics(dt);
    writeWarp();
    writeShake();
    writeOverlays();
    writeHeroFilter();
    drawRip();
    drawDust();
    if (bh) bh.draw();
  }

  /* ============================================================
     13. Sequence control
     ============================================================ */
  let reformFired = false;

  function start() {
    if (S.running) return;
    measure();
    sizeCanvases();
    setWarpHints(true);

    S.running = true;
    S.merged = false;
    S.shockT = 0;
    S.elapsed = 0;
    S.reformP = 0;
    S.ripOpen = 0;
    S.tearG = 0;
    S.t0 = performance.now();
    S.useAudioClock = false;
    reformFired = false;

    els.trigger.classList.add('charging');
    els.trigger.setAttribute('aria-disabled', 'true');
    els.hint.style.opacity = '0';

    if (window.GWAudio.isEnabled()) {
      const at0 = window.GWAudio.inspiral(T_INSPIRAL);
      if (at0) { S.audioT0 = at0 - T_CHARGE; S.useAudioClock = true; }
    }
  }

  function fireMerge() {
    S.merged = true;
    S.flash = 1;
    S.trauma = 1;

    /* Dust targets are sampled from the page as it stands right now.
       Rebuild if the reader scrolled a long way during the inspiral,
       because everything sampled then is off screen. */
    const sy = window.scrollY || window.pageYOffset;
    if (!DUST.p || Math.abs(sy - DUST.builtAt) > 120) buildDust();

    buildRip();
    armTear();

    els.trigger.classList.remove('charging');
    window.GWAudio.merge();
    window.GWAudio.tear();
    if (intensity !== 'off' && navigator.vibrate) {
      try { navigator.vibrate([28, 22, 90, 36, 240, 70, 130]); } catch (e) {}
    }
  }

  function finish() {
    S.running = false;
    S.merged = false;
    S.shockT = 0;
    S.reformP = 0;
    S.ripOpen = 0;
    S.tearG = 0;
    S.useAudioClock = false;
    els.trigger.classList.remove('charging');
    els.trigger.removeAttribute('aria-disabled');
    els.hint.style.opacity = '';
    els.hero.style.filter = '';
    filterOn = false;
    setWarpHints(false);
    root.style.setProperty('--tear-g', '0');
    for (let i = 0; i < targets.length; i++) {
      const st = targets[i].el.style;
      st.setProperty('--w', '0');
      st.setProperty('--tr', '0');
      st.setProperty('--tv', '0');
      targets[i].w = 0; targets[i].tr = 0; targets[i].tv = 0;
      targets[i].dirty = false;
    }
    drawRip();
    drawDust();
  }

  /* ============================================================
     14. Wiring
     ============================================================ */
  buildTitle();
  splitWords();
  buildGrain(180);
  applyIntensity(intensity);
  measure();
  sizeCanvases();

  els.trigger.addEventListener('click', () => {
    /* the first click is also the autoplay gesture */
    if (!window.GWAudio.isEnabled() && !window.GWAudio.hasCtx()) {
      window.GWAudio.setEnabled(true);
      els.soundBtn.setAttribute('aria-pressed', 'true');
      els.soundLbl.textContent = 'SOUND ON';
    }
    start();
  });

  els.soundBtn.addEventListener('click', () => {
    const on = window.GWAudio.setEnabled(!window.GWAudio.isEnabled());
    els.soundBtn.setAttribute('aria-pressed', String(on));
    els.soundLbl.textContent = on ? 'SOUND ON' : 'SOUND OFF';
  });

  $$('.intensity button').forEach(b => {
    b.addEventListener('click', () => {
      applyIntensity(b.dataset.int);
      if (b.dataset.int === 'off') { S.trauma = 0; S.flash = 0; }
    });
  });

  els.form.addEventListener('submit', e => {
    e.preventDefault();
    const v = els.email.value.trim();
    const ok = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
    els.email.classList.toggle('invalid', !ok);
    els.formNote.textContent = ok
      ? 'Logged. Next unusual event, you hear about it first.'
      : 'That address will not resolve. Try again.';
    if (ok) els.email.value = '';
  });

  window.addEventListener('resize', scheduleMeasure, { passive: true });

  document.addEventListener('visibilitychange', () => {
    paused = document.hidden;
    if (paused && S.running) { window.GWAudio.abort(); finish(); }
  });

  window.addEventListener('keydown', e => {
    if ((e.key === 'm' || e.key === 'M') &&
        !S.running && document.activeElement !== els.email) start();
  });

  /* reassembly sound, fired once when the dust starts converging */
  (function watchReform() {
    requestAnimationFrame(watchReform);
    if (S.running && !reformFired && S.reformP > 0) {
      reformFired = true;
      window.GWAudio.reform(T_REFORM);
    }
  })();

  /* ---- dev handle: ?debug=1 exposes the timeline for scrubbing ---- */
  if (/[?&]debug=1/.test(location.search)) {
    window.__gw = {
      S: S, bh: bh, quality: quality, waves: WAVES, dust: DUST, rip: RIP,
      targets: () => targets, start: start, finish: finish,
      seek: function (sec) {
        if (!S.running) start();
        S.useAudioClock = false;
        S.scrub = null;
        S.t0 = performance.now() - sec * 1000;
        if (sec >= T_MERGE && !S.merged) fireMerge();
        if (sec < T_MERGE) { S.merged = false; S.flash = 0; }
        return sec;
      },
      /* pin the clock so a still can be inspected */
      scrub: function (sec) {
        if (!S.running) start();
        S.useAudioClock = false;
        if (sec >= T_MERGE && !S.merged) fireMerge();
        if (sec < T_MERGE) { S.merged = false; S.flash = 0; }
        S.scrub = sec;
        return sec;
      },
      play: function () { S.scrub = null; S.t0 = performance.now(); },
      marks: {
        merge: T_MERGE, rip: T_MERGE, void: T_MERGE + T_RIP,
        reform: T_MERGE + T_RIP + T_VOID, end: T_END
      }
    };
  }

  requestAnimationFrame(frame);
})();
