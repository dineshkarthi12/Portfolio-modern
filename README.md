# Portfolio — scroll-driven frame sequence

A single-page portfolio whose hero is an Apple-style image sequence scrubbed by
scroll: 150 JPEG stills painted to a `<canvas>`, pinned for 400 viewport-heights
and interpolated so a fast flick eases into place instead of snapping.

Vanilla HTML + CSS + JS. **No build step** — the site is static files. Node is
only used by the frame-compression script and the local dev server.

---

## Run it

The page `fetch()`es the frame manifest, so it must be served over HTTP;
opening `index.html` as a `file://` URL will stall on the loader.

```bash
npm install          # only needed for the frame script (sharp)
npm run serve        # http://localhost:5173
```

Any static server works — `python3 -m http.server`, `npx serve`, Netlify,
GitHub Pages, S3. There is nothing to compile.

---

## File structure

```
.
├── index.html                    # all markup: loader, hero, about, skills,
│                                 #   projects, contact, footer
├── css/
│   └── styles.css                # tokens, layout, the sticky-pin rules,
│                                 #   grain overlay, reduced-motion block
├── js/
│   ├── main.js                   # page wiring: loader, Lenis, ScrollTriggers
│   └── frame-sequence.js         # the canvas engine (framework-agnostic)
├── public/
│   └── frames/
│       ├── ezgif-frame-001.jpg   # …150 frames
│       └── frames.json           # generated manifest — see below
├── scripts/
│   ├── compress-frames.mjs       # resize / re-encode / write the manifest
│   └── serve.mjs                 # zero-dependency static server
├── vendor/                       # local GSAP + ScrollTrigger + Lenis fallback
└── package.json
```

`vendor/` exists so a blocked or slow CDN degrades to a local copy instead of a
dead page. `js/main.js` tries the CDN first and falls back automatically; if
even that fails, the hero still scrubs through a plain scroll listener and the
reveals run on `IntersectionObserver`.

---

## Swapping in a different frame sequence

The runtime hardcodes **nothing** about the sequence — not the frame count, not
the filename pattern, not the padding. It all comes from `frames.json`, which
the compression script generates by scanning the folder.

### 1. Put the new frames somewhere

Export your video or GIF to numbered stills (ezgif, `ffmpeg -i in.mp4
frame-%04d.jpg`, After Effects — anything). Any of these work:

```
frame-0001.jpg   shot_001.png    render.001.webp    myseq1.jpg
```

The only requirement is that each filename ends in a run of digits before the
extension, and that the digits count up.

### 2. Run the script

```bash
# in place, on public/frames
npm run frames

# or from a separate source folder
node scripts/compress-frames.mjs --src raw-frames --out public/frames

# tune the budget
node scripts/compress-frames.mjs --width 1280 --quality 65
```

Flags: `--src`, `--out`, `--width` (default 1600, never upscales),
`--quality` (default 70), `--force`, `--manifest-only`.

> **Why `--force` exists.** Some exporters — ezgif included — already encode
> below the target quality, so a q70 re-encode would *add* bytes and a second
> round of generation loss. By default the script keeps a JPEG source untouched
> whenever the re-encode comes out larger, and says how many frames it skipped.
> `--force` overrides that. (For the bundled sequence, 145 of 150 frames were
> already smaller; the run finished at 2.41 MB.)

### 3. That's it

The script writes `public/frames/frames.json`:

```json
{
  "prefix": "ezgif-frame-",
  "padding": 3,
  "ext": ".jpg",
  "start": 1,
  "count": 150,
  "width": 853,
  "height": 480
}
```

and `frame-sequence.js` rebuilds every URL from it:

```js
url = basePath + prefix + String(start + i).padStart(padding, '0') + ext
```

Reload the page. If your frames live somewhere other than `public/frames/`,
change the two paths at the top of `js/main.js`:

```js
const CONFIG = {
  framesPath: 'public/frames/',
  manifest:   'public/frames/frames.json',
  …
};
```

Frames of a different aspect ratio need no changes at all — the draw step
computes a cover fit against whatever the canvas happens to be.

---

## The scroll-to-frame math

Three pieces, each isolated so they can be reasoned about separately.

### 1. The pin → a progress value in `[0, 1]`

The pin is pure CSS. `.hero-track` is one viewport tall *plus* `--pin-vh`
viewport-heights of extra room, and `.hero` is `position: sticky; top: 0`
inside it:

```css
.hero-track { height: calc(100svh + (var(--pin-vh) * 1vh)); }
.hero       { position: sticky; top: 0; height: 100svh; }
```

The distance the hero stays put — the track height minus one viewport — *is*
the pin distance. No pin-spacer element to keep in sync, no layout jump when
GSAP hands the element back, and the hero still holds position with JS off.

ScrollTrigger only *reads* that travel:

```js
{ trigger: track, start: 'top top', end: 'bottom bottom', scrub: true }
```

`progress` is 0 the instant the track's top reaches the top of the viewport
(the hero starts holding) and 1 when the track's bottom reaches the bottom of
the viewport (it lets go). Exactly the sticky travel, already clamped and
normalised.

### 2. Progress → a frame index

```js
targetIndex = progress * (frameCount - 1);
```

`frameCount - 1`, not `frameCount`: with 150 frames the valid indices are
0…149, so `progress === 1` has to land on 149. Multiplying by 150 would ask for
index 150 at the very bottom of the pin and paint nothing.

The result is deliberately left **fractional**. Rounding happens once, at paint
time, *after* the smoothing — rounding here would quantise the target and make
the lerp chase a staircase instead of a ramp.

This is also why loading every 2nd frame on mobile needs no special case:
`frameCount` is simply half, so the same progress maps onto the shorter array
and the sequence still opens and closes on the same picture.

### 3. Smoothing → the painted frame

Scroll events are jumpy; a wheel notch can jump 15 frames at once. So the
painted index chases the target on a `requestAnimationFrame` loop instead of
following it directly:

```js
const k = 1 - Math.pow(1 - smoothing, dt / (1000 / 60));
renderIndex += (targetIndex - renderIndex) * k;
```

The exponent is what makes it frame-rate independent. A plain
`renderIndex += diff * 0.14` moves twice as fast on a 120 Hz display as on
60 Hz; re-basing the factor against elapsed time gives identical easing
everywhere. `smoothing` lives in `CONFIG` — raise it to track the scrollbar
more tightly, lower it for more weight.

Only then is the index rounded, and the canvas is repainted **only when that
integer changes** — a scroll that moves the target by 0.3 of a frame costs
nothing.

### And the drawing

Frames are 16:9-ish; the canvas is whatever the viewport is. An
`object-fit: cover` fit, by hand:

```js
const scale = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
```

`max`, not `min` — `min` would be `object-fit: contain` and letterbox. The
scaled image is then centred so the overflow bleeds half off each edge. Never
stretches, at any aspect ratio. The canvas backing store is resized to its CSS
box × DPR (capped at 2) on every resize, which clears it, so a repaint is
forced right after.

---

## What else is in there

**Loader.** The percentage tracks *actually decoded* frames, not a timer.
Requests are capped at 8 in flight — firing 150 at once stalls the connection
pool and delays exactly the early frames you need first. Each frame gets
`img.decode()`ed before it counts as loaded, so the first scrub never hits a
decode stall. Body scroll is locked until it fades.

**Why canvas and not `<img>` swapping.** Changing an `<img>`'s `src` hands
every frame back to the browser's loader and decoder, which shows as a
one-frame flash of nothing. `drawImage` of an already-decoded `HTMLImageElement`
is a straight blit.

**Reduced motion.** `prefers-reduced-motion: reduce` sets `--pin-vh: 0` (so the
track collapses to one viewport and the hero never pins), loads **one** frame
instead of 150, hides the later text beats, and drops the reveals to their
resting state. It's a bandwidth win as much as a motion one.

**Mobile.** Under 768 px the sequence loads every 2nd frame — half the bytes.
The pin also shortens: 400 vh → 300 vh under 900 px → 220 vh under 600 px,
because a long pin feels endless on touch. Both live in CSS (`--pin-vh`) and
are read back by JS, so there's one source of truth.

**Lenis** provides the smooth scrollbar feel, driven from GSAP's ticker so both
share one rAF loop. `lenis.on('scroll', ScrollTrigger.update)` keeps
ScrollTrigger in sync, and in-page anchors are routed through `lenis.scrollTo`.

---

## Making it yours

| What | Where |
|---|---|
| Name, bio, projects, links | `index.html` |
| Accent colour, fonts, spacing | `:root` in `css/styles.css` |
| Pin length per breakpoint | `--pin-vh` in `css/styles.css` |
| Smoothing, mobile step, frame paths | `CONFIG` in `js/main.js` |
| Hero text beat timing | `setupHero()` in `js/main.js` — timeline positions read directly as fractions of the pin (`0.32` = 32 % through) |

Project cover art is CSS gradients (`.project__media--a/b/c`), so there are no
extra image requests to wire up. Swap them for real screenshots by replacing
those rules with a `background-image`.
