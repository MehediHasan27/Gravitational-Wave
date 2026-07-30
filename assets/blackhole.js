/* ============================================================
   blackhole.js — binary black hole renderer (WebGL1, no deps)
   ------------------------------------------------------------
   Not a ray-marched Schwarzschild metric. That costs 200+ samples
   per pixel and buys nothing here, because the reference look is
   not "stars bending" — it is hot magnetised gas in an inferno
   colormap. So:

     - gas field  : domain-warped value-noise FBM sampled in
                    (theta, log r) around each hole
     - spiral arms: emerge for free from Keplerian shear, i.e.
                    advection phase scaled by r^-1.25, because
                    inner gas laps outer gas
     - lensing    : analytic deflection (~1/b) + frame-drag
                    rotation (~1/r), applied to the sample coords
     - horizons   : hard smoothstep discs, drawn last
     - camera     : orbital plane flattened by uTilt, animated
                    edge-on -> face-on over the inspiral

   Everything the timeline needs to drive is a uniform. main.js
   owns the clock; this file owns pixels.
   ============================================================ */

window.BlackHole = (function () {
  'use strict';

  const VERT = `
    attribute vec2 aPos;
    void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }
  `;

  const FRAG = `
  precision highp float;

  uniform vec2  uRes;
  uniform float uT;      // gas evolution time (freezable)
  uniform float uSpin;   // integrated advection phase
  uniform float uAngle;  // orbital phase
  uniform float uSep;    // separation, world units
  uniform float uTilt;   // 0.12 edge-on .. 1.0 face-on
  uniform float uMerge;  // 0 = binary, 1 = single remnant
  uniform float uFlash;  // merge flash
  uniform float uShock;  // shock radius, world units (0 = none)
  uniform float uWobble; // ringdown quasinormal wobble, -1..1
  uniform float uZoom;
  uniform float uMass;   // mass ratio m2/m1
  uniform float uGlow;

  /* ---------- inferno colormap (polynomial fit) ---------- */
  vec3 inferno(float t){
    t = clamp(t, 0.0, 1.0);
    vec3 c0 = vec3( 0.00021894,  0.00165100, -0.01948090);
    vec3 c1 = vec3( 0.10651342,  0.56395644,  3.93271239);
    vec3 c2 = vec3(11.60249308, -3.97285397, -15.94239411);
    vec3 c3 = vec3(-41.70399613, 17.43639888, 44.35414520);
    vec3 c4 = vec3(77.16293570, -33.40235894, -81.80730926);
    vec3 c5 = vec3(-71.31942824, 32.62606426, 73.20951986);
    vec3 c6 = vec3(25.13112622, -12.24266895, -23.07032500);
    return max(c0+t*(c1+t*(c2+t*(c3+t*(c4+t*(c5+t*c6))))), vec3(0.0));
  }

  /* the reference frames have deep navy in the diffuse outskirts.
     inferno's low end is near-black, so lift it toward blue. */
  vec3 palette(float d){
    vec3 c = inferno(d);
    float b = smoothstep(0.44, 0.0, d);
    c = mix(c, vec3(0.055, 0.105, 0.50) * (d * 3.6), b * 0.88);
    return c;
  }

  /* ---------- value noise + FBM (unrolled: GLSL ES 1.0 safe) ---------- */
  float hash31(vec3 p){
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }
  float vn(vec3 x){
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    float a = mix(mix(hash31(i+vec3(0,0,0)), hash31(i+vec3(1,0,0)), f.x),
                  mix(hash31(i+vec3(0,1,0)), hash31(i+vec3(1,1,0)), f.x), f.y);
    float b = mix(mix(hash31(i+vec3(0,0,1)), hash31(i+vec3(1,0,1)), f.x),
                  mix(hash31(i+vec3(0,1,1)), hash31(i+vec3(1,1,1)), f.x), f.y);
    return mix(a, b, f.z);
  }
  float fbm2(vec3 p){
    float s = 0.5 * vn(p); p *= 2.03;
    return s + 0.25 * vn(p);
  }
  float fbm4(vec3 p){
    float s = 0.5000 * vn(p); p *= 2.03;
    s     += 0.2500 * vn(p);  p *= 2.01;
    s     += 0.1250 * vn(p);  p *= 2.02;
    s     += 0.0625 * vn(p);
    return s;
  }

  const float RS = 0.042;   // flow scale per unit mass (~ISCO)
  const float RH = 0.024;   // horizon radius per unit mass
  /* RH < RS on purpose: the inner edge of a real accretion torus is
     the ISCO at ~3x the horizon radius, so the black disc has to be
     noticeably smaller than the hole in the gas. */

  /* ---------- accretion torus around one hole ----------
     q must already be circularised (y un-flattened by tilt).
     The hot part is an ANNULUS, not a filled core — in the
     reference every bright vortex has a hard black dot in it. */
  float diskField(vec2 q, float m, float sgn){
    float rs = RS * m;
    float r  = max(length(q), 1e-4);
    float th = atan(q.y, q.x);

    /* Keplerian shear. This one line is what turns blobs into
       arms: angular advection falls off as r^-1.15, so the inner
       flow laps the outer flow and winds the noise into spirals. */
    float adv = sgn * uSpin * 0.50 * pow(max(r, rs * 1.8), -1.15);

    float lr = log(r * 9.0 + 0.85);
    vec2  w  = vec2(cos(th + adv), sin(th + adv));
    vec3  sp = vec3(w * (1.0 + lr * 1.5), lr * 0.6 + uT * 0.05);

    /* domain warp, then threshold. The threshold is what separates
       filaments from fog: below it the gas is simply not there. */
    float turb = fbm4(sp * 2.6 + fbm2(sp * 1.15) * 1.7);
    turb = max(turb - 0.26, 0.0) * 1.45;

    /* Sampling in (theta, log r) is what produces spirals, but it
       also produces perfectly regular concentric shells, because the
       noise lattice repeats every unit of log r. A cartesian
       modulator has no radial period, so it breaks them up. */
    turb *= 0.66 + 0.62 * fbm2(vec3(q * 6.5, uT * 0.05));

    /* sqrt(m), not m: with a linear scaling the lighter body's torus
       collapses to nothing and you only ever see one vortex. */
    float k = sqrt(m);
    float body = exp(-max(r - rs * 2.2, 0.0) * (5.0 / k));
    float ring = 0.85 * exp(-abs(r - rs * 2.20) * (24.0 / k));
    return body * (0.11 + turb * 1.00) + ring * (0.20 + turb * 0.70);
  }

  /* thin bright annulus right at the photon sphere */
  float photonRing(vec2 q, float m){
    return exp(-abs(length(q) - RH * m * 1.5) * (230.0 / sqrt(m))) * 0.80;
  }

  /* ---------- shared tidal arms wrapping the whole system ----------
     Deliberately NOT diskField with a big mass: no photon ring, no
     torus, no horizon. Just thresholded turbulence on a broad
     radial envelope, which is what fills the reference frames. */
  float armField(vec2 q, float sgn){
    float r  = max(length(q), 1e-4);
    float th = atan(q.y, q.x);
    float adv = sgn * uSpin * 0.15 * pow(max(r, 0.15), -0.9);
    float lr = log(r * 2.3 + 0.7);
    vec2  w  = vec2(cos(th + adv), sin(th + adv));
    vec3  sp = vec3(w * (1.0 + lr * 1.05), lr * 0.62 + uT * 0.03);

    float turb = fbm4(sp * 1.75 + fbm2(sp * 0.85) * 1.60);
    turb = max(turb - 0.395, 0.0) * 1.95;
    turb *= 0.60 + 0.70 * fbm2(vec3(q * 2.6, uT * 0.04));

    /* a shell that peaks OUTSIDE the binary, so the arms frame the
       two vortices instead of drowning them */
    float env = exp(-max(r - 0.32, 0.0) * 1.95) * smoothstep(0.07, 0.30, r);
    return env * turb;
  }

  float horizon(vec2 q, float m){
    float rh = RH * m;
    return smoothstep(rh * 0.93, rh * 1.06, length(q));
  }

  /* ---------- analytic lensing: deflect + drag ----------
     Both terms are clamped. Unclamped 1/r^2 sends sample coords to
     infinity next to the horizon, which reads as a hard black rim
     with garbage inside it. */
  vec2 lens(vec2 p, vec2 c, float m, float tilt){
    vec2 d = p - c;
    d.y /= tilt;
    float r2 = dot(d, d) + 0.0030;
    float r  = sqrt(r2);
    float k = min(m * 0.0030 / r2, 0.085);   // radial deflection ~ 1/b
    float a = min(m * 0.0150 / r,  0.85);    // frame-drag swirl ~ 1/r
    float ca = cos(a), sa = sin(a);
    vec2 rot = vec2(d.x * ca - d.y * sa, d.x * sa + d.y * ca);
    rot -= (d / r) * k;
    rot.y *= tilt;
    return c + rot;
  }

  void main(){
    /* World units are normally normalised by height, but on a portrait
       phone a separation of 0.42 height-units is wider than the screen
       and both holes leave the frame. Normalising by whichever axis is
       tighter keeps the binary framed at every aspect ratio. main.js
       repeats this to place the CSS shock epicentre. */
    float unit = min(uRes.x / 0.86, uRes.y);
    vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / unit;
    p /= max(uZoom, 0.05);
    /* sit the binary low in the frame: the copy owns the upper half,
       the gas owns the lower half, and the CTA sits on the boundary
       where it catches the light. main.js mirrors this offset for
       the CSS shock epicentre. */
    p.y += 0.27;

    /* ringdown: the remnant is briefly the wrong shape */
    p += vec2(p.x, -p.y) * uWobble * 0.055;

    /* shockwave displaces the field radially as it passes */
    float rr = max(length(p), 1e-4);
    float band = 0.0;
    if (uShock > 0.001) {
      band = 1.0 - smoothstep(0.0, 0.11, abs(rr - uShock));
      p -= (p / rr) * band * 0.055;
    }

    float tilt = max(uTilt, 0.12);
    float mg   = uMerge;

    /* barycentric positions: lighter body swings wider */
    vec2 dir = vec2(cos(uAngle), sin(uAngle) * tilt);
    float fA = uMass / (1.0 + uMass);
    float fB = 1.0   / (1.0 + uMass);
    vec2 cA = mix( dir * uSep * fA, vec2(0.0), mg);
    vec2 cB = mix(-dir * uSep * fB, vec2(0.0), mg);

    float mA = mix(1.0,   1.42, mg);   // remnant: sum minus what was radiated
    float mB = mix(uMass, 0.30, mg);
    float wB = 1.0 - smoothstep(0.55, 1.0, mg);

    /* lensed sample coords for the gas... */
    vec2 pw = lens(lens(p, cA, mA, tilt), cB, mB * wB, tilt);
    vec2 qA = pw - cA; qA.y /= tilt;
    vec2 qB = pw - cB; qB.y /= tilt;

    /* ...but UNLENSED coords for the horizons. A lensed shadow is
       more correct and much less stable; a clean disc reads better
       and never flickers. */
    vec2 hA = p - cA; hA.y /= tilt;
    vec2 hB = p - cB; hB.y /= tilt;

    /* Soft max, not a sum. In the last half second the two tori
       overlap almost completely, and adding them clips the colormap
       to a flat cream disc. This keeps the brighter flow dominant
       and lets the other one only add to it. */
    float dA = diskField(qA, mA,  1.0);
    float dB = diskField(qB, mB, -1.0) * wB;
    float d  = max(dA, dB) + min(dA, dB) * 0.40;

    vec2 qe = pw; qe.y /= tilt;
    d += armField(qe, 1.0) * (0.62 + 0.45 * mg);

    d += photonRing(hA, mA) + photonRing(hB, mB) * wB;

    /* everything sits in vacuum: kill density toward the edges */
    d *= smoothstep(1.30, 0.26, length(p * vec2(0.86, 1.0)));
    d *= uGlow;

    /* channel-split the colormap lookup while the wave is passing */
    float ab = band * 0.18 + uFlash * 0.10;
    vec3 col = vec3(palette(d * (1.0 + ab)).r,
                    palette(d).g,
                    palette(d * (1.0 - ab)).b);

    /* horizons last, so nothing can write light inside them */
    col *= horizon(hA, mA);
    col *= mix(1.0, horizon(hB, mB), wB);

    /* merge flash + wavefront light */
    col += vec3(1.0, 0.87, 0.64) * uFlash * uFlash * 1.35;
    col += palette(0.86) * band * 0.34;

    /* vignette, soft knee, dither */
    float vig = smoothstep(1.50, 0.30, length(p * vec2(0.84, 1.0)));
    col *= 0.16 + 0.84 * vig;
    col = col / (col + 1.00) * 1.24;
    col += (hash31(vec3(gl_FragCoord.xy, uT)) - 0.5) * 0.018;

    gl_FragColor = vec4(max(col, 0.0), 1.0);
  }
  `;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(s) || 'shader compile failed');
    }
    return s;
  }

  function create(canvas) {
    const opts = {
      alpha: false, antialias: false, depth: false, stencil: false,
      powerPreference: 'high-performance', preserveDrawingBuffer: false
    };
    const gl = canvas.getContext('webgl', opts) ||
               canvas.getContext('experimental-webgl', opts);
    if (!gl) return null;

    let prog;
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(prog) || 'link failed');
      }
    } catch (e) {
      console.warn('[blackhole] ' + e.message);
      return null;
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const U = {};
    ['uRes','uT','uSpin','uAngle','uSep','uTilt','uMerge',
     'uFlash','uShock','uWobble','uZoom','uMass','uGlow']
      .forEach(n => { U[n] = gl.getUniformLocation(prog, n); });

    /* uniform state — main.js mutates this object directly */
    const state = {
      t: 0, spin: 0, angle: 0, sep: 0.42, tilt: 0.45,
      merge: 0, flash: 0, shock: 0, wobble: 0,
      zoom: 1, mass: 0.86, glow: 1
    };

    let dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    let w = 0, h = 0;

    function resize() {
      const r = canvas.getBoundingClientRect();
      const nw = Math.max(1, Math.round(r.width  * dpr));
      const nh = Math.max(1, Math.round(r.height * dpr));
      if (nw === w && nh === h) return;
      w = canvas.width = nw;
      h = canvas.height = nh;
      gl.viewport(0, 0, w, h);
    }

    function setDpr(v) {
      dpr = Math.max(0.5, Math.min(v, 2));
      w = h = 0;
      resize();
    }

    function draw() {
      resize();
      gl.uniform2f(U.uRes, w, h);
      gl.uniform1f(U.uT,      state.t);
      gl.uniform1f(U.uSpin,   state.spin);
      gl.uniform1f(U.uAngle,  state.angle);
      gl.uniform1f(U.uSep,    state.sep);
      gl.uniform1f(U.uTilt,   state.tilt);
      gl.uniform1f(U.uMerge,  state.merge);
      gl.uniform1f(U.uFlash,  state.flash);
      gl.uniform1f(U.uShock,  state.shock);
      gl.uniform1f(U.uWobble, state.wobble);
      gl.uniform1f(U.uZoom,   state.zoom);
      gl.uniform1f(U.uMass,   state.mass);
      gl.uniform1f(U.uGlow,   state.glow);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    window.addEventListener('resize', resize, { passive: true });
    resize();

    return { state, draw, setDpr, getDpr: () => dpr, gl };
  }

  return { create };
})();
