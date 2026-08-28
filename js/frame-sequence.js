/* ===========================================================================
 * frame-sequence.js
 * ---------------------------------------------------------------------------
 * A scroll-scrubbable image sequence rendered to a <canvas>.
 *
 * Nothing here knows about GSAP or the page. The only input is a normalised
 * scroll progress in [0, 1] handed to `setProgress()`; the only output is a
 * frame painted on the canvas. That keeps the scroll driver swappable.
 *
 * Design notes:
 *   - <canvas> + drawImage, never <img> swapping. Swapping an <img>'s src
 *     hands each frame back to the browser's loader/decoder and causes a
 *     one-frame flash of nothing; drawImage of an already-decoded HTMLImage
 *     is a straight blit.
 *   - Every frame is decoded up front so scrubbing never hits a decode stall.
 *   - The painted index is lerped toward the scroll-derived target, so a fast
 *     flick eases into place instead of snapping.
 * ======================================================================== */

/* Cap the backing-store resolution. Beyond 2x the extra pixels cost fill-rate
   and buy nothing visible, especially for upscaled source frames. */
const MAX_DPR = 2;

export class FrameSequence {
  /**
   * @param {object}      opts
   * @param {HTMLCanvasElement} opts.canvas
   * @param {string}      opts.manifestUrl  URL of frames.json (written by scripts/compress-frames.mjs)
   * @param {string}      opts.basePath     folder the frames live in, with trailing slash
   * @param {number}      [opts.step]       load every Nth frame (2 halves the payload on mobile)
   * @param {number}      [opts.smoothing]  0..1 lerp factor per 60fps frame; lower = smoother/laggier
   * @param {Function}    [opts.onFrame]    called with (paintedIndex, totalFrames) after each repaint
   */
  constructor({ canvas, manifestUrl, basePath, step = 1, smoothing = 0.14, onFrame = null }) {
    this.canvas = canvas;
    // `alpha: false` lets the compositor skip per-pixel blending of the canvas
    // against the page — the sequence is fully opaque anyway.
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.manifestUrl = manifestUrl;
    this.basePath = basePath;
    this.step = Math.max(1, Math.floor(step));
    this.smoothing = smoothing;
    this.onFrame = onFrame;

    this.manifest = null;
    this.urls = [];
    this.images = [];

    /** Frame index the scroll position asks for (fractional). */
    this.targetIndex = 0;
    /** Frame index actually being approached by the lerp (fractional). */
    this.renderIndex = 0;
    /** Last integer index painted — guards against redundant redraws. */
    this.paintedIndex = -1;

    this.rafId = null;
    this.lastTime = 0;

    this._onResize = this._onResize.bind(this);
    this._tick = this._tick.bind(this);
  }

  get frameCount() {
    return this.urls.length;
  }

  /* --------------------------------------------------------- manifest --- */

  /**
   * Read frames.json and build the URL list.
   *
   * The manifest describes the sequence generically:
   *   url = basePath + prefix + zeroPad(start + i, padding) + ext
   * so swapping in a different sequence is a re-run of the compress script,
   * never an edit here.
   */
  async loadManifest() {
    const res = await fetch(this.manifestUrl, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`Could not load ${this.manifestUrl} (${res.status})`);
    const m = await res.json();
    this.manifest = m;

    const urls = [];
    for (let i = 0; i < m.count; i += this.step) {
      const n = String(m.start + i).padStart(m.padding, '0');
      urls.push(`${this.basePath}${m.prefix}${n}${m.ext}`);
    }

    // With a step > 1 the last source frame can fall between samples. Append
    // it so the sequence always resolves on its true final frame — otherwise
    // the animation ends a beat early at the bottom of the pin.
    const lastIndex = m.start + m.count - 1;
    const lastUrl = `${this.basePath}${m.prefix}${String(lastIndex).padStart(m.padding, '0')}${m.ext}`;
    if (urls[urls.length - 1] !== lastUrl) urls.push(lastUrl);

    this.urls = urls;
    return m;
  }

  /* ---------------------------------------------------------- loading --- */

  /**
   * Preload (and decode) every frame into an array of Image objects.
   *
   * A bounded number of requests are in flight at once: firing 150 at the
   * browser stalls the connection pool and delays the early frames, which are
   * exactly the ones needed first.
   *
   * @param {(loaded:number, total:number, ratio:number) => void} onProgress
   * @param {number} concurrency
   */
  async preload(onProgress = () => {}, concurrency = 8) {
    const total = this.urls.length;
    this.images = new Array(total);

    let loaded = 0;
    let cursor = 0;

    const report = () => onProgress(loaded, total, total === 0 ? 1 : loaded / total);

    const worker = async () => {
      while (cursor < total) {
        const i = cursor++;
        this.images[i] = await this._loadImage(this.urls[i]);
        loaded++;
        report();
      }
    };

    report();
    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));

    // Paint the opening frame so the hero is never an empty black box.
    this.resize();
    return this.images;
  }

  /**
   * Load exactly one frame — the reduced-motion path, which never needs the
   * other 149. `ratio` is the position through the sequence, so 0.5 is the
   * middle frame.
   */
  async loadStill(ratio = 0) {
    const index = Math.round(ratio * (this.urls.length - 1));
    this.images = new Array(this.urls.length);
    this.images[index] = await this._loadImage(this.urls[index]);
    this.targetIndex = this.renderIndex = index;
    this.resize();
    return index;
  }

  _loadImage(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.decoding = 'async';
      const done = () => resolve(img);
      img.onload = () => {
        // decode() moves the pixel work off the first drawImage call. If it
        // rejects (some browsers throw for cached images) the bitmap is still
        // usable, so resolve either way.
        if (typeof img.decode === 'function') img.decode().then(done, done);
        else done();
      };
      // A missing frame must not deadlock the loader; resolve with a broken
      // image and let the draw step skip it.
      img.onerror = done;
      img.src = url;
    });
  }

  /* ---------------------------------------------------- scroll → frame --- */

  /**
   * THE SCROLL-TO-FRAME MAPPING.
   *
   * `progress` is 0 at the moment the hero pins (its top hits the top of the
   * viewport) and 1 when the pin releases, `--pin-vh` viewport-heights later.
   * ScrollTrigger hands it to us already clamped and already normalised, so
   * the whole mapping is one multiply:
   *
   *     targetIndex = progress × (frameCount − 1)
   *
   * `frameCount − 1`, not `frameCount`: with 150 frames the valid indices are
   * 0…149, so progress 1.0 must land on 149. Multiplying by 150 would ask for
   * index 150 at the very bottom of the pin and paint nothing.
   *
   * The result is deliberately left fractional. Rounding happens once, at
   * paint time, *after* the lerp — rounding here would quantise the target and
   * make the smoothing step chase a staircase instead of a ramp.
   *
   * Note this is independent of `step`: when mobile loads every 2nd frame,
   * `frameCount` is ~half, so the same progress maps onto the shorter array
   * and the sequence still starts and ends on the same picture.
   */
  setProgress(progress) {
    const p = Math.min(1, Math.max(0, progress));
    this.targetIndex = p * (this.frameCount - 1);
  }

  /** Jump straight to a progress value with no easing (resize, init, restore). */
  setProgressImmediate(progress) {
    this.setProgress(progress);
    this.renderIndex = this.targetIndex;
    this.draw(Math.round(this.renderIndex));
  }

  /* ------------------------------------------------------- render loop --- */

  start() {
    if (this.rafId !== null) return;
    this.lastTime = performance.now();
    this.rafId = requestAnimationFrame(this._tick);
  }

  stop() {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  _tick(now) {
    const dt = Math.min(64, now - this.lastTime); // clamp: tab-switch spikes
    this.lastTime = now;

    const diff = this.targetIndex - this.renderIndex;

    if (Math.abs(diff) < 0.01) {
      // Close enough — settle exactly so the loop stops jittering by fractions.
      this.renderIndex = this.targetIndex;
    } else {
      /* Frame-rate independent lerp.
         A naive `renderIndex += diff * k` moves twice as fast on a 120Hz
         display as on 60Hz. Re-basing k against the elapsed time keeps the
         easing identical everywhere:
             kAdjusted = 1 − (1 − k) ^ (dt / 16.667ms)                       */
      const k = 1 - Math.pow(1 - this.smoothing, dt / (1000 / 60));
      this.renderIndex += diff * k;
    }

    // One rounding, here: fractional indices have no picture to show.
    const next = Math.round(this.renderIndex);
    if (next !== this.paintedIndex) this.draw(next);

    this.rafId = requestAnimationFrame(this._tick);
  }

  /* ------------------------------------------------------------- paint --- */

  /**
   * Draw frame `index` with an object-fit: cover fit.
   *
   * The frames are 16:9-ish but the canvas is whatever the viewport is, so the
   * image has to be scaled to *fill* and centre-cropped rather than letterboxed
   * or stretched:
   *
   *   scale = max(canvasW / imgW, canvasH / imgH)   ← max, not min: min would
   *                                                   be object-fit: contain
   *   offset = (canvasSize − scaledSize) / 2        ← centres the overflow,
   *                                                   half bleeding off each edge
   */
  draw(index) {
    const i = Math.min(this.frameCount - 1, Math.max(0, index));
    const img = this.images[i];
    if (!img || !img.naturalWidth) return; // not loaded yet, or failed

    const { ctx, canvas } = this;
    const cw = canvas.width;
    const ch = canvas.height;

    const scale = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    const x = (cw - w) / 2;
    const y = (ch - h) / 2;

    // Sub-pixel edges of the scaled image can leave a 1px seam; clearing first
    // is cheaper than compositing against stale pixels.
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(img, x, y, w, h);

    this.paintedIndex = i;
    if (this.onFrame) this.onFrame(i, this.frameCount);
  }

  /* ------------------------------------------------------------ resize --- */

  observeResize() {
    window.addEventListener('resize', this._onResize, { passive: true });
    window.addEventListener('orientationchange', this._onResize, { passive: true });
  }

  destroy() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);
  }

  _onResize() {
    // Debounce to the next paint: resize fires in bursts while dragging.
    if (this._resizeRaf) cancelAnimationFrame(this._resizeRaf);
    this._resizeRaf = requestAnimationFrame(() => this.resize());
  }

  /**
   * Match the canvas backing store to its CSS box (times DPR) and repaint.
   * Assigning canvas.width/height also clears it, so the redraw is mandatory,
   * not just nice — and `paintedIndex` is reset to force it through.
   */
  resize() {
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));

    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }

    const index = this.paintedIndex >= 0 ? this.paintedIndex : Math.round(this.renderIndex);
    this.paintedIndex = -1;
    this.draw(index);
  }
}
