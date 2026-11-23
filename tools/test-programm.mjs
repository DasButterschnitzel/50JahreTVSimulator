#!/usr/bin/env node
// Probelauf des eigenständigen Programms aus tools/build-exe.mjs – so, wie es später benutzt wird:
// in einem frischen Ordner starten, Seiten und Filme abrufen, über die Fernbedienung beenden.
//
//   node tools/test-programm.mjs <Programmdatei>            nur der Server
//   node tools/test-programm.mjs <Programmdatei> --kiosk    zusätzlich der Start im Vollbild
//                                                           (braucht Edge, Chrome oder Chromium)

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const program = process.argv[2] && path.resolve(process.argv[2]);
const withKiosk = process.argv.includes('--kiosk');
if (!program || !fs.existsSync(program)) {
  console.error('Aufruf: node tools/test-programm.mjs <Programmdatei> [--kiosk]');
  process.exit(2);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv77-programm-'));
const exe = path.join(dir, path.basename(program));
fs.copyFileSync(program, exe);
fs.chmodSync(exe, 0o755);

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : 'FEHLER'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });

function start(args) {
  let output = '';
  const child = spawn(exe, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  child.on('error', (err) => (output += `Start fehlgeschlagen: ${err.message}\n`));
  return { child, exited, output: () => output };
}

async function waitFor(fn, seconds) {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      // Server noch nicht bereit
    }
    if (Date.now() > end) return null;
    await sleep(500);
  }
}

async function quit(base, run) {
  await fetch(`${base}/api/system`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'quit' }) }).catch(() => {});
  const code = await Promise.race([run.exited, sleep(20000).then(() => 'läuft noch')]);
  if (code === 'läuft noch') run.child.kill();
  return code;
}

try {
  // 1. Nur der Server, in einem leeren Ordner
  let port = await freePort();
  let base = `http://127.0.0.1:${port}`;
  let run = start(['--server', '--port', String(port)]);
  const up = await waitFor(async () => (await fetch(`${base}/api/config`)).ok, 90);
  check('Programm startet und antwortet', !!up, up ? '' : run.output().slice(-400));
  if (up) {
    const config = await (await fetch(`${base}/api/config`)).json();
    const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    check('meldet die richtige Version', config.version === version, config.version);

    const index = await fetch(`${base}/`);
    check('Anzeige wird aus der Programmdatei geliefert', index.ok && (await index.text()).includes('<canvas'));
    const admin = await fetch(`${base}/admin`);
    check('Fernbedienung wird geliefert', admin.ok && (await admin.text()).includes('Fernbedienung'));
    const script = await fetch(`${base}/js/shaders.js`);
    check('Skripte der Anzeige werden geliefert', script.ok && /javascript/.test(script.headers.get('content-type') || ''));
    check('nichts außerhalb der Anzeige ist abrufbar', (await fetch(`${base}/js/%2e%2e/%2e%2e/package.json`)).status === 404);

    check('config.json und media/ werden beim ersten Start angelegt', fs.existsSync(path.join(dir, 'config.json')) && fs.existsSync(path.join(dir, 'media', 'LIESMICH.md')));

    // Ein „Film“ mit Leerzeichen und Umlaut im Namen; abgespielt wird hier nichts, nur ausgeliefert
    const film = crypto.randomBytes(200000);
    fs.mkdirSync(path.join(dir, 'media', '1 Tagesschau'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'media', '1 Tagesschau', 'Sendung vom März.mp4'), film);
    const channels = (await (await fetch(`${base}/api/channels`)).json()).channels;
    const channel = channels.find((c) => c.name === 'Tagesschau');
    check('Ordner in media wird als Sender erkannt', !!channel && channel.files?.[0]?.name === 'Sendung vom März.mp4', channels.map((c) => c.name).join(', '));
    if (channel?.files?.[0]) {
      const whole = await fetch(`${base}${channel.files[0].url}`);
      check('Film wird vollständig geliefert', whole.ok && Buffer.from(await whole.arrayBuffer()).equals(film));
      const part = await fetch(`${base}${channel.files[0].url}`, { headers: { Range: 'bytes=1000-1999' } });
      check('Film wird in Teilen geliefert (Spulen)', part.status === 206 && Buffer.from(await part.arrayBuffer()).equals(film.subarray(1000, 2000)));
    }

    const saved = await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ patch: { audio: { volume: 0.33 } } }) });
    check('Einstellungen lassen sich ändern', saved.ok);
  }
  let code = await quit(base, run);
  check('Beenden über die Fernbedienung beendet Programm und Wächter', code === 0, `Code ${code}`);
  check('Einstellungen wurden gespeichert', /0\.33/.test(fs.existsSync(path.join(dir, 'data', 'state.json')) ? fs.readFileSync(path.join(dir, 'data', 'state.json'), 'utf8') : ''));

  // 2. Start per „Doppelklick“: Fernseher im Vollbild
  if (withKiosk) {
    port = await freePort();
    base = `http://127.0.0.1:${port}`;
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ server: { port } }));
    run = start([]);
    const alive = await waitFor(async () => {
      const status = await (await fetch(`${base}/api/status`)).json();
      return status.server.kiosk && status.status && status.age !== null && status.age < 15000 ? status : null;
    }, 120);
    check('Start ohne Zusätze öffnet den Browser, die Anzeige meldet sich', !!alive, alive ? `${alive.status.fps} Bilder/s` : run.output().slice(-600));
    if (alive) {
      check('Röhrensimulation läuft (WebGL)', alive.status.plain === false, `plain=${alive.status.plain}`);
      check('Sender aus media ist an der Anzeige angekommen', alive.status.channels.some((c) => c.name === 'Tagesschau'), alive.status.channels.map((c) => c.name).join(', '));
    }
    code = await quit(base, run);
    check('Beenden schließt auch den Browser und den Wächter', code === 0, `Code ${code}`);
    if (failed) console.log(run.output().slice(-1500));
  }
} finally {
  await sleep(500);
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch {
    // unter Windows hält der Browser sein Profil manchmal noch kurz fest
  }
}

console.log(failed ? `\n${failed} Prüfung(en) fehlgeschlagen.` : '\nAlle Prüfungen bestanden.');
process.exit(failed ? 1 : 0);
