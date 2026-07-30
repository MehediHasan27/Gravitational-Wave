/* ============================================================
   audio.js — procedural gravitational-wave audio (Web Audio API)
   ------------------------------------------------------------
   No audio files. Everything is synthesised, which is both smaller
   than an mp3 and more accurate: the pitch follows the same
   post-Newtonian chirp law that drives the orbit on screen, so
   sound and picture cannot drift apart by construction.

     f(t) ∝ (t_c − t)^(−3/8)

   Two chirp layers on purpose. The physical one runs 35 → 260 Hz,
   which is real but nearly inaudible on laptop speakers. The
   audible one is the same curve shifted up ~4x, which is exactly
   what LIGO does to make its detections playable.

   Autoplay policy: nothing can start without a user gesture, so
   the whole engine stays uninitialised until start() is called
   from a click. Not a limitation to work around — the page is
   built so the merger IS the click.
   ============================================================ */

/* Single source of truth for the chirp, shared with main.js.
   x is the fraction of the inspiral elapsed; the return value is the
   frequency / orbital-rate multiplier over its starting value.

   The sqrt() is a deliberate time-warp, not a mistake. The real
   (t_c - t)^(-3/8) divergence puts ~90% of its action in the last 2%
   of the inspiral: on screen that is six seconds of almost nothing
   followed by one frame of everything, and in the ear it is a click
   rather than a chirp. Warping the input spreads the sweep across
   the whole timeline without changing the shape of the law. Both the
   audio curve and the orbit read from here, so they cannot drift. */
window.GWChirp = function (x) {
  x = Math.max(0, Math.min(1, x));
  const u = Math.sqrt(x);
  return Math.min(Math.pow(1 - u * 0.997, -0.375), 7.4);
};

window.GWAudio = (function () {
  'use strict';

  const F0 = 35;      // physical starting frequency, Hz
  const SHIFT = 4.2;  // audible-layer transposition

  let ctx = null;
  let master, comp, wet, dry, conv;
  let enabled = false;
  let live = [];      // nodes to force-stop on abort

  function noiseBuffer(dur) {
    const n = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const b = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  /* procedural impulse response: decaying noise + a few early
     reflections. Cheaper than shipping a 300kb IR wav. */
  function impulse(dur, decay) {
    const n = Math.floor(ctx.sampleRate * dur);
    const b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < n; i++) {
        const t = i / n;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
      }
      [0.013, 0.029, 0.047, 0.081].forEach((tap, k) => {
        const i = Math.floor(tap * ctx.sampleRate * (1 + ch * 0.07));
        if (i < n) d[i] += (k % 2 ? -1 : 1) * 0.55 / (k + 1);
      });
    }
    return b;
  }

  function build() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();

    master = ctx.createGain();
    master.gain.value = 0.0;

    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 22;
    comp.ratio.value = 7;
    comp.attack.value = 0.004;
    comp.release.value = 0.22;

    conv = ctx.createConvolver();
    conv.buffer = impulse(3.2, 2.4);

    wet = ctx.createGain(); wet.gain.value = 0.34;
    dry = ctx.createGain(); dry.gain.value = 1.0;

    master.connect(dry).connect(comp);
    master.connect(conv).connect(wet).connect(comp);
    comp.connect(ctx.destination);
    return true;
  }

  function track(node) { live.push(node); return node; }

  function env(param, t0, pts) {
    param.setValueAtTime(Math.max(pts[0][1], 1e-4), t0);
    for (let i = 1; i < pts.length; i++) {
      param.exponentialRampToValueAtTime(
        Math.max(pts[i][1], 1e-4), t0 + pts[i][0]);
    }
  }

  /* ---------- one-shot voices ---------- */

  function osc(type, t0, dur, freqPlan, gainPlan, dest) {
    const o = track(ctx.createOscillator());
    const g = ctx.createGain();
    o.type = type;
    freqPlan(o.frequency, t0);
    env(g.gain, t0, gainPlan);
    o.connect(g).connect(dest || master);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
    o.onended = () => { try { g.disconnect(); } catch (e) {} };
    return o;
  }

  function noise(t0, dur, filterType, freqPlan, gainPlan, q) {
    const s = track(ctx.createBufferSource());
    s.buffer = noiseBuffer(Math.max(dur, 0.05));
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.Q.value = q == null ? 1.2 : q;
    freqPlan(f.frequency, t0);
    const g = ctx.createGain();
    env(g.gain, t0, gainPlan);
    s.connect(f).connect(g).connect(master);
    s.start(t0);
    s.stop(t0 + dur);
    s.onended = () => { try { g.disconnect(); } catch (e) {} };
    return s;
  }

  /* ---------- public ---------- */

  function ready() {
    if (!ctx && !build()) return false;
    if (ctx.state === 'suspended') ctx.resume();
    return true;
  }

  function setEnabled(v) {
    enabled = !!v;
    if (!enabled) {
      if (ctx) master.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.05);
    } else if (ready()) {
      master.gain.setTargetAtTime(0.85, ctx.currentTime, 0.08);
    }
    return enabled;
  }

  /* Schedules the whole event up front. inspiral seconds of chirp,
     then merge at t0+inspiral, then ringdown. Sample-accurate —
     the browser's audio thread does not care about frame drops. */
  function inspiral(inspiralDur) {
    if (!enabled || !ready()) return 0;
    const t0 = ctx.currentTime + 0.02;
    const D = inspiralDur;

    /* ---- frequency curve, sampled from the chirp law ---- */
    const N = 1024;
    const phys = new Float32Array(N);
    const aud  = new Float32Array(N);
    const harm = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const f = F0 * window.GWChirp(i / (N - 1));
      phys[i] = f;
      aud[i]  = f * SHIFT;
      harm[i] = f * SHIFT * 1.5;   // 3:2, gives the metallic edge
    }

    /* 1. sub bed — the room pressure, not really a pitch */
    osc('sine', t0, D + 0.4,
      (p, t) => { p.setValueAtTime(26, t);
                  p.linearRampToValueAtTime(38, t + D); },
      [[0, 0.02], [D * 0.7, 0.42], [D, 0.72]]);

    /* 2. physical chirp — felt more than heard */
    osc('sine', t0, D,
      (p, t) => p.setValueCurveAtTime(phys, t, D),
      [[0, 0.05], [D * 0.6, 0.30], [D, 0.62]]);

    /* 3. audible chirp — the LIGO whoop */
    osc('sine', t0, D,
      (p, t) => p.setValueCurveAtTime(aud, t, D),
      [[0, 0.012], [D * 0.55, 0.14], [D * 0.9, 0.34], [D, 0.46]]);

    /* 4. harmonic */
    osc('triangle', t0, D,
      (p, t) => p.setValueCurveAtTime(harm, t, D),
      [[0, 0.004], [D * 0.8, 0.05], [D, 0.13]]);

    /* 5. accretion hiss, sweeping up with the orbit */
    noise(t0, D + 0.2, 'bandpass',
      (p, t) => { p.setValueAtTime(190, t);
                  p.exponentialRampToValueAtTime(2600, t + D); },
      [[0, 0.02], [D * 0.7, 0.10], [D, 0.22]], 2.4);

    /* 6. tick track — one click per orbit, accelerating.
       Cheap, and it makes the acceleration legible. */
    let ph = 0;
    for (let i = 0; i < 400; i++) {
      const x = i / 400;
      ph += 1 / (18 * window.GWChirp(x));
      if (ph >= D) break;
      osc('sine', t0 + ph, 0.05,
        (p, t) => { p.setValueAtTime(760 + 900 * x, t);
                    p.exponentialRampToValueAtTime(180, t + 0.05); },
        [[0, 0.05 + 0.13 * x], [0.05, 0.0001]]);
    }

    return t0;
  }

  /* The merge. Called at the merge instant, schedules impact +
     ringdown + the wave leaving. */
  function merge() {
    if (!enabled || !ready()) return;
    const t0 = ctx.currentTime + 0.005;

    /* impact: pitch-dropping sub. This is the "boom". */
    osc('sine', t0, 1.4,
      (p, t) => { p.setValueAtTime(64, t);
                  p.exponentialRampToValueAtTime(17, t + 0.95); },
      [[0, 0.9], [0.06, 1.0], [1.4, 0.0001]]);

    /* body of the impact */
    osc('sawtooth', t0, 0.5,
      (p, t) => { p.setValueAtTime(150, t);
                  p.exponentialRampToValueAtTime(42, t + 0.4); },
      [[0, 0.42], [0.5, 0.0001]]);

    /* the crack — broadband transient */
    noise(t0, 0.9, 'lowpass',
      (p, t) => { p.setValueAtTime(5200, t);
                  p.exponentialRampToValueAtTime(280, t + 0.5); },
      [[0, 0.85], [0.9, 0.0001]], 0.8);

    /* ringdown: quasinormal modes of the remnant. Damped sines,
       fundamental plus overtone, ~250 Hz for 62 solar masses. */
    osc('sine', t0 + 0.01, 1.2,
      (p, t) => { p.setValueAtTime(252, t);
                  p.exponentialRampToValueAtTime(228, t + 0.7); },
      [[0, 0.40], [1.2, 0.0001]]);
    osc('sine', t0 + 0.01, 0.8,
      (p, t) => { p.setValueAtTime(187, t);
                  p.exponentialRampToValueAtTime(171, t + 0.5); },
      [[0, 0.22], [0.8, 0.0001]]);

    /* the wave leaving: descending band of noise */
    noise(t0 + 0.04, 2.6, 'bandpass',
      (p, t) => { p.setValueAtTime(1500, t);
                  p.exponentialRampToValueAtTime(68, t + 2.2); },
      [[0, 0.34], [0.4, 0.24], [2.6, 0.0001]], 3.2);

    /* residual hum of a single spinning hole */
    osc('sine', t0 + 0.6, 4.0,
      (p, t) => { p.setValueAtTime(44, t);
                  p.linearRampToValueAtTime(31, t + 4.0); },
      [[0, 0.02], [0.6, 0.20], [4.0, 0.0001]]);
  }

  function abort() {
    if (!ctx) return;
    const t = ctx.currentTime;
    live.forEach(n => { try { n.stop(t); } catch (e) {} });
    live = [];
    master.gain.cancelScheduledValues(t);
    master.gain.setTargetAtTime(enabled ? 0.85 : 0.0001, t, 0.05);
  }

  return {
    ready, setEnabled, inspiral, merge, abort,
    isEnabled: () => enabled,
    now: () => (ctx ? ctx.currentTime : 0),
    hasCtx: () => !!ctx
  };
})();
