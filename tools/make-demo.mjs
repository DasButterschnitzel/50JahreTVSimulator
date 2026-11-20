#!/usr/bin/env node
// Erzeugt mit ffmpeg einige kurze Demo-Filme, damit sich der TV-Simulator
// ohne eigenes Material ausprobieren lässt.
//
//   node tools/make-demo.mjs            -> MP4 (H.264), läuft in Chrome, Edge und Chromium
//   node tools/make-demo.mjs --webm     -> WebM (VP8), falls kein H.264-Encoder vorhanden ist
//   node tools/make-demo.mjs --out <ordner> --seconds 20

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);

const outDir = path.resolve(option('--out', path.join(ROOT, 'media')));
const seconds = Number(option('--seconds', 30));
const webm = flag('--webm');
const ext = webm ? 'webm' : 'mp4';

if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).error) {
  console.error('ffmpeg wurde nicht gefunden. Bitte ffmpeg installieren (https://ffmpeg.org).');
  process.exit(1);
}

const codec = webm
  ? ['-c:v', 'libvpx', '-b:v', '1200k', '-g', '25', '-c:a', 'libvorbis', '-b:a', '96k']
  : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-g', '25', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'];

function make(folder, name, videoSource, audioSource, duration) {
  const dir = path.join(outDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.${ext}`);
  const result = spawnSync(
    'ffmpeg',
    ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', videoSource, '-f', 'lavfi', '-i', audioSource, '-t', String(duration), '-r', '25', ...codec, file],
    { stdio: 'inherit' }
  );
  if (result.status !== 0) {
    console.error(`Fehler beim Erzeugen von ${file}`);
    process.exit(1);
  }
  console.log(`  ${path.relative(ROOT, file)}`);
}

console.log('Erzeuge Demo-Filme …');
make('01-demo-farbe', '01-testmuster', 'testsrc2=size=768x576:rate=25', 'sine=frequency=440:sample_rate=48000', seconds);
make('01-demo-farbe', '02-farbbalken', 'pal75bars=size=768x576:rate=25', 'sine=frequency=660:sample_rate=48000', Math.max(5, seconds / 2));
make('02-demo-schwarzweiss', '01-muster', 'mandelbrot=size=768x576:rate=25', 'sine=frequency=220:sample_rate=48000', seconds * 1.5);
fs.writeFileSync(
  path.join(outDir, '02-demo-schwarzweiss', 'channel.json'),
  JSON.stringify({ name: 'Demo Schwarz-Weiß', blackWhite: true }, null, 2) + '\n'
);
make('03-demo-breitbild', '01-breitbild', 'testsrc=size=1280x720:rate=25', 'sine=frequency=330:sample_rate=48000', seconds);
fs.mkdirSync(path.join(outDir, '04-testbild'), { recursive: true });
fs.writeFileSync(path.join(outDir, '04-testbild', 'channel.json'), JSON.stringify({ name: 'Testbild', type: 'testcard' }, null, 2) + '\n');
fs.mkdirSync(path.join(outDir, '05-rauschen'), { recursive: true });
fs.writeFileSync(path.join(outDir, '05-rauschen', 'channel.json'), JSON.stringify({ name: 'Kein Sender', type: 'noise' }, null, 2) + '\n');
console.log(`Fertig. Die Demo-Sender liegen in ${outDir}`);
