#!/usr/bin/env node
// Baut den TV-Simulator als eigenständiges Programm, das ohne installiertes Node.js läuft:
//
//   node tools/build-exe.mjs              Windows (TV-Simulator.exe, 64 Bit)
//   node tools/build-exe.mjs linux-x64    Linux-PC
//   node tools/build-exe.mjs linux-arm64  Raspberry Pi (64 Bit)
//   node tools/build-exe.mjs lokal        für diesen Rechner, zum Ausprobieren
//
// Ergebnis: dist/TV-Simulator-1977-<ziel>.zip mit dem Programm und allem, was daneben liegen soll.
//
// So funktioniert es: Server und Anzeige werden zu einem Skript gebündelt und zusammen mit den
// Dateien aus public/ in eine Kopie des Node.js-Programms eingesetzt ("Single Executable
// Application"). Das Skript lädt dafür Node.js von nodejs.org (mit Prüfsumme) sowie die
// Werkzeuge esbuild und postject von npm – beides nur in den Ordner dist/, das Projekt selbst
// bleibt ohne Abhängigkeiten.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const WORK = path.join(DIST, '.build');
const CACHE = path.join(DIST, '.cache');

const ESBUILD_VERSION = '0.28.2';
const POSTJECT_VERSION = '1.0.0-alpha.6';
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const TARGETS = {
  'win-x64': { download: 'win-x64/node.exe', program: 'TV-Simulator.exe', windows: true },
  'linux-x64': { download: `node-${process.version}-linux-x64.tar.xz`, program: 'tv-simulator' },
  'linux-arm64': { download: `node-${process.version}-linux-arm64.tar.xz`, program: 'tv-simulator' },
  lokal: { program: process.platform === 'win32' ? 'TV-Simulator.exe' : 'tv-simulator', windows: process.platform === 'win32' },
};

function fail(message) {
  console.error(`\nFehler: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options });
  if (result.error) fail(`${command} ließ sich nicht starten: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(' ')} ist fehlgeschlagen (Code ${result.status}).`);
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) fail(`${url} ließ sich nicht laden (HTTP ${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}

/** Lädt eine Datei der passenden Node.js-Version und prüft sie gegen die veröffentlichte Prüfsumme. */
async function fetchNode(name) {
  const base = `https://nodejs.org/dist/${process.version}`;
  const cached = path.join(CACHE, `${process.version}-${name.replace(/[\\/]/g, '-')}`);
  const sums = (await download(`${base}/SHASUMS256.txt`)).toString('utf8');
  const line = sums.split('\n').find((l) => l.trim().endsWith(`  ${name}`));
  if (!line) fail(`Für ${name} gibt es bei Node.js ${process.version} keine Prüfsumme.`);
  const expected = line.trim().split(/\s+/)[0];
  const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
  if (fs.existsSync(cached) && sha(fs.readFileSync(cached)) === expected) return cached;
  console.log(`Lade Node.js ${process.version} (${name}) …`);
  const data = await download(`${base}/${name}`);
  if (sha(data) !== expected) fail(`Die Prüfsumme von ${name} stimmt nicht – Download beschädigt?`);
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(cached, data);
  return cached;
}

/** Besorgt das unveränderte Node.js-Programm für das Ziel. */
async function nodeBinary(targetName, target) {
  if (targetName === 'lokal') return process.execPath;
  const file = await fetchNode(target.download);
  if (target.windows) return file;
  const dir = path.join(WORK, `node-${targetName}`);
  fs.mkdirSync(dir, { recursive: true });
  const inner = `${target.download.replace(/\.tar\.xz$/, '')}/bin/node`;
  run('tar', ['-xJf', file, '-C', dir, '--strip-components=2', inner]);
  return path.join(dir, 'node');
}

/**
 * Entfernt die Signatur aus einer Windows-Programmdatei. Durch das Einsetzen unseres Programms
 * würde sie ohnehin ungültig – und eine ungültige Signatur ist schlechter als keine.
 */
export function stripAuthenticode(file) {
  const data = fs.readFileSync(file);
  if (data.readUInt16LE(0) !== 0x5a4d) return false;
  const pe = data.readUInt32LE(0x3c);
  if (data.readUInt32LE(pe) !== 0x00004550) return false;
  const optional = pe + 24;
  const magic = data.readUInt16LE(optional);
  const directories = optional + (magic === 0x20b ? 112 : 96);
  const entry = directories + 4 * 8; // Eintrag 4: Zertifikatstabelle
  const offset = data.readUInt32LE(entry);
  const size = data.readUInt32LE(entry + 4);
  if (!offset || !size) return false;
  data.writeUInt32LE(0, entry);
  data.writeUInt32LE(0, entry + 4);
  // Die Tabelle steht am Dateiende; nur dann lässt sie sich einfach abschneiden
  const end = offset + size;
  const trimmed = end >= data.length - 8 ? data.subarray(0, offset) : data;
  fs.writeFileSync(file, trimmed);
  return true;
}

function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Schreibt ein ZIP-Archiv. entries: [{ name, data, mode }] – mode für ausführbare Dateien unter Linux. */
export function writeZip(file, entries, date = new Date()) {
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const deflated = zlib.deflateRawSync(entry.data, { level: 9 });
    const stored = deflated.length >= entry.data.length;
    const body = stored ? entry.data : deflated;
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // Dateinamen in UTF-8
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE((3 << 8) | 20, 4); // erstellt unter Unix, damit die Dateirechte gelten
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(stored ? 0 : 8, 10);
    header.writeUInt16LE(dosTime, 12);
    header.writeUInt16LE(dosDate, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE((((entry.mode ?? 0o644) | 0o100000) << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + body.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...parts, ...central, end]));
}

/** Text für Windows: Zeilenenden CRLF und UTF-8-Kennung, damit auch der alte Editor Umlaute zeigt. */
function windowsText(text) {
  return Buffer.from(`﻿${text.replace(/\r?\n/g, '\r\n')}`, 'utf8');
}

async function main() {
  const targetName = process.argv[2] || 'win-x64';
  const target = TARGETS[targetName];
  if (!target) fail(`Unbekanntes Ziel „${targetName}“. Möglich: ${Object.keys(TARGETS).join(', ')}`);
  if (Number(process.versions.node.split('.')[0]) < 22) fail('Zum Bauen wird Node.js 22 oder neuer gebraucht.');

  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  console.log(`TV-Simulator ${version} → ${targetName} (Node.js ${process.version})`);
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  // 1. Werkzeuge (nur in dist/, nicht im Projekt)
  const tools = path.join(CACHE, 'werkzeuge');
  const toolsRequire = createRequire(path.join(tools, 'x.js'));
  const installed = (name, wanted) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(tools, 'node_modules', name, 'package.json'), 'utf8')).version === wanted;
    } catch {
      return false;
    }
  };
  if (!installed('esbuild', ESBUILD_VERSION) || !installed('postject', POSTJECT_VERSION)) {
    console.log('Lade Werkzeuge (esbuild, postject) …');
    fs.mkdirSync(tools, { recursive: true });
    fs.writeFileSync(path.join(tools, 'package.json'), '{"private":true}\n');
    run('npm', ['install', '--prefix', tools, '--no-audit', '--no-fund', '--loglevel=error', `esbuild@${ESBUILD_VERSION}`, `postject@${POSTJECT_VERSION}`]);
  }

  // 2. Server zu einem einzigen Skript bündeln
  const bundle = path.join(WORK, 'tv-simulator.cjs');
  await toolsRequire('esbuild').build({
    entryPoints: [path.join(ROOT, 'server.js')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: `node${process.versions.node.split('.')[0]}`,
    define: { 'import.meta.url': '__tvImportMetaUrl' },
    banner: { js: "const __tvImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
    logLevel: 'warning',
  });

  // 3. Mitgelieferte Dateien und Programm zu einem Paket für Node.js schnüren
  const assets = {
    'package.json': path.join(ROOT, 'package.json'),
    'config.json': path.join(ROOT, 'config.json'),
    'server/defaults.jsonc': path.join(ROOT, 'server', 'defaults.jsonc'),
    'media/LIESMICH.md': path.join(ROOT, 'media', 'LIESMICH.md'),
  };
  for (const rel of listFiles(path.join(ROOT, 'public'))) assets[`public/${rel}`] = path.join(ROOT, 'public', rel);
  const blob = path.join(WORK, 'tv-simulator.blob');
  const seaConfig = path.join(WORK, 'sea-config.json');
  fs.writeFileSync(
    seaConfig,
    JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, assets }, null, 2),
  );
  run(process.execPath, ['--experimental-sea-config', seaConfig], { shell: false });

  // 4. In eine Kopie von Node.js einsetzen
  const program = path.join(WORK, target.program);
  fs.copyFileSync(await nodeBinary(targetName, target), program);
  fs.chmodSync(program, 0o755);
  if (target.windows && stripAuthenticode(program)) console.log('Signatur von Node.js entfernt (sie wäre nach dem Umbau ungültig).');
  await toolsRequire('postject').inject(program, 'NODE_SEA_BLOB', fs.readFileSync(blob), {
    sentinelFuse: SEA_FUSE,
    machoSegmentName: 'NODE_SEA',
    overwrite: true,
  });
  if (!fs.readFileSync(program).includes(`${SEA_FUSE}:1`)) fail('Das Programm wurde nicht richtig eingesetzt.');

  // 5. Paket mit allem, was neben dem Programm liegen soll
  const folder = 'TV-Simulator-1977';
  const liesmich = fs
    .readFileSync(path.join(ROOT, 'tools', target.windows ? 'LIESMICH-windows.txt' : 'LIESMICH-linux.txt'), 'utf8')
    .replaceAll('{VERSION}', version);
  const entries = [
    { name: `${folder}/${target.program}`, data: fs.readFileSync(program), mode: 0o755 },
    { name: `${folder}/LIESMICH.txt`, data: target.windows ? windowsText(liesmich) : Buffer.from(liesmich) },
    { name: `${folder}/config.json`, data: fs.readFileSync(path.join(ROOT, 'config.json')) },
    { name: `${folder}/media/LIESMICH.md`, data: fs.readFileSync(path.join(ROOT, 'media', 'LIESMICH.md')) },
  ];
  if (!target.windows) entries.push({ name: `${folder}/start-pi.sh`, data: fs.readFileSync(path.join(ROOT, 'start-pi.sh')), mode: 0o755 });
  const scripts = target.windows ? ['autostart-windows.bat', 'video-umwandeln.bat'] : ['autostart-pi.sh', 'video-umwandeln.sh'];
  for (const script of scripts) {
    entries.push({ name: `${folder}/scripts/${script}`, data: fs.readFileSync(path.join(ROOT, 'scripts', script)), mode: script.endsWith('.sh') ? 0o755 : 0o644 });
  }
  const zip = path.join(DIST, `TV-Simulator-1977-${version}-${targetName === 'win-x64' ? 'windows' : targetName}.zip`);
  writeZip(zip, entries);
  const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
  console.log(`\nFertig: ${path.relative(ROOT, zip)} (${mb(fs.statSync(zip).size)}), Programm ${target.program} ${mb(fs.statSync(program).size)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Hinter einem Proxy braucht der Download von Node.js diese Einstellung; sie gilt erst ab Programmstart
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxy && !process.env.NODE_USE_ENV_PROXY) {
    const result = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1' } });
    process.exit(result.status ?? 1);
  }
  main().catch((err) => fail(err.stack || err.message));
}
