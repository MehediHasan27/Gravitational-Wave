# SINGULARIS — binary black hole merger, live in the browser

> The two bodies had been circling each other for an age, radiating orbital
> energy away as gravitational waves and falling inward to pay for it. That is
> the whole story: a slow leak, then a fast one, then none.

Two black holes spiral in on the hero background and collide. A gravitational
wave sweeps out through the page; everything it reaches fails. Jagged wedges
tear open from the epicentre and black out spacetime itself. For a third of a
second there is no page at all. Then it reassembles out of dust — particles
converge on the silhouette of where the content was, and the real DOM crossfades
back in underneath them as they land.

The page is monochrome. The only colour anywhere is the accretion flow in the
hero canvas, so colour reads as *this is the physical event* rather than as
decoration.

No video file. No audio file. No build step. No dependencies.

## Run it

```bash
node serve.js 4321
```

Then open <http://localhost:4321>. Opening `index.html` directly over `file://`
also works — everything is plain `<script src>`, no ES modules.

Click **INITIATE MERGER** (or press <kbd>M</kbd>). The first click doubles as the
autoplay gesture, so sound turns itself on.

## Files

| File | Role |
|---|---|
| `index.html` | Markup, the SVG displacement filter, overlay layers |
| `assets/style.css` | Page styling **and** the whole distortion system |
| `assets/blackhole.js` | WebGL renderer for the binary (self-contained, ~250 lines) |
| `assets/audio.js` | Procedural Web Audio chirp / impact / ringdown |
| `assets/main.js` | Timeline, wavefront model, per-element DOM writes |
| `serve.js` | Throwaway static file server for local dev |

## How the four hard parts work

### 1. The black holes

Not a ray-marched Schwarzschild metric — that costs 200+ samples per pixel and
buys nothing, because the look being matched isn't "stars bending", it's hot
magnetised gas in an inferno colormap. Instead:

- **Gas** — domain-warped value-noise FBM sampled in `(theta, log r)` around each
  hole, thresholded (`max(turb - k, 0)`) so it resolves into filaments with black
  gaps rather than fog.
- **Spiral arms** — emerge for free from Keplerian shear. The angular advection
  term falls off as `r^-1.15`, so inner gas laps outer gas and winds the noise
  into arms. One line of GLSL, no explicit spiral anywhere.
- **Lensing** — analytic: radial deflection `~1/b` plus a frame-drag rotation
  `~1/r`, both clamped. Unclamped `1/r²` sends sample coordinates to infinity
  next to the horizon and you get a hard black rim with garbage inside it.
- **Horizons** — hard `smoothstep` discs on *unlensed* coordinates. A lensed
  shadow is more correct and much less stable; a clean disc never flickers.
- **Camera** — the orbital plane is flattened by `uTilt`, animated from nearly
  edge-on to nearly face-on across the inspiral.

Density from the two tori is combined with a **soft max**, not a sum. In the last
half second they overlap almost completely, and adding them clips the colormap to
a flat cream disc.

### 2. The chirp — one function, both senses

`window.GWChirp(x)` in `assets/audio.js` is the single source of truth. It drives
orbital rate, separation, audio pitch, screen shake, and grain density. Sound and
picture cannot drift apart, because there is nothing to drift.

It applies the real post-Newtonian law `f ∝ (t_c − t)^(−3/8)`, but to a
`sqrt(x)`-warped input. That warp is deliberate: the true divergence puts ~90% of
its action in the last 2% of the inspiral, which on screen is six seconds of
almost nothing followed by one frame of everything, and in the ear is a click
rather than a chirp.

### 3. The ripple through live DOM

Three techniques stacked, because no single one does the whole job:

**A. Per-element transform wave** — the geometry. Every `[data-warp]` element gets
two registered custom properties written each frame: `--w`, the signed wave
amplitude at its distance from the epicentre, and `--tr`, its tear progress. CSS
turns those two numbers into translate + skew + scale + rotate + blur + opacity +
a monochrome misregistration shadow. The headline splits per glyph and short copy
splits per word, so the smallest independent box is the unit both the ripple and
the tear act on.

`@property --w { syntax: '<number>' }` is load-bearing. Without registration it's
an unparsed string and every `calc()` collapses.

**B. Masked `backdrop-filter` ring** — the lens. A fixed overlay with
`blur + grayscale + contrast + brightness`, masked to a ring by an animated
`radial-gradient`. It distorts everything behind it, live text included, with
zero repaint of that DOM. The spacetime lattice lives in its own fixed layer
specifically so this ring has something to visibly kink — and so the tear can
fade and blur it independently.

**C. SVG `feDisplacementMap`** — the only true pixel-level displacement of live
text. Applied to the **hero subtree only**, one-shot, and the `filter` property is
removed entirely when idle. This is the expensive one.

Distances are measured in **viewport** space, from document-space centres cached
once minus `scrollY`. The wave hits whatever the reader is actually looking at,
and stays correct if they scroll mid-event.

### 3b. The tear and the reassembly

The tear rides the primary wavefront, so there is one front, not two. Speed is
set (2600 px/s) so it clears the largest plausible viewport inside the rip phase —
a slower front would still be tearing during the void and the two acts would
smear together.

| Phase | `shockT` | What happens |
|---|---|---|
| RIP | 0 → 0.70s | Everything the front reaches is thrown along its radial direction, spun, blurred and faded. Eight jagged wedges open from the epicentre, filled opaque black with hot white edges, widest in the middle so the remnant stays visible at the base. |
| VOID | 0.70 → 1.00s | Nothing. No page. |
| REFORM | 1.00 → 3.40s | ~2600 particles converge on the silhouette; DOM crossfades in from behind, staggered so what was closest to the merger returns first. Wedges heal. |
| SETTLE | 3.40 → 5.00s | Remnant rings down, trigger re-arms. |

Particle targets come from an offscreen silhouette of the page: real letterforms
for the headline (`fillText` with the computed font, centred per glyph rect
because the negative letter-spacing otherwise lands each letter off its own box),
dashes along each line box for body copy, outlines plus interior rules for boxes.
Positions are stored in **document** space so scrolling between build and playback
stays correct, and the cloud is rebuilt at merge if the reader scrolled far during
the inspiral.

The cloud is drawn under one `globalAlpha` with per-particle brightness carried by
size, rather than 2600 fill-style changes per frame. Rotation scales inversely
with element size — a glyph tumbles at 50°, a 400px button at 16°, because a whole
button at 45° reads as a bug rather than as debris.

The two crossfade windows barely overlap on purpose. Run them together and every
glyph reads as a double exposure.

### 4. Violence

- **Shake** — trauma model: amplitude is `trauma²`, decaying ~9%/frame. It lives on
  a dedicated `#shake` wrapper that only ever receives `translate3d` + `rotate`, so
  it can never fight the per-element warp transforms.
- **Held frame** — gas time and advection freeze for 100ms at the merge instant.
  The stillness is what makes the impact land; more motion is just more noise.
- **Flash** — `mix-blend-mode: screen` radial burst, short and dimmed.
- **Grain** — generated as a data URI at load, screened (not overlaid — overlay
  against a near-black page resolves to near-black).
- **Haptics** — `navigator.vibrate` at merge. Android Chrome only, silently absent
  on iOS, so nothing depends on it.

## Audio

Fully synthesised, ~40 lines of graph:

| Layer | What it is |
|---|---|
| Sub bed | 26→38 Hz sine, room pressure |
| Physical chirp | 35→260 Hz, the real frequency range — felt, barely heard |
| Audible chirp | same curve ×4.2, the LIGO whoop |
| Harmonic | 3:2 triangle, gives the metallic edge |
| Accretion hiss | bandpassed noise sweeping 190→2600 Hz |
| Tick track | one click per orbit, accelerating — makes the acceleration legible |
| Impact | 64→17 Hz pitch drop + saw body + broadband crack |
| Ringdown | damped sines at ~252 Hz and ~187 Hz (quasinormal modes) |
| Wave leaving | bandpassed noise descending 1500→68 Hz |
| Tear | resonant noise collapsing 4200→320 Hz, sheet-metal shriek, 14 granular shreds |
| Reform | 26 quiet bells arriving in a rising cluster under a filter swell |
| Reverb | procedural impulse response — decaying noise plus early reflections |

Everything is scheduled up front on the audio thread, so frame drops cannot make
it stutter. The real LIGO GW150914 recording is public, but it's 0.2s long and
would need stretching anyway; synthesis wins here.

## Motion safety

This page is a provocation and vestibular disorders are real.

- `prefers-reduced-motion: reduce` selects **REDUCED** (34% amplitude) by default.
- The on-screen **FULL / REDUCED / OFF** control overrides the OS preference in
  either direction and persists to `localStorage`. Some people set the OS flag for
  unrelated reasons and still want the show; others want it off regardless.
- **OFF** kills every warp channel and hides all six overlays — including the rip
  and the dust — while leaving the page fully usable. The page never disappears.
- **REDUCED** keeps the sequence but at 34% amplitude, with 45% of the particles.
- Flash is single, short, and dimmed — well under 3 flashes/sec.
- Total event length is ~11.5s with a hard end.

## Performance

- Fragment shader is 4-octave FBM ×3 fields. DPR capped at 1.75.
- A rolling frame-time watchdog drops DPR to 1.0 above ~26ms average and disables
  the SVG filter above ~34ms.
- The SVG filter is also gated off up front on ≤4 logical cores.
- Only `transform` / `opacity` / `filter` are ever animated — no layout properties.
- `will-change` is added on trigger and removed on completion, never left on.
- 71 warp targets × one `setProperty` per frame, skipped when the value hasn't
  moved. Roughly 0.3ms.
- No WebGL → static gradient stand-in, page stays fully functional.

## Tuning

Append `?debug=1` for a console handle:

```js
__gw.marks        // { merge, rip, void, reform, end } — the act boundaries
__gw.scrub(6.7)   // pin the clock there so you can inspect a still
__gw.seek(6.4)    // jump the timeline and keep playing
__gw.play()       // release the pin
__gw.bh.state     // live shader uniforms — mutate freely
__gw.bh.setDpr(1) // force a resolution
__gw.S            // timeline state (trauma, shockT, reformP, ripOpen, epicentre)
__gw.dust.n       // particle count actually built
```

Timeline constants are at the top of `assets/main.js`; `WAVES`, `FRONT_SPEED`,
`TEAR_RAMP` and `DUST_MAX` are right below them. Wedge count and width live in
`buildRip`. Shader look is tuned via the constants in `diskField` / `armField` /
`palette` in `assets/blackhole.js`.

## Known trade-offs

- Content far below the fold is past the wavefront before it can be scrolled to.
  The wave is viewport-relative by design — it hits what's on screen.
- `backdrop-filter` over a full viewport during shake is the most expensive thing
  here on iOS Safari. Test on a real device, not the simulator.
- The orbital rate is time-dilated. Real `f_orb` at plunge is ~130 Hz, which on a
  screen is a grey disc.
