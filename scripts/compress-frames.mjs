#!/usr/bin/env node
/**
 * compress-frames.mjs
 * ---------------------------------------------------------------------------
 * Detects a numbered image sequence on disk, resizes + re-encodes it as JPEG,
 * and writes a `frames.json` manifest that the site reads at runtime.
 *
 * Nothing about the sequence is hardcoded: the filename pattern, zero-padding,
 * first index and frame count are all discovered by scanning the folder.
 *
 * Usage:
 *   node scripts/compress-frames.mjs                       # optimise public/frames in place
 *   node scripts/compress-frames.mjs --src raw --out public/frames
 *   node scripts/compress-frames.mjs --width 1280 --quality 65
 *   node scripts/compress-frames.mjs --manifest-only       # just (re)write frames.json
 *
 * Flags:
 *   --src <dir>        source folder            (default: public/frames)
 *   --out <dir>        destination folder       (default: same as --src, in place)
 *   --width <px>       max width, never upscale (default: 1600)
 *   --quality <1-100>  JPEG quality             (default: 70)
 *   --manifest-only    skip encoding, only rewrite frames.json
 *   --force            always take the re-encode, even if it is bigger
 *
 * Note: some sources (GIF exporters like ezgif among them) are already encoded
 * below the target quality, so a q70 re-encode would *add* bytes. By default a
 * JPEG source is kept as-is whenever the re-encode comes out larger; pass
 * --force to override that.
 */

import { readdir, mkdir, writeFile, readFile, rm, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';

/* ------------------------------------------------------------------ args -- */

function parseArgs(argv) {
  const args = { src: 'public/frames', out: null, width: 1600, quality: 70, manifestOnly: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--src') args.src = argv[++i];
    else if (flag === '--out') args.out = argv[++i];
    else if (flag === '--width') args.width = Number(argv[++i]);
    else if (flag === '--quality') args.quality = Number(argv[++i]);
    else if (flag === '--manifest-only') args.manifestOnly = true;
    else if (flag === '--force') args.force = true;
    else if (flag === '--help' || flag === '-h') {
      console.log(helpText());
      process.exit(0);
    } else {
      throw new Error(`Unknown flag: ${flag}`);
    }
  }
  args.out ??= args.src;
  if (!Number.isFinite(args.width) || args.width < 1) throw new Error('--width must be a positive number');
  if (!Number.isFinite(args.quality) || args.quality < 1 || args.quality > 100) {
    throw new Error('--quality must be between 1 and 100');
  }
  return args;
}

function helpText() {
  return `Resize + re-encode a numbered image sequence and write frames.json.

  --src <dir>        source folder            (default: public/frames)
  --out <dir>        destination folder       (default: same as --src)
  --width <px>       max width, never upscale (default: 1600)
  --quality <1-100>  JPEG quality             (default: 70)
  --manifest-only    skip encoding, only rewrite frames.json
  --force            always take the re-encode, even if it is bigger`;
}

/* ------------------------------------------------------------- detection -- */

const IMAGE_EXT = /\.(jpe?g|png|webp|avif)$/i;

/**
 * Scan a folder and work out the sequence's shape.
 *
 * Filenames are split into `prefix + digits + extension` (e.g.
 * "ezgif-frame-" + "001" + ".jpg"). The most common prefix/padding pair wins,
 * so stray files in the folder don't derail detection.
 */
async function detectSequence(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    throw new Error(`Source folder not found: ${dir}`);
  }

  const groups = new Map(); // `${prefix}|${padding}|${ext}` -> [{ file, index }]
  for (const file of entries) {
    if (!IMAGE_EXT.test(file)) continue;
    const ext = path.extname(file);
    const base = file.slice(0, -ext.length);
    const match = base.match(/^(.*?)(\d+)$/); // trailing run of digits
    if (!match) continue;
    const [, prefix, digits] = match;
    const key = `${prefix}|${digits.length}|${ext.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ file, index: Number(digits) });
  }

  if (groups.size === 0) throw new Error(`No numbered image sequence found in ${dir}`);

  // Largest group is the sequence.
  const [key, frames] = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  const [prefix, padding, ext] = key.split('|');
  frames.sort((a, b) => a.index - b.index);

  const start = frames[0].index;
  const expected = frames.length;
  const gaps = frames[expected - 1].index - start + 1 !== expected;

  return {
    dir,
    prefix,
    padding: Number(padding),
    ext,
    start,
    count: expected,
    files: frames.map((f) => f.file),
    gaps,
  };
}

/* -------------------------------------------------------------- encoding -- */

async function encodeFrames(seq, args) {
  const inPlace = path.resolve(args.src) === path.resolve(args.out);
  // Encoding in place would read and write the same file, so stage into a
  // sibling temp dir and swap it in once every frame has been written.
  const workDir = inPlace ? `${path.resolve(args.out)}.tmp-${process.pid}` : path.resolve(args.out);

  await mkdir(workDir, { recursive: true });

  let bytesBefore = 0;
  let bytesAfter = 0;
  let kept = 0;
  let dimensions = null;

  for (let i = 0; i < seq.files.length; i++) {
    const file = seq.files[i];
    const from = path.join(seq.dir, file);
    // Output is always .jpg — the manifest records that for the runtime.
    const to = path.join(workDir, `${path.basename(file, path.extname(file))}.jpg`);

    const sourceSize = (await stat(from)).size;
    bytesBefore += sourceSize;

    const image = sharp(from);
    const meta = await image.metadata();
    const needsResize = (meta.width ?? 0) > args.width;
    const encoded = await image
      // `withoutEnlargement` keeps small source frames at their native size.
      .resize({ width: Math.min(args.width, meta.width ?? args.width), withoutEnlargement: true })
      .jpeg({ quality: args.quality, mozjpeg: true, progressive: true, chromaSubsampling: '4:2:0' })
      .toBuffer();

    // A source that is already JPEG, already within the width budget, and
    // already smaller than our re-encode is left untouched — re-encoding it
    // would only add bytes and a second round of generation loss.
    const keepSource =
      !args.force && !needsResize && /^\.jpe?g$/i.test(path.extname(file)) && sourceSize <= encoded.length;

    const buffer = keepSource ? await readFile(from) : encoded;
    if (keepSource) kept++;

    await writeFile(to, buffer);
    bytesAfter += buffer.length;

    if (!dimensions) {
      const outMeta = await sharp(buffer).metadata();
      dimensions = { width: outMeta.width, height: outMeta.height };
    }

    if ((i + 1) % 25 === 0 || i === seq.files.length - 1) {
      process.stdout.write(`  processed ${i + 1}/${seq.files.length}\r`);
    }
  }
  process.stdout.write('\n');
  if (kept > 0) {
    console.log(`  ${kept}/${seq.files.length} frames already smaller than a q${args.quality} re-encode — kept as-is`);
  }

  if (inPlace) {
    const target = path.resolve(args.out);
    await rm(target, { recursive: true, force: true });
    await rename(workDir, target);
  }

  return { bytesBefore, bytesAfter, kept, dimensions };
}

/* -------------------------------------------------------------- manifest -- */

async function writeManifest(dir, seq, dimensions) {
  const manifest = {
    // Everything the runtime needs to rebuild any frame URL:
    //   url = `${basePath}${prefix}${String(start + i).padStart(padding, '0')}${ext}`
    prefix: seq.prefix,
    padding: seq.padding,
    ext: seq.ext,
    start: seq.start,
    count: seq.count,
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
    generatedAt: new Date().toISOString(),
  };
  await writeFile(path.join(dir, 'frames.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/* ------------------------------------------------------------------ main -- */

const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const seq = await detectSequence(args.src);

  console.log(`Sequence detected in ${args.src}`);
  console.log(`  pattern : ${seq.prefix}${'#'.repeat(seq.padding)}${seq.ext}`);
  console.log(`  frames  : ${seq.count} (first index ${seq.start})`);
  if (seq.gaps) console.log('  warning : indices are not contiguous — gaps were found');

  if (args.manifestOnly) {
    const first = sharp(path.join(seq.dir, seq.files[0]));
    const meta = await first.metadata();
    const manifest = await writeManifest(args.out, seq, { width: meta.width, height: meta.height });
    console.log(`\nWrote ${path.join(args.out, 'frames.json')}`);
    console.log(manifest);
    return;
  }

  console.log(`  resize  : max width ${args.width}px, JPEG q${args.quality}\n`);

  const { bytesBefore, bytesAfter, kept, dimensions } = await encodeFrames(seq, args);

  // After an in-place run the extensions may have changed (png -> jpg), so
  // re-detect from the output folder before writing the manifest.
  const outSeq = await detectSequence(args.out);
  await writeManifest(args.out, outSeq, dimensions);

  const saved = bytesBefore === 0 ? 0 : (1 - bytesAfter / bytesBefore) * 100;
  console.log(`\nDone. ${mb(bytesBefore)} -> ${mb(bytesAfter)} (${saved.toFixed(1)}% smaller)`);
  console.log(`Output: ${path.resolve(args.out)} — ${outSeq.count} frames at ${dimensions.width}x${dimensions.height}`);
  console.log(`Manifest: ${path.join(args.out, 'frames.json')}`);
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
