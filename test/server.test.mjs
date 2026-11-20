import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server.js';
import { parseLooseJson, deepMerge } from '../server/config.js';
import { scanMedia, prettifyName } from '../server/media.js';

const quiet = { info() {}, warn() {}, error() {} };

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tv77-'));
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

async function startApp(setup = () => {}) {
  const dir = tempDir();
  const media = path.join(dir, 'media');
  fs.mkdirSync(media);
  setup({ dir, media });
  const app = createApp({ config: path.join(dir, 'config.json'), data: path.join(dir, 'data'), media, log: quiet });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { app, dir, media, port: app.server.address().port };
}

test('Konfiguration darf Kommentare und überzählige Kommas enthalten', () => {
  const parsed = parseLooseJson(`﻿{
    // Kommentar
    "a": 1, /* noch einer */
    "url": "http://x/y, // kein Kommentar",
    "liste": [1, 2,],
  }`);
  assert.deepEqual(parsed, { a: 1, url: 'http://x/y, // kein Kommentar', liste: [1, 2] });
});

test('deepMerge ersetzt Listen und mischt Objekte', () => {
  const merged = deepMerge({ a: { b: 1, c: [1, 2] }, d: 1 }, { a: { c: [3] } }, { d: 2 });
  assert.deepEqual(merged, { a: { b: 1, c: [3] }, d: 2 });
  assert.equal({}.polluted, undefined);
  deepMerge({}, JSON.parse('{"__proto__":{"polluted":true}}'));
  assert.equal({}.polluted, undefined);
});

test('Ordnernamen werden zu Sendernamen', () => {
  assert.equal(prettifyName('01-tagesschau'), 'Tagesschau');
  assert.equal(prettifyName('2_hessentag_dreieich'), 'Hessentag Dreieich');
  assert.equal(prettifyName('12'), '12');
});

test('Medienordner: Unterordner sind Sender, natürlich sortiert', () => {
  const dir = tempDir();
  for (const folder of ['10-zehn', '2-zwei', '1-eins', '_versteckt']) fs.mkdirSync(path.join(dir, folder));
  fs.writeFileSync(path.join(dir, '1-eins', 'b.mp4'), 'x');
  fs.writeFileSync(path.join(dir, '1-eins', 'a 10.mp4'), 'x');
  fs.writeFileSync(path.join(dir, '1-eins', 'a 2.mp4'), 'x');
  fs.writeFileSync(path.join(dir, '1-eins', 'notiz.txt'), 'x');
  fs.writeFileSync(path.join(dir, '1-eins', 'leer.mp4'), '');
  fs.writeFileSync(path.join(dir, '2-zwei', 'channel.json'), '{ "name": "ZDF", "type": "noise", }');
  fs.writeFileSync(path.join(dir, '10-zehn', 'channel.json'), '{ kaputt');
  const { channels, warnings } = scanMedia(dir);
  assert.deepEqual(
    channels.map((c) => [c.id, c.name, c.type]),
    [
      ['1-eins', 'Eins', 'video'],
      ['2-zwei', 'ZDF', 'noise'],
      ['10-zehn', 'Zehn', 'testcard'],
    ]
  );
  assert.deepEqual(
    channels[0].files.map((f) => f.name),
    ['a 2.mp4', 'a 10.mp4', 'b.mp4']
  );
  assert.equal(channels[0].files[0].url, '/media/1-eins/a%202.mp4');
  assert.equal(warnings.length, 1);
});

test('leerer Medienordner ergibt ein Testbild', () => {
  const { channels } = scanMedia(tempDir());
  assert.equal(channels.length, 1);
  assert.equal(channels[0].type, 'testcard');
});

test('Server liefert Seiten, Filme in Teilstücken und sperrt fremde Pfade', async () => {
  const { app, port, dir } = await startApp(({ dir, media }) => {
    fs.mkdirSync(path.join(media, '1-sender'));
    fs.writeFileSync(path.join(media, '1-sender', 'film.mp4'), '0123456789');
    fs.writeFileSync(path.join(dir, 'geheim.txt'), 'geheim');
  });
  try {
    assert.equal((await get(port, '/')).status, 200);
    assert.equal((await get(port, '/admin')).status, 200);
    assert.match((await get(port, '/js/main.js')).headers['content-type'], /javascript/);

    const full = await get(port, '/media/1-sender/film.mp4');
    assert.equal(full.status, 200);
    assert.equal(full.headers['accept-ranges'], 'bytes');
    assert.equal(full.body.toString(), '0123456789');

    const part = await get(port, '/media/1-sender/film.mp4', { Range: 'bytes=2-5' });
    assert.equal(part.status, 206);
    assert.equal(part.headers['content-range'], 'bytes 2-5/10');
    assert.equal(part.body.toString(), '2345');
    assert.equal((await get(port, '/media/1-sender/film.mp4', { Range: 'bytes=-3' })).body.toString(), '789');
    assert.equal((await get(port, '/media/1-sender/film.mp4', { Range: 'bytes=7-' })).body.toString(), '789');
    assert.equal((await get(port, '/media/1-sender/film.mp4', { Range: 'bytes=50-' })).status, 416);

    const etag = full.headers.etag;
    assert.equal((await get(port, '/media/1-sender/film.mp4', { 'If-None-Match': etag })).status, 304);
    assert.equal((await get(port, '/media/1-sender/film.mp4', { Range: 'bytes=2-5', 'If-Range': etag })).status, 206);
    const replaced = await get(port, '/media/1-sender/film.mp4', { Range: 'bytes=2-5', 'If-Range': '"alte-fassung"' });
    assert.equal(replaced.status, 200, 'nach dem Ersetzen der Datei kommt die ganze neue Fassung');
    assert.equal(replaced.body.toString(), '0123456789');

    for (const bad of ['/media/../geheim.txt', '/media/%2e%2e/geheim.txt', '/media/..%2fgeheim.txt', '/media/%2e%2e%5cgeheim.txt', '/..%2fserver.js']) {
      const res = await get(port, bad);
      assert.ok([400, 403, 404].includes(res.status), `${bad} -> ${res.status}`);
      assert.doesNotMatch(res.body.toString(), /geheim|createApp/);
    }
    assert.ok(fs.existsSync(path.join(dir, 'geheim.txt')));
  } finally {
    await app.close();
  }
});

test('Einstellungen und Zustand werden gespeichert und überstehen einen Neustart', async () => {
  const { app, port, dir, media } = await startApp(({ dir }) => {
    fs.writeFileSync(path.join(dir, 'config.json'), '{ // eigene Werte\n "effects": { "noise": 0.5 }, "server": { "port": 1234 } }');
  });
  try {
    let config = JSON.parse((await get(port, '/api/config')).body);
    assert.equal(config.settings.effects.noise, 0.5);
    assert.equal(config.settings.effects.curvature, 0.5);

    const patched = await post(port, '/api/settings', { patch: { effects: { noise: 0.1 }, server: { port: 1 }, audio: { volume: 0.3 } } });
    assert.equal(patched.body.settings.effects.noise, 0.1);
    assert.equal(patched.body.settings.server.port, 1234, 'Serverdaten sind nur über config.json änderbar');

    await post(port, '/api/state', { channel: 'x', power: false, broadcast: { offsets: { x: 12 }, pauseAccum: 3, pausedAt: null } });
    app.store.saveNow();
  } finally {
    await app.close();
  }

  const second = createApp({ config: path.join(dir, 'config.json'), data: path.join(dir, 'data'), media, log: quiet });
  await new Promise((resolve) => second.server.listen(0, '127.0.0.1', resolve));
  const port2 = second.server.address().port;
  try {
    const config = JSON.parse((await get(port2, '/api/config')).body);
    assert.equal(config.settings.effects.noise, 0.1);
    assert.equal(config.settings.audio.volume, 0.3);
    assert.deepEqual(config.state, { broadcast: { offsets: { x: 12 }, pauseAccum: 3, pausedAt: null }, channel: 'x', power: false });

    const reset = await post(port2, '/api/settings', { reset: 'effects' });
    assert.equal(reset.body.settings.effects.noise, 0.5);
    assert.equal(reset.body.settings.audio.volume, 0.3);
  } finally {
    await second.close();
  }
});

test('fehlerhafte config.json legt den Server nicht lahm', async () => {
  const { app, port } = await startApp(({ dir }) => fs.writeFileSync(path.join(dir, 'config.json'), '{ "effects": { '));
  try {
    const config = JSON.parse((await get(port, '/api/config')).body);
    assert.equal(config.settings.effects.curvature, 0.5);
    assert.equal(config.warnings.length, 1);
  } finally {
    await app.close();
  }
});

test('Befehle der Fernbedienung erreichen die Anzeige', async () => {
  const { app, port } = await startApp();
  try {
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
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await post(port, '/api/command', {})).status, 400);
    await post(port, '/api/command', { cmd: 'tune', args: { index: 2 } });
    assert.deepEqual(await received, { type: 'command', cmd: 'tune', args: { index: 2 } });
  } finally {
    await app.close();
  }
});
