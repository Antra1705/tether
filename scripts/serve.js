#!/usr/bin/env node
// A tiny static file server for the playground. Browsers refuse to load ES
// modules from file:// pages, so the playground has to be served over HTTP.
// It listens on localhost only and serves files from the project folder.
//
//   npm run playground            # http://localhost:5173/
//   PORT=8080 npm run playground

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.PORT) || 5173;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.tth': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
  let path;
  try {
    path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }
  if (path === '/' || path === '/playground') {
    res.writeHead(302, { location: '/playground/' }).end();
    return;
  }
  if (path.endsWith('/')) path += 'index.html';
  const file = resolve(root, `.${path}`);
  if (!file.startsWith(root + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${port} is busy. Try: PORT=8080 npm run playground`);
  else console.error(e.message);
  process.exitCode = 1;
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Tether playground running at http://localhost:${port}/`);
  console.log('Press Ctrl+C to stop.');
});
