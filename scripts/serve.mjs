#!/usr/bin/env node
/**
 * serve.mjs — zero-dependency static server for local development.
 *
 * The site itself has no build step, but it does `fetch()` the frame manifest,
 * so it has to be served over http:// rather than opened as a file:// URL.
 *
 *   npm run serve            # http://localhost:5173
 *   npm run serve -- 8080
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const port = Number(process.argv[2]) || Number(process.env.PORT) || 5173;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let filePath = path.join(root, decodeURIComponent(url.pathname));

  // Keep requests inside the project directory.
  if (!filePath.startsWith(root)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    let info = await stat(filePath);
    if (info.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      info = await stat(filePath);
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(port, () => {
  console.log(`Serving ${root}\n  http://localhost:${port}`);
});
