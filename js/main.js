/* ===========================================================================
 * main.js — page wiring
 *
 * Order of operations:
 *   1. load GSAP / ScrollTrigger / Lenis (CDN, local vendor fallback)
 *   2. read the frame manifest, preload the sequence behind the loader
 *   3. hand the loader off, start Lenis, build the ScrollTriggers
 * ======================================================================== */

import { FrameSequence } from './frame-sequence.js';

/* ------------------------------------------------------------- config --- */

const CONFIG = {
  framesPath: 'public/frames/',
  manifest: 'public/frames/frames.json',

  /* Under this viewport width the sequence loads every 2nd frame — half the
     bytes for a difference nobody sees on a phone-sized canvas. */
  mobileBreakpoint: 768,
  mobileFrameStep: 2,

  /* Lerp factor per 60fps frame. Higher tracks the scrollbar more tightly,
     lower feels heavier. 0.14 ≈ settles in ~150ms. */
  smoothing: 0.14,

  /* Which frame the reduced-motion still shows, as a ratio through the
     sequence. 0.5 is the middle — usually the most "resolved" image. */
  stillRatio: 0.45,
};

/* Scripts are loaded at runtime rather than with <script> tags so a blocked
   or slow CDN degrades to the vendored copy instead of an unusable page. */
const LIBS = [
  {
    global: 'gsap',
    urls: ['https://cdnjs.cloudflare.com/ajax/libs/gsap/3.13.0/gsap.min.js', 'vendor/gsap.min.js'],
  },
  {
    global: 'ScrollTrigger',
    urls: ['https://cdnjs.cloudflare.com/ajax/libs/gsap/3.13.0/ScrollTrigger.min.js', 'vendor/ScrollTrigger.min.js'],
  },
  {
    global: 'Lenis',
    urls: ['https://cdn.jsdelivr.net/npm/lenis@1.3.26/dist/lenis.min.js', 'vendor/lenis.min.js'],
  },
];

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------ helpers --- */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = false; // preserve execution order between libs
    el.onload = resolve;
    el.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(el);
  });
}

/** Try each URL in turn; resolve as soon as the global appears. */
async function loadLib({ global, urls }) {
  if (window[global]) return true;
  for (const url of urls) {
    try {
      await loadScript(url);
      if (window[global]) return true;
    } catch {
      /* try the next source */
    }
  }
  return false;
}

/**
 * Length of the pinned scroll, in pixels.
 *
 * The hero track is `100svh + (--pin-vh)vh` tall and the hero itself is one
 * viewport tall, so the sticky travel — the distance the hero stays put while
 * the page scrolls under it — is the track height minus one viewport. Reading
 * it off the element rather than recomputing it from the token keeps JS and
 * CSS from disagreeing about what `svh` means on mobile browsers.
 */
function pinDistance(track) {
  return Math.max(0, track.offsetHeight - window.innerHeight);
}

/* ------------------------------------------------------------- loader --- */

const loaderEl = $('#loader');
const percentEl = $('#loader-percent');
const barEl = $('#loader-bar');
const labelEl = $('#loader-label');

let displayedPercent = 0;

/** Track the real load ratio, but never let the number go backwards. */
function setLoaderProgress(ratio) {
  const pct = Math.min(100, Math.round(ratio * 100));
  if (pct <= displayedPercent) return;
  displayedPercent = pct;
  percentEl.textContent = String(pct);
  barEl.style.width = `${pct}%`;
}

function dismissLoader() {
  labelEl.textContent = 'Ready';
  document.body.classList.remove('is-loading');
  // One beat at 100% before fading, so the counter doesn't flash past it.
  return new Promise((resolve) => {
    setTimeout(() => {
      loaderEl.classList.add('is-done');
      setTimeout(() => {
        loaderEl.remove();
        resolve();
      }, 850); // matches the CSS opacity transition
    }, 220);
  });
}

function loaderFailed(message) {
  labelEl.textContent = message;
  document.body.classList.remove('is-loading');
  setTimeout(() => loaderEl.classList.add('is-done'), 1400);
}

/* --------------------------------------------------------------- init --- */

async function init() {
  document.body.classList.add('is-loading');
  $('#year').textContent = String(new Date().getFullYear());

  const canvas = $('#sequence');
  const step = window.innerWidth <= CONFIG.mobileBreakpoint ? CONFIG.mobileFrameStep : 1;

  const readoutCurrent = $('#frame-current');
  const readoutTotal = $('#frame-total');

  const sequence = new FrameSequence({
    canvas,
    manifestUrl: CONFIG.manifest,
    basePath: CONFIG.framesPath,
    step,
    smoothing: CONFIG.smoothing,
    onFrame: (i, total) => {
      if (!readoutCurrent) return;
      readoutCurrent.textContent = String(i + 1).padStart(String(total).length, '0');
    },
  });

  window.__seq = sequence; // handy for poking at the sequence from the console

  /* --- 1. manifest -------------------------------------------------- */
  try {
    await sequence.loadManifest();
  } catch (err) {
    console.error(err);
    loaderFailed('Could not load the frame sequence');
    return;
  }
  if (readoutTotal) readoutTotal.textContent = String(sequence.frameCount);

  sequence.observeResize();

  /* --- 2. reduced motion: one frame, no pin, no scrub ---------------- */
  if (prefersReducedMotion) {
    await sequence.loadStill(CONFIG.stillRatio);
    setLoaderProgress(1);
    await dismissLoader();
    // Everything below the hero is already visible via the CSS media query.
    return;
  }

  /* --- 3. preload the whole sequence -------------------------------- */
  await sequence.preload((loaded, total, ratio) => {
    setLoaderProgress(ratio);
    labelEl.textContent = `Loading sequence · ${loaded}/${total}`;
  });

  sequence.setProgressImmediate(0);
  sequence.start();

  /* --- 4. libraries -------------------------------------------------- */
  const results = await Promise.all(LIBS.map(loadLib));
  const [hasGsap, hasScrollTrigger, hasLenis] = results;

  await dismissLoader();

  if (!hasGsap || !hasScrollTrigger) {
    // Without ScrollTrigger there is no pin; fall back to a plain sticky-style
    // scrub driven by the hero's own position so the hero still animates.
    console.warn('GSAP/ScrollTrigger unavailable — using fallback scroll driver.');
    startFallbackScrub(sequence);
    revealWithoutGsap();
    return;
  }

  const { gsap, ScrollTrigger } = window;
  gsap.registerPlugin(ScrollTrigger);

  if (hasLenis) setupLenis(gsap, ScrollTrigger);
  setupHero(gsap, ScrollTrigger, sequence);
  setupReveals(gsap, ScrollTrigger);
  setupNav(gsap, ScrollTrigger);

  ScrollTrigger.refresh();
}

/* -------------------------------------------------------------- lenis --- */

function setupLenis(gsap, ScrollTrigger) {
  const lenis = new window.Lenis({
    duration: 1.1,
    // Slightly overshooting exponential — the "expensive scrollbar" feel.
    easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
    smoothWheel: true,
    // Touch devices already have momentum scrolling; doubling it feels wrong.
    syncTouch: false,
  });

  // Lenis takes over the scroll position, so ScrollTrigger has to be told when
  // it changes rather than listening for native scroll events.
  lenis.on('scroll', ScrollTrigger.update);

  // Drive Lenis from GSAP's ticker so both run on one rAF loop, in one order.
  gsap.ticker.add((time) => lenis.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);

  // In-page anchors have to go through Lenis to stay in sync.
  $$('a[href^="#"]').forEach((link) => {
    link.addEventListener('click', (e) => {
      const id = link.getAttribute('href');
      if (!id || id === '#') return;
      const target = document.querySelector(id);
      if (!target) return;
      e.preventDefault();
      lenis.scrollTo(target, { offset: 0, duration: 1.3 });
    });
  });

  window.__lenis = lenis; // handy for debugging in the console
  return lenis;
}

/* ---------------------------------------------------------------- hero --- */

function setupHero(gsap, ScrollTrigger, sequence) {
  const track = $('#hero-track');

  const tl = gsap.timeline({
    scrollTrigger: {
      trigger: track,
      /* progress 0 → the track's top reaches the top of the viewport, which is
                      the instant the sticky hero starts holding position
         progress 1 → the track's bottom reaches the bottom of the viewport,
                      the instant it lets go
         Between those two the hero is motionless on screen and the scroll
         distance is exactly `pinDistance()`. No pin, no pin-spacer: the
         `position: sticky` in CSS already did that job. */
      start: 'top top',
      end: 'bottom bottom',
      scrub: true,
      invalidateOnRefresh: true,
      // ── the one line that connects scroll to frames ──
      onUpdate: (self) => sequence.setProgress(self.progress),
    },
  });

  /* Text beats. The timeline is 1 unit long, so every position below reads
     directly as a fraction of the pinned scroll:
        0.00 → hero pins          1.00 → hero releases                       */
  const beat1 = $('.hero__beat[data-beat="1"]');
  const beat2 = $('.hero__beat[data-beat="2"]');
  const beat3 = $('.hero__beat[data-beat="3"]');

  gsap.set([beat2, beat3], { opacity: 0, y: 60 });

  tl
    // Beat 1 holds, then lifts away over the first third.
    .to(beat1, { opacity: 0, y: -70, filter: 'blur(6px)', duration: 0.18, ease: 'power1.in' }, 0.18)
    // Beat 2 crosses in behind it and leaves before the two-thirds mark.
    .to(beat2, { opacity: 1, y: 0, duration: 0.16, ease: 'power2.out' }, 0.32)
    .to(beat2, { opacity: 0, y: -60, filter: 'blur(6px)', duration: 0.16, ease: 'power1.in' }, 0.58)
    // Beat 3 lands last and stays through the release.
    .to(beat3, { opacity: 1, y: 0, duration: 0.16, ease: 'power2.out' }, 0.7)
    // The scroll cue only makes sense before the user has scrolled.
    .to('#hero-cue', { opacity: 0, duration: 0.1, ease: 'none' }, 0.04);

  // Refreshing on resize keeps the pin length and the spacer in agreement.
  window.addEventListener('resize', () => ScrollTrigger.refresh(), { passive: true });
}

/* ------------------------------------------------------------- reveals --- */

function setupReveals(gsap, ScrollTrigger) {
  // Single elements.
  $$('[data-reveal]').forEach((el) => {
    gsap.to(el, {
      opacity: 1,
      y: 0,
      duration: 0.9,
      ease: 'power3.out',
      scrollTrigger: { trigger: el, start: 'top 88%', once: true },
    });
  });

  // Groups — children come in one after another.
  $$('[data-stagger]').forEach((group) => {
    gsap.to(group.children, {
      opacity: 1,
      y: 0,
      duration: 0.85,
      ease: 'power3.out',
      stagger: 0.09,
      scrollTrigger: { trigger: group, start: 'top 85%', once: true },
    });
  });
}

/* ----------------------------------------------------------------- nav --- */

function setupNav(gsap, ScrollTrigger) {
  const nav = $('#nav');
  ScrollTrigger.create({
    start: 'top -120',
    end: 99999,
    onUpdate: (self) => {
      // Hide going down, show going back up.
      nav.classList.toggle('is-hidden', self.direction === 1 && self.scroll() > 200);
    },
  });
}

/* -------------------------------------------------- no-GSAP fallbacks --- */

/** Scrub the sequence from raw scroll position if ScrollTrigger never loaded.
    The sticky pin is pure CSS, so only the progress read has to be replaced. */
function startFallbackScrub(sequence) {
  const track = $('#hero-track');

  const update = () => {
    const distance = pinDistance(track) || 1;
    // Identical mapping to the ScrollTrigger path, derived by hand: how far
    // the track's top has travelled above the viewport, over the pin distance.
    const travelled = -track.getBoundingClientRect().top;
    sequence.setProgress(Math.min(1, Math.max(0, travelled / distance)));
  };

  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update, { passive: true });
  update();
}

/** IntersectionObserver reveals, for the same no-GSAP case. */
function revealWithoutGsap() {
  const targets = [...$$('[data-reveal]'), ...$$('[data-stagger]').flatMap((g) => [...g.children])];
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.style.transition = 'opacity .8s cubic-bezier(.16,1,.3,1), transform .8s cubic-bezier(.16,1,.3,1)';
        entry.target.style.opacity = '1';
        entry.target.style.transform = 'none';
        io.unobserve(entry.target);
      });
    },
    { rootMargin: '0px 0px -12% 0px' }
  );
  targets.forEach((el) => io.observe(el));
}

/* --------------------------------------------------------------- boot --- */

init().catch((err) => {
  console.error(err);
  loaderFailed('Something went wrong');
});
