// Prüft den Server der Android-App (Java) auf demselben Verhalten wie server.js.
// Er wird dazu auf dem PC übersetzt und gestartet; ohne Java wird der Test übersprungen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hasJava = !spawnSync('javac', ['-version'], { stdio: 'ignore' }).error;

function javaSources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) javaSources(full, out);
    else if (entry.name.endsWith('.java') && !entry.name.endsWith('Test.java') && full.includes(`${path.sep}server${path.sep}`)) out.push(full);
  }
  return out;
}

function get(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      })
      .on('error', reject);
  });
}

async function post(port, urlPath, body) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

let classes;
function startJava(dir) {
  if (!classes) {
    classes = fs.mkdtempSync(path.join(os.tmpdir(), 'tv77-classes-'));
    const result = spawnSync('javac', ['-d', classes, ...javaSources(path.join(ROOT, 'android/app/src'))], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const child = spawn(
    'java',
    ['-cp', classes, 'io.github.dasbutterschnitzel.tv1977.server.DesktopMain', '--public', path.join(ROOT, 'public'), '--defaults', path.join(ROOT, 'server/defaults.jsonc'), '--media', path.join(dir, 'media'), '--data', path.join(dir, 'data')],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  );
  return new Promise((resolve, reject) => {
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const match = /PORT=(\d+)/.exec(buffer);
      if (match) resolve({ port: Number(match[1]), stop: () => new Promise((done) => (child.once('exit', done), child.kill())) });
    });
    child.once('exit', (code) => reject(new Error(`Java-Server beendet (${code})`)));
  });
}

function makeMedia() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv77-java-'));
  const media = path.join(dir, 'media');
  for (const folder of ['10-zehn', '2-zwei', '1-eins', '_versteckt']) fs.mkdirSync(path.join(media, folder), { recursive: true });
  fs.writeFileSync(path.join(media, '1-eins', 'b.mp4'), '0123456789');
  fs.writeFileSync(path.join(media, '1-eins', 'a 10.mp4'), 'x');
  fs.writeFileSync(path.join(media, '1-eins', 'a 2.mp4'), 'x');
  fs.writeFileSync(path.join(media, '1-eins', 'notiz.txt'), 'x');
  fs.writeFileSync(path.join(media, '1-eins', 'leer.mp4'), '');
  fs.writeFileSync(path.join(media, '2-zwei', 'channel.json'), '{ "name": "ZDF", "type": "noise", } // Kommentar');
  fs.writeFileSync(path.join(media, '10-zehn', 'channel.json'), '{ kaputt');
  fs.writeFileSync(path.join(media, 'config.json'), '{ // eigene Werte\n "effects": { "noise": 0.5, }, "testcard": { "title": "Größe „ß“" } }');
  fs.writeFileSync(path.join(dir, 'geheim.txt'), 'geheim');
  return dir;
}

test('Android-Server: Sender, Einstellungen, Filme in Teilstücken, gesperrte Pfade', { skip: !hasJava && 'Java ist nicht installiert' }, async () => {
  const dir = makeMedia();
  const server = await startJava(dir);
  const { port } = server;
  try {
    // Sender wie beim Node-Server
    const config = JSON.parse((await get(port, '/api/config')).body);
    assert.equal(config.platform, 'android' === config.platform ? 'android' : 'desktop');
    assert.deepEqual(
      config.channels.map((c) => [c.id, c.name, c.type]),
      [
        ['1-eins', 'Eins', 'video'],
        ['2-zwei', 'ZDF', 'noise'],
        ['10-zehn', 'Zehn', 'testcard'],
      ]
    );
    assert.deepEqual(
      config.channels[0].files.map((f) => f.name),
      ['a 2.mp4', 'a 10.mp4', 'b.mp4']
    );
    assert.equal(config.channels[0].files[0].url, '/media/1-eins/a%202.mp4');
    assert.equal(config.channels[0].files[2].size, 10);
    assert.equal(config.warnings.length, 1, 'fehlerhafte channel.json wird gemeldet');

    // Standardwerte aus derselben Datei wie am PC, überlagert von config.json im Filmordner
    const defaults = JSON.parse((await get(port, '/api/config')).body).settings;
    assert.equal(defaults.effects.noise, 0.5);
    assert.equal(defaults.effects.curvature, 0.5);
    assert.equal(defaults.testcard.title, 'Größe „ß“');
    assert.deepEqual(defaults.keys.channelUp, ['ArrowUp', 'ArrowRight', 'PageUp', 'F14']);
    assert.equal(defaults.screen.aspect, 1.3333);

    // Seiten und Filme
    assert.equal((await get(port, '/')).status, 200);
    assert.equal((await get(port, '/admin')).status, 200);
    assert.match((await get(port, '/js/main.js')).headers['content-type'], /javascript/);
    assert.equal((await get(port, '/gibtesnicht.js')).status, 404);
    const full = await get(port, '/media/1-eins/b.mp4');
    assert.equal(full.status, 200);
    assert.equal(full.headers['accept-ranges'], 'bytes');
    assert.equal(full.body.toString(), '0123456789');
    const part = await get(port, '/media/1-eins/b.mp4', { Range: 'bytes=2-5' });
    assert.equal(part.status, 206);
    assert.equal(part.headers['content-range'], 'bytes 2-5/10');
    assert.equal(part.body.toString(), '2345');
    assert.equal((await get(port, '/media/1-eins/b.mp4', { Range: 'bytes=-3' })).body.toString(), '789');
    assert.equal((await get(port, '/media/1-eins/b.mp4', { Range: 'bytes=7-' })).body.toString(), '789');
    assert.equal((await get(port, '/media/1-eins/b.mp4', { Range: 'bytes=50-' })).status, 416);
    assert.equal((await get(port, '/media/1-eins/a%202.mp4')).body.toString(), 'x');
    assert.equal((await get(port, '/media/1-eins/b.mp4', { 'If-None-Match': full.headers.etag })).status, 304);
    assert.equal((await get(port, '/media/1-eins/b.mp4', { Range: 'bytes=2-5', 'If-Range': '"alte-fassung"' })).status, 200);

    // nichts außerhalb des Filmordners und der Anzeige
    for (const bad of ['/media/../geheim.txt', '/media/%2e%2e/geheim.txt', '/media/..%2fgeheim.txt', '/media/%2e%2e%5cgeheim.txt', '/media/1-eins/..%2f..%2fgeheim.txt', '/..%2fserver.js', '/%2e%2e/server.js', '/js/..%2f..%2fserver.js']) {
      const res = await get(port, bad);
      assert.ok([400, 403, 404].includes(res.status), `${bad} -> ${res.status}`);
      assert.doesNotMatch(res.body.toString(), /geheim|createApp/);
    }

    // Einstellungen und Zustand
    const patched = await post(port, '/api/settings', { patch: { effects: { noise: 0.1 }, server: { port: 1 }, audio: { volume: 0.3 } } });
    assert.equal(patched.body.settings.effects.noise, 0.1);
    assert.equal(patched.body.settings.server.port, 7777, 'Serverdaten sind nur über config.json änderbar');
    await post(port, '/api/state', { channel: 'x', power: false, broadcast: { offsets: { x: 12.5 }, pauseAccum: 3, pausedAt: null } });
    assert.equal((await post(port, '/api/command', {})).status, 400);
    assert.equal((await post(port, '/api/system', { action: 'gibtesnicht' })).status, 400);

    // Befehle erreichen die Anzeige
    const received = new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/events?role=display' }, (res) => {
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk;
          const match = /data: (\{.*\})\n/.exec(buffer);
          if (match) {
            req.destroy();
            resolve(JSON.parse(match[1]));
          }
        });
      });
      req.on('error', (err) => err.code === 'ECONNRESET' || reject(err));
    });
    await new Promise((r) => setTimeout(r, 200));
    await post(port, '/api/command', { cmd: 'tune', args: { index: 2 } });
    assert.deepEqual(await received, { type: 'command', cmd: 'tune', args: { index: 2 } });
    await new Promise((r) => setTimeout(r, 700)); // Zustand wird verzögert gespeichert
  } finally {
    await server.stop();
  }

  // Neustart: Einstellungen und Zustand sind noch da
  const second = await startJava(dir);
  try {
    const config = JSON.parse((await get(second.port, '/api/config')).body);
    assert.equal(config.settings.effects.noise, 0.1);
    assert.equal(config.settings.audio.volume, 0.3);
    assert.deepEqual(config.state, { broadcast: { offsets: { x: 12.5 }, pauseAccum: 3, pausedAt: null }, channel: 'x', power: false });
    const reset = await post(second.port, '/api/settings', { reset: 'effects' });
    assert.equal(reset.body.settings.effects.noise, 0.5);
    assert.equal(reset.body.settings.audio.volume, 0.3);
  } finally {
    await second.stop();
  }
});

test('Android-Server liefert dieselben Standardwerte wie der Node-Server', { skip: !hasJava && 'Java ist nicht installiert' }, async () => {
  const { DEFAULTS } = await import('../server/config.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv77-java-'));
  fs.mkdirSync(path.join(dir, 'media'));
  const server = await startJava(dir);
  try {
    const config = JSON.parse((await get(server.port, '/api/config')).body);
    assert.deepEqual(config.settings, JSON.parse(JSON.stringify(DEFAULTS)));
    assert.deepEqual(config.channels.map((c) => c.type), ['testcard']);
  } finally {
    await server.stop();
  }
});
