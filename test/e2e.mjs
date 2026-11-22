#!/usr/bin/env node
// Funktionstest im echten Browser (Chromium über Playwright).
// Erzeugt Testfilme mit ffmpeg, startet den Server und spielt die wichtigsten
// Bedienschritte durch.   Aufruf: npm run test:e2e
//
// Voraussetzungen: ffmpeg und das npm-Paket "playwright" (npm i -D playwright).

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.js';
import { installYouTubeMock } from './youtube-mock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Das Paket "playwright" fehlt:  npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv77-e2e-'));
const media = path.join(dir, 'media');
const shots = process.env.TV_SHOTS ? path.resolve(process.env.TV_SHOTS) : null;
if (shots) fs.mkdirSync(shots, { recursive: true });

console.log('Erzeuge Testfilme …');
const demo = spawnSync(process.execPath, [path.join(ROOT, 'tools/make-demo.mjs'), '--webm', '--out', media, '--seconds', '12'], { stdio: 'inherit' });
if (demo.status !== 0) process.exit(2);
fs.mkdirSync(path.join(media, '06-kaputt'));
fs.writeFileSync(path.join(media, '06-kaputt', 'defekt.mp4'), 'das ist kein Film');
fs.writeFileSync(path.join(media, '01-demo-farbe', '03-defekt.webm'), 'auch kein Film');

// Der Test läuft wahlweise gegen den Node-Server (Standard) oder – mit TV_E2E_SERVER=java –
// gegen den Server der Android-App, der dazu auf dem PC gestartet wird.
const useJava = process.env.TV_E2E_SERVER === 'java';
let base;
let stopServer;
if (useJava) {
  const classes = path.join(dir, 'classes');
  const sources = [];
  const collect = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) collect(full);
      else if (entry.name.endsWith('.java') && !entry.name.endsWith('Test.java') && full.includes(`${path.sep}server${path.sep}`)) sources.push(full);
    }
  };
  collect(path.join(ROOT, 'android/app/src'));
  const javac = spawnSync('javac', ['-d', classes, ...sources], { stdio: 'inherit' });
  if (javac.status !== 0) process.exit(2);
  const child = spawn('java', ['-cp', classes, 'io.github.dasbutterschnitzel.tv1977.server.DesktopMain', '--public', path.join(ROOT, 'public'), '--defaults', path.join(ROOT, 'server/defaults.jsonc'), '--media', media, '--data', path.join(dir, 'data')], { stdio: ['ignore', 'pipe', 'inherit'] });
  base = await new Promise((resolve, reject) => {
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const match = /PORT=(\d+)/.exec(buffer);
      if (match) resolve(`http://127.0.0.1:${match[1]}`);
      for (const line of String(chunk).split('\n')) if (line.startsWith('[')) console.log('   [server]', line);
    });
    child.on('exit', (code) => reject(new Error(`Java-Server beendet (${code})`)));
  });
  stopServer = async () => child.kill();
  console.log('Teste den Server der Android-App (Java).');
} else {
  const quiet = { info() {}, warn: (m) => console.log('   [server]', m), error: (m) => console.log('   [server]', m) };
  const app = createApp({ config: path.join(dir, 'config.json'), data: path.join(dir, 'data'), media, log: quiet });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
  stopServer = () => app.close();
}

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : 'FEHLER'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = () =>
  page.evaluate(() => {
    const p = window.tv.player;
    const v = p.active;
    return {
      ...p.status(),
      playing: p.itemIndex,
      videoTime: v.currentTime,
      videoPaused: v.paused,
      activeIdx: p.activeIdx,
      source: window.tv.renderer.source?.kind ?? null,
      options: window.tv.renderer.sourceOptions,
      rendererOk: window.tv.renderer.ok,
      audio: window.tv.audio.ctx?.state,
      directorMode: window.tv.director.mode,
      directorPower: window.tv.director.power,
      gain: window.tv.director.dyn.gain,
    };
  });
const waitFor = async (fn, timeout = 10000) => {
  const end = Date.now() + timeout;
  for (;;) {
    const s = await state();
    if (fn(s)) return s;
    if (Date.now() > end) return s;
    await sleep(100);
  }
};
const settled = (s) => !s.switching && s.directorMode === 'idle';
const command = (cmd, args = {}) => fetch(`${base}/api/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd, args }) });
const shot = async (name) => shots && page.screenshot({ path: path.join(shots, `${name}.png`) });

try {
  await page.goto(base);
  await page.waitForFunction(() => window.tv?.player?.channels.length > 0, null, { timeout: 30000 });
  await page.keyboard.press('1');
  // (Am Filmende spielt das Bild den Film noch aus, während die Sendeuhr schon beim nächsten ist – diesen Moment abwarten.)
  let s = await waitFor((x) => settled(x) && x.channelIndex === 0 && x.videoTime > 0 && !x.videoPaused && x.item.index === x.playing);

  check('Röhrensimulation läuft (WebGL)', s.rendererOk);
  check('Sender eingelesen', s.channels.length === 6, s.channels.map((c) => c.name).join(', '));
  check('defekte Datei wird im Sendeplan übersprungen', s.channels[0].films === 2 && s.channels[0].missing === 1);
  check('Film läuft mit Ton', s.item && !s.videoPaused && s.audio === 'running' && !s.needsGesture);
  check('Bild folgt der Sendeuhr', Math.abs(s.videoTime - s.item.offset) < 1, `Abweichung ${(s.videoTime - s.item.offset).toFixed(2)} s`);
  await shot('1-farbe');

  // Gleichzeitig laufende Sender
  const before = s.item.position;
  const t0 = Date.now();
  await page.keyboard.press('ArrowUp');
  s = await waitFor((x) => settled(x) && x.channelIndex === 1 && x.videoTime > 0);
  check('Umschalten mit Pfeiltaste', s.channelIndex === 1 && s.source === 'video');
  check('Schwarz-Weiß-Option des Senders greift', s.options?.blackWhite === true);
  await shot('2-schwarzweiss');
  await sleep(2500);
  await page.keyboard.press('ArrowDown');
  s = await waitFor((x) => settled(x) && x.channelIndex === 0 && x.videoTime > 0);
  const elapsed = (Date.now() - t0) / 1000;
  const expected = (before + elapsed) % s.item.total;
  const diff = Math.min(Math.abs(s.item.position - expected), s.item.total - Math.abs(s.item.position - expected));
  check('Sender 1 lief im Hintergrund weiter', diff < 0.8, `erwartet ${expected.toFixed(1)} s, ist ${s.item.position.toFixed(1)} s`);
  check('Farbe ist nach dem Zurückschalten wieder da', s.options?.blackWhite === false);

  // Pause
  await page.keyboard.press(' ');
  s = await waitFor((x) => x.paused && x.videoPaused);
  const pausedAt = s.item.position;
  await sleep(1500);
  s = await state();
  check('Pause hält Bild und Sendeuhr an', s.paused && s.videoPaused && Math.abs(s.item.position - pausedAt) < 0.05);
  await page.keyboard.press(' ');
  s = await waitFor((x) => !x.paused && !x.videoPaused);
  await sleep(1000);
  s = await state();
  // (das Programm kann in der Zwischenzeit von vorn begonnen haben, deshalb im Kreis gerechnet)
  const sincePause = (((s.item.position - pausedAt) % s.item.total) + s.item.total) % s.item.total;
  check('Weiter nach Pause an derselben Stelle', !s.paused && sincePause > 0 && sincePause < 2.5, `${sincePause.toFixed(2)} s`);

  // Neustart des Films und nahtloser Übergang zum nächsten
  await page.keyboard.press('r');
  await sleep(700);
  s = await state();
  check('Film neu starten', s.item.offset < 1.5 && s.videoTime < 1.5, `Sendeuhr ${s.item.offset.toFixed(2)} s, Bild ${s.videoTime.toFixed(2)} s, Film ${s.item.index + 1}/${s.playing + 1}`);
  const firstIndex = s.item.index;
  const firstActive = s.activeIdx;
  await command('seek', { seconds: s.item.duration - s.item.offset - 4 });
  await sleep(1500);
  s = await state();
  check('Springen (Fernbedienung)', s.item.index === firstIndex && s.item.duration - s.item.offset < 3.5, `Rest ${(s.item.duration - s.item.offset).toFixed(1)} s`);
  s = await waitFor((x) => x.playing !== firstIndex && x.item.index === x.playing && x.videoTime > 0.3 && !x.videoPaused, 9000);
  check('nahtloser Wechsel zum nächsten Film', s.item.index === (firstIndex + 1) % 2 && s.activeIdx !== firstActive && !s.fault, `Film ${s.item.index + 1}, ${s.videoTime.toFixed(2)} s`);
  check('Sendeuhr passt nach dem Filmwechsel', Math.abs(s.videoTime - s.item.offset) < 1, `Abweichung ${(s.videoTime - s.item.offset).toFixed(2)} s`);

  // Alle Sender von vorn
  await page.keyboard.press('Home');
  await sleep(1200);
  await page.keyboard.press('3');
  s = await waitFor((x) => settled(x) && x.channelIndex === 2 && x.videoTime > 0);
  check('alle Sender von vorn', s.item.position < 5, `Sender 3 bei ${s.item.position.toFixed(1)} s`);
  await shot('3-breitbild');

  // Testbild, Rauschen, Störung
  await page.keyboard.press('4');
  s = await waitFor((x) => settled(x) && x.channelIndex === 3);
  check('Testbild', s.source === 'canvas' && !s.fault);
  await shot('4-testbild');
  await page.keyboard.press('5');
  s = await waitFor((x) => x.channelIndex === 4 && !x.switching);
  check('Sender ohne Signal zeigt Rauschen', s.source === null && s.directorMode === 'static');
  await shot('5-rauschen');
  await page.keyboard.press('6');
  s = await waitFor((x) => settled(x) && x.channelIndex === 5);
  check('Sender mit defektem Film zeigt Störungstafel', s.fault && s.source === 'canvas');
  await shot('6-stoerung');
  await page.keyboard.press('1');
  s = await waitFor((x) => settled(x) && x.channelIndex === 0 && x.videoTime > 0 && !x.fault);
  check('danach laufen die anderen Sender normal', !s.fault && s.source === 'video' && !s.videoPaused);

  // Schnelles Durchdrehen am Senderknopf
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('ArrowUp');
    await sleep(40);
  }
  s = await waitFor((x) => settled(x) && x.videoTime > 0, 8000);
  check('schnelles Durchschalten endet auf dem richtigen Sender', s.channelIndex === 0 && s.source === 'video' && !s.videoPaused && !s.fault, `Sender ${s.channelIndex + 1}, Quelle ${s.source}, pausiert ${s.videoPaused}, Störung ${s.fault}, Bild ${s.videoTime.toFixed(2)} s, schaltet ${s.switching}, ${s.directorMode}`);

  // Aus- und Einschalten
  await page.keyboard.press('p');
  s = await waitFor((x) => x.directorPower === 'off', 5000);
  check('Ausschalten', !s.power && s.directorPower === 'off' && s.gain === 0 && s.videoPaused);
  await shot('7-aus');
  await page.keyboard.press('ArrowUp');
  await sleep(300);
  await page.keyboard.press('p');
  s = await waitFor((x) => x.directorPower === 'on' && x.videoTime > 0, 8000);
  check('Einschalten (Sender wurde im ausgeschalteten Zustand weitergedreht)', s.power && s.channelIndex === 1 && !s.videoPaused && s.gain === 1, `an ${s.power}, Sender ${s.channelIndex + 1}, pausiert ${s.videoPaused}, Helligkeit ${s.gain}, Bild ${s.videoTime.toFixed(2)} s, ${s.directorPower}, schaltet ${s.switching}, Film ${s.item?.index}/${s.playing}`);

  // Lautstärke und Einstellungen über die Fernbedienung
  await page.keyboard.press('-');
  await sleep(300);
  const volume = await page.evaluate(() => window.tv.settings.audio.volume);
  check('Lautstärke per Taste', Math.abs(volume - 0.75) < 0.001, String(volume));
  await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ patch: { effects: { curvature: 1.2 }, screen: { rotate: 90 } } }) });
  await sleep(500);
  const live = await page.evaluate(() => [window.tv.settings.effects.curvature, window.tv.settings.screen.rotate]);
  check('Einstellungen der Fernbedienung wirken sofort', live[0] === 1.2 && live[1] === 90);
  await shot('8-gedreht');
  await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reset: true }) });

  // Zustand übersteht das Neuladen
  await command('tune', { index: 2 });
  s = await waitFor((x) => settled(x) && x.channelIndex === 2 && x.videoTime > 0);
  const posBefore = s.item.position;
  const tReload = Date.now();
  await sleep(600);
  await page.reload();
  await page.waitForFunction(() => window.tv?.player?.channels.length > 0, null, { timeout: 30000 });
  s = await waitFor((x) => x.channelIndex === 2 && x.videoTime > 0 && !x.switching, 15000);
  const exp = (posBefore + (Date.now() - tReload) / 1000) % s.item.total;
  const d2 = Math.min(Math.abs(s.item.position - exp), s.item.total - Math.abs(s.item.position - exp));
  check('nach Neuladen: gleicher Sender, Programm lief weiter', s.channelIndex === 2 && d2 < 1, `erwartet ${exp.toFixed(1)} s, ist ${s.item.position.toFixed(1)} s`);

  // Fernbedienungsseite
  const admin = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const adminErrors = [];
  admin.on('pageerror', (e) => adminErrors.push(e.message));
  await admin.goto(`${base}/admin`);
  await admin.waitForFunction(() => document.querySelectorAll('#channels button').length === 6, null, { timeout: 10000 }).catch(() => {});
  const buttons = await admin.locator('#channels button').count();
  check('Fernbedienung zeigt die Sender', buttons === 6, `${buttons} Sender`);
  await admin.locator('#channels button').nth(3).click();
  s = await waitFor((x) => settled(x) && x.channelIndex === 3);
  check('Umschalten über die Fernbedienung', s.channelIndex === 3);
  await admin.locator('#pause').click();
  s = await waitFor((x) => x.paused);
  check('Pause über die Fernbedienung', s.paused);
  await admin.locator('#pause').click();
  await waitFor((x) => !x.paused);
  const overflow = await admin.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('Fernbedienung passt auf ein Telefon', overflow <= 0, `${overflow}px`);
  if (shots) await admin.screenshot({ path: path.join(shots, '9-fernbedienung.png'), fullPage: true });
  await admin.close();

  // Anzeige unsichtbar (App im Hintergrund): Wiedergabe hält an, die Sendeuhr läuft weiter
  await command('tune', { index: 0 });
  s = await waitFor((x) => settled(x) && x.channelIndex === 0 && x.videoTime > 0 && !x.videoPaused);
  const setVisibility = (value) =>
    page.evaluate((v) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
      document.dispatchEvent(new Event('visibilitychange'));
    }, value);
  const hiddenAt = s.item.position;
  await setVisibility('hidden');
  await sleep(1500);
  s = await state();
  const whileHidden = (((s.item.position - hiddenAt) % s.item.total) + s.item.total) % s.item.total;
  check('im Hintergrund hält die Wiedergabe an, die Sendeuhr läuft weiter', s.videoPaused && whileHidden > 1 && whileHidden < 3, `${whileHidden.toFixed(2)} s`);
  await setVisibility('visible');
  s = await waitFor((x) => !x.videoPaused && x.playing === x.item.index && Math.abs(x.videoTime - x.item.offset) < 1, 8000);
  check('zurück im Vordergrund läuft das Bild an der richtigen Stelle weiter', !s.videoPaused && Math.abs(s.videoTime - s.item.offset) < 1, `Abweichung ${(s.videoTime - s.item.offset).toFixed(2)} s`);

  // Internet-Sender: Filme von einem fremden Server durch die volle Röhrensimulation.
  // Der zweite Server verhält sich wie die Auslieferungsserver von archive.org: Er erlaubt dem
  // Browser NICHT, seine Videos einzubinden. Der eigene Server muss sie deshalb abholen und weiterreichen.
  // Die Liste eines archive.org-Eintrags wird mit nachgestellten Metadaten geprüft.
  await page.goto('about:blank');
  const foreign = createApp({ config: path.join(dir, 'fremd.json'), data: path.join(dir, 'fremd-data'), media, log: { info() {}, warn() {}, error() {} } });
  await new Promise((resolve) => foreign.server.listen(0, '127.0.0.1', resolve));
  const foreignBase = `http://127.0.0.1:${foreign.server.address().port}`;
  const archiveFiles = {
    '1977 Muster.webm': '/media/01-demo-farbe/01-testmuster.webm',
    '1977 Balken.webm': '/media/01-demo-farbe/02-farbbalken.webm',
    '1977 Balken Kopie.webm': '/media/01-demo-farbe/02-farbbalken.webm',
    '1976 Anderes Jahr.webm': '/media/03-demo-breitbild/01-breitbild.webm',
  };
  const mockArchive = async (target) => {
    await target.route('https://archive.org/metadata/**', (route) => {
      const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop());
      const body = id === 'testfilme' ? { metadata: { identifier: 'testfilme' }, files: Object.keys(archiveFiles).map((name) => ({ name, format: 'WebM', source: 'original', size: '1000', length: name.includes('Muster') ? '12.0' : '6.0' })) } : {};
      route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    });
  };
  const postSettings = (body) => fetch(`${base}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const remoteUrl = (file) => `/remote/${encodeURIComponent(foreignBase + file)}`;
  await postSettings({
    patch: {
      web: {
        channels: [
          { id: 'web-test', name: 'Archiv 1977', urls: [`${foreignBase}/media/01-demo-farbe/02-farbbalken.webm`, `${foreignBase}/media/01-demo-farbe/01-testmuster.webm`, `${foreignBase}/media/03-demo-breitbild/01-breitbild.webm`] },
          { id: 'web-liste', name: 'Archiv Liste', urls: ['https://archive.org/details/testfilme#1977'] },
        ],
      },
    },
  });

  const web = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const webErrors = [];
  web.on('pageerror', (e) => webErrors.push(e.message));
  await mockArchive(web);
  await web.goto(base);
  await web.waitForFunction(() => window.tv?.player?.channels.length > 0 && !window.tv.player.switching, null, { timeout: 30000 });
  const webState = () =>
    web.evaluate(() => {
      const p = window.tv.player;
      const st = p.status();
      const v = p.active;
      return {
        names: st.channels.map((c) => c.name),
        all: st.channels.map((c) => [c.name, c.films, Math.round(c.total)]),
        index: st.channelIndex,
        films: st.channels[st.channelIndex]?.films,
        total: st.channels[st.channelIndex]?.total,
        item: st.item,
        playing: p.itemIndex,
        fault: st.fault,
        idle: window.tv.director.mode === 'idle' && !st.switching,
        paused: v.paused,
        time: v.currentTime,
        src: v.currentSrc,
        source: window.tv.renderer.source?.kind ?? null,
        ready: window.tv.renderer.sourceReady,
        audio: window.tv.audio.ctx?.state,
        list: (p.channel?.files || []).map((f) => f.name),
      };
    });
  const webWait = async (fn, timeout = 20000) => {
    const end = Date.now() + timeout;
    for (;;) {
      const x = await webState();
      if (fn(x) || Date.now() > end) return x;
      await sleep(150);
    }
  };
  let w = await webState();
  const webIndex = w.names.indexOf('Archiv 1977');
  check('Internet-Sender steht in der Senderliste', webIndex >= 0, w.names.join(', '));
  await web.evaluate((i) => window.tv.player.tune(i), webIndex);
  w = await webWait((x) => x.index === webIndex && x.idle && !x.paused && x.time > 0.5 && x.ready && x.item && x.playing === x.item.index);
  const liste = w.all.find((c) => c[0] === 'Archiv Liste');
  check('archive.org-Eintrag wird aufgelöst: Filter „1977“, ohne Doppelte, Längen aus den Metadaten', !!liste && liste[1] === 2 && liste[2] === 18, JSON.stringify(liste));
  check('Internet-Sender mit direkten Adressen: Längen über den eigenen Server gemessen', w.list.join('|') === '02-farbbalken|01-testmuster|01-breitbild' && Math.abs(w.total - (6 + 12 + 12.003)) < 0.5, `${w.list.join('|')} · ${w.total?.toFixed(1)} s`);
  check('Film vom fremden Server (ohne Freigabe zum Einbinden) läuft durch die Röhrensimulation, mit Ton', w.source === 'video' && w.ready && !w.paused && !w.fault && w.audio === 'running' && w.src.startsWith(`${base}/remote/`), w.src.slice(0, 60));
  check('Internet-Sender folgt der Sendeuhr', Math.abs(w.time - w.item.offset) < 1.5, `Abweichung ${(w.time - w.item.offset).toFixed(2)} s`);
  if (shots) await web.screenshot({ path: path.join(shots, '12-archive.png') });

  // einzelne Filme abwählen
  const balken = remoteUrl('/media/01-demo-farbe/02-farbbalken.webm');
  await postSettings({ patch: { hiddenFiles: [balken] } });
  w = await webWait((x) => x.films === 2 && x.idle && !x.paused && x.time > 0.3);
  check('abgewählter Film läuft nicht mehr mit', w.films === 2 && w.list.join('|') === '01-testmuster|01-breitbild' && !w.fault, w.list.join('|'));
  const before2 = w.names.length;
  await postSettings({ patch: { hiddenFiles: [balken, '/media/02-demo-schwarzweiss/01-muster.webm'] } });
  w = await webWait((x) => x.names.length === before2 - 1);
  check('Sender ohne ausgewählte Filme verschwindet', w.names.length === before2 - 1 && !w.names.includes('Demo Schwarz-Weiß'), w.names.join(', '));
  check('der laufende Sender bleibt dabei eingestellt', w.names[w.index] === 'Archiv 1977', w.names[w.index]);
  check('keine Skriptfehler beim Internet-Sender', webErrors.length === 0, webErrors.join(' | '));
  await web.close();

  // Bedienseite: Filme auswählen und Vorschläge für 1977
  const admin2 = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const admin2Errors = [];
  admin2.on('pageerror', (e) => admin2Errors.push(e.message));
  admin2.on('dialog', (d) => d.accept());
  await mockArchive(admin2);
  await admin2.goto(`${base}/admin`);
  await admin2.waitForFunction(() => document.querySelectorAll('#library details').length >= 4, null, { timeout: 15000 }).catch(() => {});
  const lib = await admin2.$$eval('#library details', (els) => els.map((d) => [d.querySelector('summary').textContent, d.querySelectorAll('input:checked').length, d.querySelectorAll('input').length]));
  const libArchive = lib.find((l) => l[0].startsWith('Archiv 1977'));
  const libSw = lib.find((l) => l[0].startsWith('Demo Schwarz-Weiß'));
  check('„Filme auswählen“ zeigt alle Sender mit dem Stand der Auswahl', !!libArchive && libArchive[1] === 2 && libArchive[2] === 3 && !!libSw && libSw[1] === 0 && libSw[2] === 1, JSON.stringify(lib.map((l) => l[0])));
  // den abgewählten Film im Archiv-Sender wieder ankreuzen
  await admin2.evaluate(() => {
    const details = [...document.querySelectorAll('#library details')].find((d) => d.querySelector('summary').textContent.startsWith('Archiv 1977'));
    details.open = true;
    details.querySelector('input:not(:checked)').click();
  });
  let hiddenNow = [];
  for (let i = 0; i < 40; i++) {
    hiddenNow = (await (await fetch(`${base}/api/config`)).json()).settings.hiddenFiles;
    if (hiddenNow.length === 1) break;
    await sleep(100);
  }
  check('Ankreuzen in der Bedienseite speichert die Auswahl', hiddenNow.length === 1 && hiddenNow[0] === '/media/02-demo-schwarzweiss/01-muster.webm', JSON.stringify(hiddenNow));

  const presets = await admin2.$$eval('#presets-1977 .entry', (els) => els.map((e) => e.querySelector('b').textContent));
  check('Vorschläge für 1977 werden angeboten', presets.length === 7 && presets[0] === 'Werbefernsehen 1977', presets.join(', '));
  await admin2.evaluate(() => document.querySelector('#presets-1977 .entry button').click());
  let saved = null;
  for (let i = 0; i < 40; i++) {
    saved = (await (await fetch(`${base}/api/config`)).json()).settings.web.channels.find((c) => c.id === 'p77-werbung');
    if (saved) break;
    await sleep(100);
  }
  await admin2.waitForFunction(() => document.querySelector('#presets-1977 .entry button')?.disabled, null, { timeout: 5000 }).catch(() => {});
  const presetButton = await admin2.$eval('#presets-1977 .entry button', (b) => [b.textContent, b.disabled]);
  check('Vorschlag wird als Sender angelegt', saved?.urls?.[0] === 'https://archive.org/details/Commercials_de_1970s#1977' && presetButton[1], `${presetButton[0]}`);
  const overflow2 = await admin2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('Bedienseite passt mit den neuen Karten auf ein Telefon', overflow2 <= 0, `${overflow2}px`);
  if (shots) await admin2.screenshot({ path: path.join(shots, '13-bedienseite-filme.png'), fullPage: true });
  check('keine Skriptfehler in der Bedienseite', admin2Errors.length === 0, admin2Errors.join(' | '));
  await admin2.close();
  await postSettings({ reset: true });
  await foreign.close();

  // YouTube-Sender (gegen einen nachgebauten YouTube-Player, siehe test/youtube-mock.mjs)
  await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      patch: {
        youtube: {
          channels: [
            { id: 'yt-liste', name: 'YT Liste', urls: ['https://youtu.be/AAAAAAAAAAA', 'https://www.youtube.com/playlist?list=PLtestlist0001'] },
            { id: 'yt-kaputt', name: 'YT kaputt', urls: ['https://youtu.be/NOTFOUND000', 'https://youtu.be/NOEMBED0000', 'https://www.youtube.com/watch?v=BBBBBBBBBBB', 'kein link'] },
          ],
        },
      },
    }),
  });
  const yt = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const ytErrors = [];
  yt.on('pageerror', (e) => ytErrors.push(e.message));
  await installYouTubeMock(yt, {
    videos: { AAAAAAAAAAA: '/media/01-demo-farbe/01-testmuster.webm', BBBBBBBBBBB: '/media/01-demo-farbe/02-farbbalken.webm', CCCCCCCCCCC: '/media/03-demo-breitbild/01-breitbild.webm' },
    playlists: { PLtestlist0001: ['CCCCCCCCCCC', 'BBBBBBBBBBB'] },
  });
  await yt.goto(base);
  await yt.waitForFunction(() => window.tv?.player?.channels.length > 0 && !window.tv.player.switching, null, { timeout: 30000 });
  const ytState = () =>
    yt.evaluate(() => {
      const p = window.tv.player;
      const mock = window.__ytPlayers?.[0];
      const st = p.status();
      return {
        channel: st.channelIndex,
        types: st.channels.map((c) => c.type),
        films: st.channels[st.channelIndex]?.films,
        missing: st.channels[st.channelIndex]?.missing,
        item: st.item,
        playing: p.itemIndex,
        fault: st.fault,
        switching: st.switching,
        ytMode: document.body.classList.contains('yt'),
        overlay: window.tv.overlay.ok,
        idle: window.tv.director.mode === 'idle',
        time: mock?.video?.currentTime ?? -1,
        paused: mock?.video?.paused ?? true,
        muted: mock?.video?.muted ?? true,
        volume: mock?.volume,
        id: mock?.id,
        calls: mock?.calls ?? [],
        box: (() => {
          const r = document.getElementById('yt').getBoundingClientRect();
          return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
        })(),
        filter: document.getElementById('yt').style.filter,
        colorFilter: document.querySelector('#yt .yt-inner').style.filter,
        masks: getComputedStyle(document.querySelector('#yt .yt-mask-top')).display === 'block',
        diagnostics: window.tv.youtube.diagnostics(),
        source: window.tv.renderer.source?.kind ?? null,
      };
    });
  const ytWait = async (fn, timeout = 20000) => {
    const end = Date.now() + timeout;
    for (;;) {
      const x = await ytState();
      if (fn(x) || Date.now() > end) return x;
      await sleep(150);
    }
  };
  const inSync = (x) => x.ytMode && x.idle && !x.switching && !x.paused && x.item && x.playing === x.item.index && Math.abs(x.time - x.item.offset) < 1.5;
  let y = await ytState();
  check('YouTube-Sender stehen hinter den Ordner-Sendern', y.types.join(',') === 'video,video,video,testcard,noise,video,youtube,youtube', y.types.join(','));
  await yt.keyboard.press('7');
  // Beim ersten Mal sind die Längen geschätzt; sie werden beim Abspielen gelernt, bis Bild und Sendeuhr übereinstimmen.
  y = await ytWait(inSync, 40000);
  check('YouTube-Sender läuft unter der Effektschicht', y.ytMode && y.overlay && !y.paused && !y.fault, `Video ${y.id}, ${y.time.toFixed(1)} s`);
  check('Playlist wurde aufgelöst (1 Video + 2 aus der Playlist)', y.films === 3, `${y.films} Videos`);
  check('YouTube-Bild folgt der Sendeuhr', inSync(y), y.item ? `Abweichung ${(y.time - y.item.offset).toFixed(2)} s` : 'kein Film');
  check('YouTube-Bild sitzt in der Bildröhre (4:3, mittig)', Math.abs(y.box[2] / y.box[3] - 4 / 3) < 0.02 && Math.abs(y.box[0] + y.box[2] / 2 - 640) < 2 && y.box[3] === 720, y.box.join(','));
  check('Wölbung und Farbfilter liegen getrennt auf dem YouTube-Bild', y.filter === 'url("#yt-warp")' && y.colorFilter.includes('contrast') && !y.colorFilter.includes('url('), `${y.filter} | ${y.colorFilter}`);
  check('solange YouTube läuft, sind die Blenden für seine Bedienoberfläche weg', !y.masks);

  // Schwarz-Weiß: gemessen am Bildschirmfoto, auf zwei voneinander unabhängigen Wegen
  const saturation = async () => {
    const png = await yt.screenshot({ clip: { x: 340, y: 180, width: 600, height: 360 } });
    return yt.evaluate(async (dataUrl) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, img.width, img.height).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum += (Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2])) / 255;
      return sum / (data.length / 4);
    }, `data:image/png;base64,${png.toString('base64')}`);
  };
  const colourful = await saturation();
  await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ patch: { effects: { blackWhite: true } } }) });
  y = await ytWait((x) => x.colorFilter.includes('grayscale') && x.diagnostics.grey);
  const greyBoth = await saturation();
  await yt.evaluate(() => (document.querySelector('#yt .yt-inner').style.filter = ''));
  const greyBlendOnly = await saturation();
  await yt.evaluate(() => {
    document.querySelector('#yt .yt-grey').style.display = 'none';
    document.querySelector('#yt .yt-inner').style.filter = 'grayscale(1)';
  });
  const greyFilterOnly = await saturation();
  check('Schwarz-Weiß wirkt auf das YouTube-Bild', colourful > 0.3 && greyBoth < 0.05, `Farbe ${colourful.toFixed(2)} -> ${greyBoth.toFixed(3)}`);
  check('… sowohl über den Farbfilter als auch über die Grau-Schicht allein', greyFilterOnly < 0.05 && greyBlendOnly < 0.05, `Filter ${greyFilterOnly.toFixed(3)}, Schicht ${greyBlendOnly.toFixed(3)}`);
  check('Diagnose der YouTube-Filter steht im Status', y.diagnostics.color.includes('grayscale') && y.diagnostics.warp.includes('url('), JSON.stringify(y.diagnostics));
  await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ patch: { effects: { blackWhite: false } } }) });
  y = await ytWait((x) => !x.colorFilter.includes('grayscale') && !x.diagnostics.grey);
  y = await ytWait((x) => inSync(x) && !x.muted);
  check('Ton von YouTube ist an und folgt der Lautstärke', !y.muted && y.volume === Math.round(0.8 ** 2 * 100), `Lautstärke ${y.volume}`);
  await sleep(1500);
  await shot('11-youtube');
  if (shots) await yt.screenshot({ path: path.join(shots, '11-youtube.png') });

  await yt.keyboard.press(' ');
  y = await ytWait((x) => x.paused);
  const ytPausedAt = y.time;
  await sleep(1200);
  y = await ytState();
  check('Pause hält YouTube an', y.paused && Math.abs(y.time - ytPausedAt) < 0.1);
  check('angehalten verdecken Blenden YouTubes Titel und „Weitere Videos“', y.masks);
  await yt.keyboard.press(' ');
  y = await ytWait((x) => !x.paused);
  check('Weiter nach Pause', !y.paused);
  await yt.keyboard.press('r');
  y = await ytWait((x) => !x.paused && x.time < 2 && x.item?.offset < 2);
  check('Film neu starten wirkt auf YouTube', y.time < 2 && y.item.offset < 2, `${y.time.toFixed(2)} s`);
  const ytItem = y.item.index;
  await yt.keyboard.press('n');
  y = await ytWait((x) => inSync(x) && x.item.index === (ytItem + 1) % 3);
  check('nächster Film wirkt auf YouTube', y.item.index === (ytItem + 1) % 3 && inSync(y), `Video ${y.id}`);

  // Filmende: weiter zum nächsten Video
  const beforeEnd = y.item.index;
  await yt.evaluate(() => {
    const p = window.tv.player;
    const loc = p.locateNow();
    p.seekBy(loc.item.duration - loc.offset - 2.5);
  });
  y = await ytWait((x) => inSync(x) && x.item.index === (beforeEnd + 1) % 3, 20000);
  check('nach dem Ende eines YouTube-Videos läuft das nächste', y.item.index === (beforeEnd + 1) % 3 && !y.paused, `Video ${y.id}`);

  // zurück zu einem eigenen Film und wieder zu YouTube
  await yt.keyboard.press('1');
  y = await ytWait((x) => !x.ytMode && x.idle && !x.switching && x.source === 'video');
  check('Wechsel zu einem eigenen Film blendet YouTube aus und hält es an', !y.ytMode && y.source === 'video' && y.paused);
  const ytLeft = Date.now();
  await sleep(2000);
  await yt.keyboard.press('7');
  y = await ytWait(inSync);
  check('YouTube-Sender lief im Hintergrund weiter', inSync(y) && Date.now() - ytLeft > 2000, y.item ? `Stelle ${y.item.position.toFixed(1)} s` : '');

  // nicht abspielbare Videos werden übersprungen
  await yt.keyboard.press('8');
  y = await ytWait((x) => x.ytMode && x.idle && !x.switching && !x.paused && x.id === 'BBBBBBBBBBB', 30000);
  check('gesperrte und gelöschte YouTube-Videos werden übersprungen', y.id === 'BBBBBBBBBBB' && !y.paused && !y.fault, `läuft: ${y.id}`);
  check('ungültige Adresse wird gemeldet', y.missing === 1, `${y.missing}`);

  // Aus- und Einschalten
  await yt.keyboard.press('p');
  y = await ytWait((x) => x.paused);
  check('Ausschalten hält YouTube an', y.paused);
  await yt.keyboard.press('p');
  y = await ytWait((x) => x.ytMode && !x.paused && x.id === 'BBBBBBBBBBB', 20000);
  check('Einschalten startet YouTube wieder', !y.paused && y.ytMode);
  check('keine Skriptfehler bei YouTube-Sendern', ytErrors.length === 0, ytErrors.join(' | '));
  await yt.close();
  await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reset: true }) });

  // Berührungsbildschirm (Handy, Besucher-Display): Wischen und langes Drücken
  // (die erste Anzeige wird dafür geschlossen, sonst ist der Testrechner für eine zügige Wischbewegung zu langsam)
  await page.goto('about:blank');
  const touchContext = await browser.newContext({ viewport: { width: 900, height: 420 }, hasTouch: true, isMobile: true });
  const touch = await touchContext.newPage();
  const touchErrors = [];
  touch.on('pageerror', (e) => touchErrors.push(e.message));
  await touch.goto(base);
  await touch.waitForFunction(() => window.tv?.player?.channels.length > 0 && !window.tv.player.switching, null, { timeout: 30000 });
  const cdp = await touchContext.newCDPSession(touch);
  const swipe = async (x1, y1, x2, y2) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x1, y: y1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: (x1 + x2) / 2, y: (y1 + y2) / 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x2, y: y2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const touchChannel = () => touch.evaluate(() => window.tv.player.channelIndex);
  // Die Eingabe kommt auf einem ausgelasteten Testrechner verzögert an, deshalb wird auf das Ergebnis gewartet.
  const untilChannel = (index) => touch.waitForFunction((i) => window.tv.player.channelIndex === i, index, { timeout: 5000 }).catch(() => {});
  const startChannel = await touchChannel();
  await swipe(600, 200, 300, 210);
  await untilChannel((startChannel + 1) % 6);
  check('Wischen nach links schaltet einen Sender weiter', (await touchChannel()) === (startChannel + 1) % 6, `Sender ${startChannel + 1} -> ${(await touchChannel()) + 1}`);
  await swipe(300, 200, 600, 190);
  await untilChannel(startChannel);
  check('Wischen nach rechts schaltet zurück', (await touchChannel()) === startChannel);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 300, y: 200 }] });
  await touch.waitForFunction(() => document.getElementById('settings').classList.contains('shown'), null, { timeout: 5000 }).catch(() => {});
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.waitForFunction(() => !!document.querySelector('#settings iframe'), null, { timeout: 5000 }).catch(() => {});
  const menu = await touch.evaluate(() => ({ open: document.getElementById('settings').classList.contains('shown'), frame: !!document.querySelector('#settings iframe') }));
  check('langes Drücken öffnet die Einstellungen', menu.open && menu.frame && (await touchChannel()) === startChannel);
  if (shots) await touch.screenshot({ path: path.join(shots, '10-handy-einstellungen.png') });
  await touch.locator('#settings-close').tap();
  await touch.waitForFunction(() => !document.getElementById('settings').classList.contains('shown'), null, { timeout: 5000 }).catch(() => {});
  check('Einstellungen lassen sich wieder schließen', !(await touch.evaluate(() => document.getElementById('settings').classList.contains('shown'))));
  await touchContext.close();
  check('keine Skriptfehler', pageErrors.length === 0 && adminErrors.length === 0 && touchErrors.length === 0, [...pageErrors, ...adminErrors, ...touchErrors].join(' | '));
} catch (err) {
  failed++;
  console.error('Abbruch:', err);
} finally {
  await browser.close();
  await stopServer();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} Prüfung(en) fehlgeschlagen.` : '\nAlle Prüfungen bestanden.');
process.exit(failed ? 1 : 0);
