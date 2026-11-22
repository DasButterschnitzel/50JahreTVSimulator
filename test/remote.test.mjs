// Abruf von Internet-Filmen über den eigenen Server – geprüft für den Node-Server und,
// wenn Java vorhanden ist, für den Server der Android-App.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.js';
import { allowedRemoteHosts, isRemoteAllowed } from '../server/remote.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hasJava = !spawnSync('javac', ['-version'], { stdio: 'ignore' }).error;
const quiet = { info() {}, warn() {}, error() {} };

function get(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      })
      .on('error', reject);
  });
}

/**
 * Ein „fremder“ Server wie archive.org: liefert Filme mit Teilabrufen, aber ohne Freigabe
 * zum Einbinden, und leitet wie archive.org auf einen Auslieferungsserver weiter.
 */
function startForeign() {
  const film = Buffer.from('0123456789abcdefghij');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/download/film.mp4') {
      res.writeHead(302, { Location: `/cdn/film.mp4`, 'Access-Control-Allow-Origin': '*' }).end();
    } else if (url.pathname === '/extern.mp4') {
      res.writeHead(302, { Location: 'http://example.invalid/film.mp4' }).end();
    } else if (url.pathname === '/schleife.mp4') {
      res.writeHead(302, { Location: '/schleife.mp4' }).end();
    } else if (url.pathname === '/cdn/film.mp4') {
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      if (match) {
        const start = Number(match[1]);
        const end = match[2] ? Number(match[2]) : film.length - 1;
        res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${film.length}`, 'Content-Length': end - start + 1, 'X-Geheim': 'nicht weiterreichen' });
        res.end(film.subarray(start, end + 1));
      } else {
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': film.length });
        res.end(req.method === 'HEAD' ? undefined : film);
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('gibt es nicht');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) })));
}

function makeDir(foreignPort) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv77-remote-'));
  fs.mkdirSync(path.join(dir, 'media'));
  const config = { web: { channels: [{ name: 'Fremd', urls: [`http://127.0.0.1:${foreignPort}/download/film.mp4`] }] } };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(dir, 'media', 'config.json'), JSON.stringify(config)); // der Android-Server liest sie aus dem Filmordner
  return dir;
}

async function checkRelay(port, foreignPort) {
  const remote = (target) => `/remote/${encodeURIComponent(target)}`;
  const film = `http://127.0.0.1:${foreignPort}/download/film.mp4`;

  // ganze Datei, über die Weiterleitung hinweg
  const full = await get(port, remote(film));
  assert.equal(full.status, 200);
  assert.equal(full.body, '0123456789abcdefghij');
  assert.match(full.headers['content-type'], /video\/mp4/);
  assert.equal(full.headers['x-geheim'], undefined);

  // Teilabruf zum Springen im Film
  const part = await get(port, remote(film), { Range: 'bytes=5-9' });
  assert.equal(part.status, 206);
  assert.equal(part.body, '56789');
  assert.equal(part.headers['content-range'], 'bytes 5-9/20');
  assert.equal(part.headers['x-geheim'], undefined, 'nur die nötigen Kopfzeilen werden weitergereicht');
  assert.equal((await get(port, remote(film), { Range: 'bytes=15-' })).body, 'fghij');

  // Fehler der Gegenstelle kommen an
  assert.equal((await get(port, remote(`http://127.0.0.1:${foreignPort}/fehlt.mp4`))).status, 404);

  // nur eingetragene Server – auch nicht über eine Weiterleitung oder die eigene Schnittstelle
  for (const target of ['https://example.com/film.mp4', `http://127.0.0.1:${port}/api/config`, 'file:///etc/passwd', 'https://archive.org.evil.example/x.mp4', 'https://benutzer:pw@archive.org/x.mp4', 'ftp://archive.org/x.mp4']) {
    assert.equal((await get(port, remote(target))).status, 403, target);
  }
  assert.equal((await get(port, remote(`http://127.0.0.1:${foreignPort}/extern.mp4`))).status, 403, 'Weiterleitung zu einem fremden Server');
  assert.equal((await get(port, remote(`http://127.0.0.1:${foreignPort}/schleife.mp4`))).status, 502, 'endlose Weiterleitung');
  assert.equal((await get(port, '/remote/%E0%A4%A')).status, 400);
  assert.equal((await get(port, remote('kein link'))).status, 400);
}

test('erlaubte Ziele: archive.org und die Server der eingetragenen Internet-Sender', () => {
  const hosts = allowedRemoteHosts({ web: { channels: [{ urls: ['https://filme.example.org/a.mp4', 'nas.local:8080/b.webm', 'https://archive.org/details/x#1977', 5, 'http://[kaputt'] }, 'x', { urls: 'y' }] } });
  assert.deepEqual([...hosts].sort(), ['archive.org', 'filme.example.org', 'nas.local:8080']);
  const ok = (u) => isRemoteAllowed(new URL(u), hosts);
  assert.ok(ok('https://archive.org/download/x/y.mp4'));
  assert.ok(ok('https://dn800306.us.archive.org/0/items/x/y.mp4'));
  assert.ok(ok('https://FILME.example.org/anderer/pfad.mp4'));
  assert.ok(ok('http://nas.local:8080/b.webm'));
  assert.ok(!ok('http://nas.local/b.webm'), 'anderer Port');
  assert.ok(!ok('https://example.org/a.mp4'));
  assert.ok(!ok('https://archive.org.example.org/a.mp4'));
  assert.ok(!ok('https://xarchive.org/a.mp4'));
  assert.deepEqual([...allowedRemoteHosts({})], []);
});

test('Node-Server reicht Internet-Filme weiter', async () => {
  const foreign = await startForeign();
  const dir = makeDir(foreign.port);
  const app = createApp({ config: path.join(dir, 'config.json'), data: path.join(dir, 'data'), media: path.join(dir, 'media'), log: quiet });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  try {
    await checkRelay(app.server.address().port, foreign.port);
  } finally {
    await app.close();
    await foreign.close();
  }
});

test('Android-Server reicht Internet-Filme weiter', { skip: !hasJava && 'Java ist nicht installiert' }, async () => {
  const foreign = await startForeign();
  const dir = makeDir(foreign.port);
  const classes = fs.mkdtempSync(path.join(os.tmpdir(), 'tv77-classes-'));
  const sources = [];
  const collect = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) collect(full);
      else if (entry.name.endsWith('.java') && !entry.name.endsWith('Test.java') && full.includes(`${path.sep}server${path.sep}`)) sources.push(full);
    }
  };
  collect(path.join(ROOT, 'android/app/src'));
  const compiled = spawnSync('javac', ['-d', classes, ...sources], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr);
  const child = spawn(
    'java',
    ['-cp', classes, 'io.github.dasbutterschnitzel.tv1977.server.DesktopMain', '--public', path.join(ROOT, 'public'), '--defaults', path.join(ROOT, 'server/defaults.jsonc'), '--media', path.join(dir, 'media'), '--data', path.join(dir, 'data')],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  );
  try {
    const port = await new Promise((resolve, reject) => {
      let buffer = '';
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        const match = /PORT=(\d+)/.exec(buffer);
        if (match) resolve(Number(match[1]));
      });
      child.once('exit', (code) => reject(new Error(`Java-Server beendet (${code})`)));
    });
    await checkRelay(port, foreign.port);
  } finally {
    child.kill();
    await foreign.close();
  }
});
