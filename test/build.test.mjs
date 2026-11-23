import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { readResource, isPackaged } from '../server/resources.js';
import { stripAuthenticode, writeZip } from '../tools/build-exe.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tv77-build-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('mitgelieferte Dateien: lesen, aber nicht aus dem Ordner ausbrechen', () => {
  assert.equal(isPackaged, false);
  assert.ok(readResource('public/index.html').toString('utf8').includes('<canvas'));
  assert.ok(readResource('server/defaults.jsonc').length > 100);
  for (const name of ['../package.json', 'public/../../etc/passwd', '/etc/passwd', 'public\\..\\server.js', 'public', 'public/gibt-es-nicht.js', 'a\0b', null]) {
    assert.equal(readResource(name), null, String(name));
  }
});

/** Liest ein ZIP über sein Inhaltsverzeichnis zurück. */
function readZip(file) {
  const data = fs.readFileSync(file);
  const end = data.length - 22;
  assert.equal(data.readUInt32LE(end), 0x06054b50);
  const count = data.readUInt16LE(end + 10);
  let pos = data.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(data.readUInt32LE(pos), 0x02014b50);
    const method = data.readUInt16LE(pos + 10);
    const size = data.readUInt32LE(pos + 20);
    const nameLength = data.readUInt16LE(pos + 28);
    const mode = data.readUInt32LE(pos + 38) >>> 16;
    const local = data.readUInt32LE(pos + 42);
    const name = data.subarray(pos + 46, pos + 46 + nameLength).toString('utf8');
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    const body = data.subarray(start, start + size);
    out[name] = { data: method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body), mode: mode & 0o777, crc: data.readUInt32LE(pos + 16) };
    pos += 46 + nameLength;
  }
  return out;
}

test('ZIP: Inhalt, Umlaute im Namen, Dateirechte und Prüfsummen stimmen', () => {
  const file = path.join(tmp, 'paket.zip');
  const big = Buffer.alloc(200000, 'Fernsehen 1977 ');
  const random = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 97 + 13) & 0xff));
  writeZip(file, [
    { name: 'Ordner/Programm', data: big, mode: 0o755 },
    { name: 'Ordner/Übersicht.txt', data: Buffer.from('Grüße') },
    { name: 'Ordner/klein.bin', data: random },
    { name: 'Ordner/leer.txt', data: Buffer.alloc(0) },
  ]);
  const zip = readZip(file);
  assert.deepEqual(Object.keys(zip), ['Ordner/Programm', 'Ordner/Übersicht.txt', 'Ordner/klein.bin', 'Ordner/leer.txt']);
  assert.ok(zip['Ordner/Programm'].data.equals(big));
  assert.equal(zip['Ordner/Programm'].mode, 0o755);
  assert.equal(zip['Ordner/Übersicht.txt'].data.toString('utf8'), 'Grüße');
  assert.equal(zip['Ordner/Übersicht.txt'].mode, 0o644);
  assert.ok(zip['Ordner/klein.bin'].data.equals(random));
  assert.equal(zip['Ordner/leer.txt'].data.length, 0);
  for (const entry of Object.values(zip)) assert.equal(entry.crc, zlib.crc32 ? zlib.crc32(entry.data) : entry.crc);
  assert.ok(fs.statSync(file).size < 20000, 'gut komprimierbare Daten werden komprimiert');
});

test('Windows-Programm: Signatur wird entfernt, der Rest bleibt unverändert', () => {
  // kleinste denkbare 64-Bit-Programmdatei: Kopf, Verzeichnisse, etwas Inhalt, Zertifikat am Ende
  const body = Buffer.alloc(1024, 0x11);
  body.writeUInt16LE(0x5a4d, 0);
  body.writeUInt32LE(0x80, 0x3c);
  body.writeUInt32LE(0x00004550, 0x80);
  const optional = 0x80 + 24;
  body.writeUInt16LE(0x20b, optional);
  const entry = optional + 112 + 4 * 8;
  const cert = Buffer.alloc(256, 0xcc);
  body.writeUInt32LE(body.length, entry);
  body.writeUInt32LE(cert.length, entry + 4);
  const file = path.join(tmp, 'programm.exe');
  fs.writeFileSync(file, Buffer.concat([body, cert]));

  assert.equal(stripAuthenticode(file), true);
  const stripped = fs.readFileSync(file);
  assert.equal(stripped.length, body.length);
  assert.equal(stripped.readUInt32LE(entry), 0);
  assert.equal(stripped.readUInt32LE(entry + 4), 0);
  const expected = Buffer.from(body);
  expected.writeUInt32LE(0, entry);
  expected.writeUInt32LE(0, entry + 4);
  assert.ok(stripped.equals(expected));
  assert.equal(stripAuthenticode(file), false, 'ohne Signatur bleibt die Datei, wie sie ist');

  const other = path.join(tmp, 'kein-programm.bin');
  fs.writeFileSync(other, Buffer.alloc(300, 1));
  assert.equal(stripAuthenticode(other), false);
});
