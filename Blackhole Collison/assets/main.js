/* ============================================================
   main.js — timeline, wavefront, and the DOM distortion
   ------------------------------------------------------------
   One clock. One chirp function (window.GWChirp, shared with the
   audio engine so picture and sound cannot drift). Per frame it
   writes:

     - uniforms  -> the shader (orbit, tilt, merge, shock)
     - --w       -> every [data-warp] element (geometry + chroma)
     - --shock-r -> the two fixed overlays (lens ring + wavefront)
     - transform -> #shake only (translate/rotate, nothing else)
     - scale     -> the hero's SVG feDisplacementMap

   Distances are measured in VIEWPORT space, recomputed from cached
   document-space centres minus scrollY. That way the wave hits
   whatever the reader is actually looking at, and it stays correct
   if they scroll mid-event.
   ============================================================ */

(function () {
  'use strict';

  const $  = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const lerp  = (a, b, t) => a + (b - a) * t;
  const easeOut = t => 1 - Math.pow(1 - t, 3);
  const easeInOut = t => t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2;

  /* ---------------- timeline constants (seconds) ---------------- */
  const T_CHARGE   = 0.45;
  const T_INSPIRAL = 6.00;
  const T_FREEZE   = 0.10;   // held frame at the moment of merger
  const T_RINGDOWN = 3.20;
  const T_SETTLE   = 2.00;
  const T_MERGE    = T_CHARGE + T_INSPIRAL;
  const T_END      = T_MERGE + T_RINGDOWN + T_SETTLE;

  /* three wavefronts: primary plus two weaker echoes, because one
     pass across the viewport is over in 0.7s and reads as a glitch */
  const WAVES = [
    { delay: 0.00, speed: 1550, amp: 1.00, width: 155 },
    { delay: 0.30, speed: 1150, amp: 0.54, width: 200 },
    { delay: 0.64, speed:  880, amp: 0.30, width: 260 }
  ];

  /* ---------------- element refs ---------------- */
  const els = {
    hero:      $('#hero'),
    canvas:    $('#bh'),
    title:     $('#title'),
    trigger:   $('#trigger'),
    hint:      $('#hint'),
    lens:      $('#shockLens'),
    glow:      $('#shockGlow'),
    flash:     $('#flash'),
    grain:     $('#grain'),
    shake:     $('#shake'),
    soundBtn:  $('#soundToggle'),
    soundLbl:  $('.sound-label'),
    disp:      $('#gw-disp'),
    turb:      $('#gw-turb'),
    form:      $('#signup'),
    email:     $('#email'),
    formNote:  $('#formNote')
  };

  /* ---------------- quality / preferences ---------------- */
  const prefersReduced =
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const quality = {
    svgFilter: !prefersReduced && (navigator.hardwareConcurrency || 4) > 4,
    dpr: Math.min(window.devicePixelRatio || 1, 1.75),
    degraded: false
  };

  const AMP = { full: 1, reduced: 0.34, off: 0 };
  let intensity = localStorage.getItem('gw-intensity') ||
                  (prefersReduced ? 'reduced' : 'full');

  function applyIntensity(v) {
    intensity = v;
    localStorage.setItem('gw-intensity', v);
    document.documentElement.style.setProperty('--amp', String(AMP[v]));
    document.body.classList.toggle('int-off', v === 'off');
    $$('.intensity button').forEach(b =>
      b.setAttribute('aria-current', String(b.dataset.int === v)));
  }

  /* ============================================================
     1. Split the headline into per-glyph warp targets
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
    document.documentElement.style.setProperty(
      '--grain-src', 'url(' + c.toDataURL() + ')');
  }

  /* ============================================================
     3. Warp targets — cache document-space centres once
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
        w: 0,
        dirty: false
      };
    });
  }

  let measureTimer = 0;
  function scheduleMeasure() {
    clearTimeout(measureTimer);
    measureTimer = setTimeout(measure, 140);
  }

  /* ============================================================
     4. Renderer
     ============================================================ */
  const bh = window.BlackHole.create(els.canvas);
  if (!bh) {
    /* no WebGL: static gradient stand-in, page stays fully usable */
    els.canvas.style.background =
      'radial-gradient(60% 45% at 38% 46%, #ffe9a8 0%, #ff9a3c 12%, ' +
      '#b4188e 30%, #3a1173 52%, #0b1046 74%, #030208 100%)';
  } else {
    bh.setDpr(quality.dpr);
  }

  /* ============================================================
     5. State
     ============================================================ */
  const S = {
    running: false,
    phase: 'idle',
    t0: 0,              // clock origin
    useAudioClock: false,
    audioT0: 0,
    elapsed: 0,
    trauma: 0,
    flash: 0,
    merged: false,
    shockT: 0,          // seconds since merge
    orbit: 0,           // integrated orbital phase
    spin: 0,            // integrated gas advection phase
    frozenUntil: 0,
    epi: { x: 0, y: 0 },
    heroR: 0,
    maxR: 2000,
    scrub: null         // debug only: pins the clock to a fixed second
  };

  function nowSec() {
    if (S.scrub !== null) return S.scrub;   // debug hold
    return (S.useAudioClock && window.GWAudio.hasCtx())
      ? window.GWAudio.now() - S.audioT0
      : (performance.now() - S.t0) / 1000;
  }

  /* ============================================================
     6. The wavefront model
     ============================================================ */
  function waveAt(dist) {
    let sum = 0;
    for (let i = 0; i < WAVES.length; i++) {
      const W = WAVES[i];
      const t = S.shockT - W.delay;
      if (t <= 0) continue;
      const r = t * W.speed;
      const u = (r - dist) / W.width;
      if (u < -1.9 || u > 1.9) continue;
      /* max displacement at the front, one sign reversal behind it:
         a crude stand-in for the quadrupolar +/- polarity flip */
      const prof = Math.exp(-u * u * 2.4) * Math.cos(u * Math.PI * 1.15);
      /* 1/r amplitude falloff, plus overall decay of the ringdown */
      const fall = 1 / (1 + dist / 820);
      const decay = Math.exp(-t * 0.55);
      sum += prof * fall * decay * W.amp;
    }
    return sum;
  }

  function frontRadius() {
    return Math.max(0, S.shockT) * WAVES[0].speed;
  }

  /* ============================================================
     7. Per-frame DOM write
     ============================================================ */
  function writeWarp() {
    const sy = window.scrollY || window.pageYOffset;
    const sx = window.scrollX || window.pageXOffset;
    const ex = S.epi.x + sx;
    const ey = S.epi.y + sy;
    const active = S.shockT > 0 && S.shockT < 7;

    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      let w = 0;
      if (active) {
        const dx = t.cx - ex, dy = t.cy - ey;
        w = clamp(waveAt(Math.sqrt(dx * dx + dy * dy)), -1.7, 1.7);
      }
      if (w === 0 && !t.dirty) continue;
      if (Math.abs(w - t.w) < 0.0015 && w !== 0) continue;
      t.w = w;
      t.dirty = w !== 0;
      t.el.style.setProperty('--w', w.toFixed(4));
    }
  }

  function setWarpHints(on) {
    for (let i = 0; i < targets.length; i++) {
      targets[i].el.classList.toggle('warping', on);
    }
  }

  /* ============================================================
     8. Shake — trauma model. Amplitude is trauma squared, so it
        falls off perceptually fast and never feels like a loop.
     ============================================================ */
  function writeShake() {
    if (intensity === 'off') { els.shake.style.transform = ''; return; }
    const a = S.trauma * S.trauma * AMP[intensity];
    if (a < 0.0008) { els.shake.style.transform = ''; return; }
    const x = (Math.random() * 2 - 1) * 26 * a;
    const y = (Math.random() * 2 - 1) * 26 * a;
    const r = (Math.random() * 2 - 1) * 1.35 * a;
    els.shake.style.transform =
      'translate3d(' + x.toFixed(2) + 'px,' + y.toFixed(2) + 'px,0) ' +
      'rotate(' + r.toFixed(3) + 'deg)';
  }

  /* ============================================================
     9. Overlays
     ============================================================ */
  function writeOverlays() {
    const root = document.documentElement.style;
    root.setProperty('--shock-x', S.epi.x.toFixed(1) + 'px');
    root.setProperty('--shock-y', S.epi.y.toFixed(1) + 'px');

    const amp = AMP[intensity];
    const r = frontRadius();
    const alive = S.shockT > 0 && r < S.maxR * 1.35;

    if (alive && amp > 0) {
      const fade = clamp(1 - r / (S.maxR * 1.2), 0, 1);
      els.lens.style.setProperty('--shock-r', r.toFixed(1) + 'px');
      els.glow.style.setProperty('--shock-r', r.toFixed(1) + 'px');
      els.lens.style.opacity = (fade * amp).toFixed(3);
      els.glow.style.opacity = (fade * 0.9 * amp).toFixed(3);
    } else {
      els.lens.style.opacity = '0';
      els.glow.style.opacity = '0';
    }

    els.flash.style.opacity = (S.flash * 0.82 * (amp > 0 ? 1 : 0)).toFixed(3);
    els.grain.style.opacity =
      clamp(S.trauma * 0.5 + S.flash * 0.2, 0, 0.6).toFixed(3);
  }

  /* ============================================================
     10. Hero SVG displacement — the only true pixel-level warp of
         live text. Expensive, so: hero subtree only, one-shot,
         filter property removed entirely when idle.
     ============================================================ */
  let filterOn = false;
  function writeHeroFilter() {
    if (!quality.svgFilter || intensity === 'off') {
      if (filterOn) { els.hero.style.filter = ''; filterOn = false; }
      return;
    }
    /* sample the wave at the hero's geometric centre. S.heroR is
       cached in the frame loop — reading offsetHeight here would
       force a layout every frame, mid-effect, for one number. */
    const heroW = waveAt(S.heroR);
    const scale = (S.trauma * 30 + Math.abs(heroW) * 26 + S.flash * 18)
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
      /* Idle: a wide, slow, patient binary. Also the re-arm path
         after a run, so the constants are deliberately slow — the
         remnant has to un-merge and drift back apart, and snapping
         it looks like a bug rather than a reset. */
      const k = 1 - Math.pow(0.30, dt);          // ~1.5s to settle
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
        /* orbital rate. Real f_orb at plunge is ~130 Hz, which on a
           screen is a grey disc, so the exponent here is a
           deliberate time-dilation for legibility. */
        omega = 0.42 * Math.pow(chirp, 1.62);
        st.sep  = 0.42 / Math.pow(chirp, 0.667);        // Kepler
        /* final plunge: Kepler alone leaves them still visibly apart
           at t_c, and then the merge lerp has to snap the gap shut */
        if (x > 0.86) st.sep *= lerp(1, 0.30, (x - 0.86) / 0.14);
        st.tilt = lerp(0.45, 0.92, easeInOut(clamp(x * 1.15, 0, 1)));
        st.zoom = lerp(1.04, 1.18, easeOut(x));
        st.glow = lerp(1.10, 1.28, x * x);
        S.trauma = Math.max(S.trauma, 0.055 + 0.24 * Math.pow(x, 4));
      } else {
        const rd = e - T_MERGE;
        st.merge = clamp(rd / 0.22, 0, 1);
        st.sep = lerp(st.sep, 0, clamp(rd / 0.18, 0, 1));
        /* quasinormal ringing of the remnant */
        st.wobble = Math.exp(-rd * 2.4) * Math.sin(rd * Math.PI * 2 * 4.2);
        st.tilt = lerp(st.tilt, 0.92, 1 - Math.pow(0.15, dt));
        st.zoom = lerp(st.zoom, 1.06, 1 - Math.pow(0.25, dt));
        st.glow = lerp(st.glow, 1.05, 1 - Math.pow(0.4, dt));
        /* the shock, in shader world units */
        st.shock = rd < 2.6 ? rd * 0.85 : 0;
        omega = 0.42 * Math.pow(7.4, 1.62) * Math.exp(-rd * 0.9) + 0.5;
      }
    }

    /* Gas time and advection freeze at the instant of merger. The
       held frame is what makes the impact land; more motion would
       just be more noise. */
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

    /* --- perf watchdog --- */
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

    /* --- clock --- */
    if (S.running) {
      S.elapsed = nowSec();
      if (!S.merged && S.elapsed >= T_MERGE) fireMerge();
      if (S.merged) S.shockT = S.elapsed - T_MERGE;
      if (S.elapsed >= T_END) finish();
    }

    /* --- epicentre: hero centre, in viewport coords --- */
    const hr = els.hero.getBoundingClientRect();
    /* mirrors the shader exactly: same aspect-aware world unit, same
       0.27 downward offset. Hard-coding a percentage of the hero
       height puts the ring in the wrong place on portrait screens. */
    const unit = Math.min(hr.width / 0.86, hr.height);
    S.epi.x = hr.left + hr.width * 0.5;
    S.epi.y = hr.top + hr.height * 0.5 + unit * 0.27;
    S.heroR = unit * 0.27;   // epicentre -> hero centre, for the SVG filter
    S.maxR = Math.hypot(window.innerWidth, window.innerHeight) * 0.75 + 400;

    /* --- decays --- */
    S.trauma *= Math.pow(0.905, dt * 60);
    S.flash  *= Math.pow(0.760, dt * 60);
    if (S.trauma < 0.0005) S.trauma = 0;
    if (S.flash  < 0.0008) S.flash  = 0;

    updatePhysics(dt);
    writeWarp();
    writeShake();
    writeOverlays();
    writeHeroFilter();
    if (bh) bh.draw();
  }

  /* ============================================================
     13. Sequence control
     ============================================================ */
  function start() {
    if (S.running) return;
    measure();
    setWarpHints(true);

    S.running = true;
    S.merged = false;
    S.shockT = 0;
    S.elapsed = 0;
    S.t0 = performance.now();
    S.useAudioClock = false;

    els.trigger.classList.add('charging');
    els.trigger.setAttribute('aria-disabled', 'true');
    els.hint.style.opacity = '0';

    if (window.GWAudio.isEnabled()) {
      /* schedule the chirp, then slave the visual clock to the
         audio clock so they cannot separate */
      const at0 = window.GWAudio.inspiral(T_INSPIRAL);
      if (at0) {
        S.audioT0 = at0 - T_CHARGE;
        S.useAudioClock = true;
      }
    }
  }

  function fireMerge() {
    S.merged = true;
    S.flash = 1;
    S.trauma = 1;
    els.trigger.classList.remove('charging');
    document.body.classList.add('is-merging');
    window.GWAudio.merge();
    if (intensity !== 'off' && navigator.vibrate) {
      try { navigator.vibrate([28, 22, 90, 36, 240, 70, 130]); } catch (e) {}
    }
  }

  function finish() {
    S.running = false;
    S.merged = false;
    S.shockT = 0;
    S.useAudioClock = false;
    document.body.classList.remove('is-merging');
    els.trigger.classList.remove('charging');
    els.trigger.removeAttribute('aria-disabled');
    els.hint.style.opacity = '';
    els.hero.style.filter = '';
    filterOn = false;
    setWarpHints(false);
    for (let i = 0; i < targets.length; i++) {
      targets[i].el.style.setProperty('--w', '0');
      targets[i].w = 0; targets[i].dirty = false;
    }
  }

  /* ============================================================
     14. Wiring
     ============================================================ */
  buildTitle();
  buildGrain(180);
  applyIntensity(intensity);
  measure();

  els.trigger.addEventListener('click', () => {
    /* first click is also the autoplay gesture */
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

  /* keyboard: space/enter on the trigger is native; add M for merge */
  window.addEventListener('keydown', e => {
    if (e.key === 'm' || e.key === 'M') {
      if (!S.running && document.activeElement !== els.email) start();
    }
  });

  /* ---- dev handle: ?debug=1 exposes the timeline for scrubbing ----
     __gw.seek(t) jumps the sequence to t seconds so you can park on
     the merge frame while tuning, instead of clicking and waiting. */
  if (/[?&]debug=1/.test(location.search)) {
    window.__gw = {
      S: S, bh: bh, quality: quality, waves: WAVES, targets: () => targets,
      start: start, finish: finish,
      seek: function (sec) {
        if (!S.running) { start(); }
        S.useAudioClock = false;
        S.scrub = null;
        S.t0 = performance.now() - sec * 1000;
        if (sec >= T_MERGE && !S.merged) { S.merged = true; }
        if (sec < T_MERGE) { S.merged = false; S.flash = 0; }
        return sec;
      },
      /* pin the clock so a still can be inspected: the frame loop
         keeps running (gas still evolves) but the timeline holds */
      scrub: function (sec) {
        if (!S.running) { start(); }
        S.useAudioClock = false;
        S.merged = sec >= T_MERGE;
        if (!S.merged) S.flash = 0;
        S.scrub = sec;
        return sec;
      },
      play: function () { S.scrub = null; S.t0 = performance.now(); }
    };
  }

  requestAnimationFrame(frame);
})();
