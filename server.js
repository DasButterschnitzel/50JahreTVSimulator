#!/usr/bin/env node
// TV-Simulator 1977 – Server.
// Liefert die Anzeige und die Filme aus, speichert Einstellungen und startet
// auf Wunsch (--kiosk) den Browser im Vollbild und überwacht ihn.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, isPlainObject } from './server/config.js';
import { scanMedia } from './server/media.js';
import { Kiosk } from './server/kiosk.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/webm',
  '.ogv': 'video/ogg',
};

function parseArgs(argv) {
  const args = { kiosk: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--kiosk') args.kiosk = true;
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--host') args.host = argv[++i];
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--media') args.media = argv[++i];
    else if (a === '--data') args.data = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function makeLogger(dataDir) {
  const file = path.join(dataDir, 'tv.log');
  const write = (level, message) => {
    const line = `${new Date().toISOString()} [${level}] ${message}`;
    (level === 'FEHLER' ? console.error : console.log)(line);
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(file, line + '\n');
    } catch {
      // Protokoll ist nicht lebenswichtig
    }
  };
  return {
    info: (m) => write('INFO', m),
    warn: (m) => write('WARNUNG', m),
    error: (m) => write('FEHLER', m),
  };
}

function isLoopback(req) {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Anfrage zu groß'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Ungültiges JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/** Liefert eine Datei aus; mit Teilabrufen (Range), damit Videos springen können. */
function serveFile(req, res, baseDir, relPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(relPath);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (decoded.includes('\0')) {
    res.writeHead(400).end();
    return;
  }
  const base = path.resolve(baseDir);
  const file = path.resolve(base, '.' + path.sep + decoded);
  if (file !== base && !file.startsWith(base + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Nicht gefunden');
      return;
    }
    const etag = `"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`;
    const headers = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
      ETag: etag,
      'Last-Modified': stat.mtime.toUTCString(),
    };
    let range = req.headers.range;
    // Wurde die Datei inzwischen ersetzt, darf kein Teilstück der alten Fassung ergänzt werden.
    const ifRange = req.headers['if-range'];
    if (range && ifRange && ifRange !== etag && ifRange !== headers['Last-Modified']) range = undefined;
    if (!range && req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers).end();
      return;
    }

    let start = 0;
    let end = stat.size - 1;
    let status = 200;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!match || (match[1] === '' && match[2] === '')) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
        return;
      }
      if (match[1] === '') {
        start = Math.max(0, stat.size - Number(match[2]));
      } else {
        start = Number(match[1]);
        if (match[2] !== '') end = Math.min(Number(match[2]), stat.size - 1);
      }
      if (start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
        return;
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || stat.size === 0) {
      res.end();
      return;
    }
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
}

export function createApp(options = {}) {
  const configFile = path.resolve(options.config || path.join(ROOT, 'config.json'));
  const dataDir = path.resolve(options.data || path.join(ROOT, 'data'));
  const publicDir = path.join(ROOT, 'public');
  const log = options.log || makeLogger(dataDir);
  const store = new Store({ configFile, dataDir, log });
  const startedAt = Date.now();

  const mediaDir = () => path.resolve(ROOT, options.media || store.baseSettings().mediaDir || 'media');
  const sseClients = new Set();
  let lastStatus = null;
  let lastStatusAt = 0;
  let kiosk = null;
  let onQuit = () => {};

  function broadcast(message, role) {
    const data = `data: ${JSON.stringify(message)}\n\n`;
    for (const client of sseClients) {
      if (role && client.role !== role) continue;
      client.res.write(data);
    }
  }

  const keepAlive = setInterval(() => {
    for (const client of sseClients) client.res.write(': ping\n\n');
  }, 15000);
  keepAlive.unref?.();

  function authorized(req, url) {
    if (isLoopback(req)) return true;
    const pin = String(store.baseSettings().server.pin || '');
    if (!pin) return true;
    const given = req.headers['x-tv-pin'] || url.searchParams.get('pin') || '';
    return String(given) === pin;
  }

  function configPayload() {
    const { channels, warnings } = scanMedia(mediaDir());
    return {
      version: VERSION,
      settings: store.settings(),
      state: { broadcast: store.state.broadcast, channel: store.state.channel, power: store.state.power },
      channels,
      warnings: [...store.warnings.map((w) => w.message), ...warnings],
      serverTime: Date.now(),
    };
  }

  async function handleApi(req, res, url) {
    const route = url.pathname;
    if (!authorized(req, url)) return sendJson(res, 401, { error: 'PIN erforderlich' });

    if (req.method === 'GET') {
      if (route === '/api/config') return sendJson(res, 200, configPayload());
      if (route === '/api/channels') return sendJson(res, 200, scanMedia(mediaDir()));
      if (route === '/api/status') {
        return sendJson(res, 200, {
          status: lastStatus,
          age: lastStatusAt ? Date.now() - lastStatusAt : null,
          server: { version: VERSION, uptime: Math.round((Date.now() - startedAt) / 1000), kiosk: !!kiosk, browserRestarts: kiosk?.restarts ?? 0 },
        });
      }
      if (route === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write('retry: 2000\n\n');
        const client = { res, role: url.searchParams.get('role') || 'admin' };
        sseClients.add(client);
        if (lastStatus && client.role === 'admin') {
          res.write(`data: ${JSON.stringify({ type: 'status', status: lastStatus })}\n\n`);
        }
        req.on('close', () => sseClients.delete(client));
        return;
      }
      return sendJson(res, 404, { error: 'Unbekannter Pfad' });
    }

    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Methode nicht erlaubt' });
    const body = await readBody(req);

    switch (route) {
      case '/api/command': {
        if (typeof body.cmd !== 'string') return sendJson(res, 400, { error: 'cmd fehlt' });
        broadcast({ type: 'command', cmd: body.cmd, args: isPlainObject(body.args) ? body.args : {} }, 'display');
        return sendJson(res, 200, { ok: true });
      }
      case '/api/settings': {
        if (body.reset) store.resetSettings(typeof body.reset === 'string' ? body.reset : undefined);
        if (isPlainObject(body.patch)) store.patchSettings(body.patch);
        const settings = store.settings();
        broadcast({ type: 'settings', settings });
        return sendJson(res, 200, { ok: true, settings });
      }
      case '/api/state': {
        store.patchState(body);
        return sendJson(res, 200, { ok: true });
      }
      case '/api/status': {
        lastStatus = body;
        lastStatusAt = Date.now();
        kiosk?.heartbeat();
        broadcast({ type: 'status', status: body }, 'admin');
        return sendJson(res, 200, { ok: true });
      }
      case '/api/log': {
        const level = body.level === 'error' ? 'error' : body.level === 'warn' ? 'warn' : 'info';
        log[level](`[Anzeige] ${String(body.message || '').slice(0, 2000)}`);
        return sendJson(res, 200, { ok: true });
      }
      case '/api/system': {
        if (body.action === 'reloadConfig') {
          store.loadConfig();
          const settings = store.settings();
          broadcast({ type: 'settings', settings });
          broadcast({ type: 'command', cmd: 'rescan', args: {} }, 'display');
          return sendJson(res, 200, { ok: true, warnings: store.warnings.map((w) => w.message) });
        }
        if (body.action === 'restartBrowser') {
          if (!kiosk) return sendJson(res, 409, { error: 'Der Server läuft nicht im Kioskmodus.' });
          kiosk.restart();
          return sendJson(res, 200, { ok: true });
        }
        if (body.action === 'quit') {
          sendJson(res, 200, { ok: true });
          setTimeout(() => onQuit(), 200);
          return;
        }
        return sendJson(res, 400, { error: 'Unbekannte Aktion' });
      }
      default:
        return sendJson(res, 404, { error: 'Unbekannter Pfad' });
    }
  }

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch((err) => {
        if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message });
        else res.destroy();
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    if (url.pathname.startsWith('/media/')) {
      serveFile(req, res, mediaDir(), url.pathname.slice('/media/'.length));
      return;
    }
    let rel = url.pathname.slice(1);
    if (rel === '') rel = 'index.html';
    else if (rel === 'admin' || rel === 'fernbedienung') rel = 'admin.html';
    serveFile(req, res, publicDir, rel);
  });

  return {
    server,
    store,
    log,
    mediaDir,
    setKiosk: (k) => (kiosk = k),
    setQuitHandler: (fn) => (onQuit = fn),
    close() {
      clearInterval(keepAlive);
      for (const client of sseClients) client.res.end();
      store.saveNow();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`TV-Simulator 1977

  node server.js            Server starten (Anzeige unter http://localhost:7777)
  node server.js --kiosk    Server starten und Browser im Vollbild öffnen und überwachen

Optionen:
  --port <nr>     Port (Standard 7777)
  --host <adr>    Adresse, z. B. 0.0.0.0 für Zugriff aus dem Netzwerk
  --config <pfad> andere Konfigurationsdatei
  --media <pfad>  anderer Medienordner
  --data <pfad>   anderer Ordner für Zustand und Protokoll`);
    return;
  }

  const app = createApp(args);
  const { log, store } = app;
  const serverSettings = store.baseSettings().server;
  const port = args.port || Number(process.env.TV_PORT) || serverSettings.port || 7777;
  const host = args.host || serverSettings.host || '127.0.0.1';
  const localUrl = `http://127.0.0.1:${port}/`;
  let kiosk = null;

  const shutdown = (code) => {
    log.info('Beende TV-Simulator.');
    kiosk?.stop();
    store.saveNow();
    setTimeout(() => process.exit(code), 300);
  };
  app.setQuitHandler(() => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGHUP', () => shutdown(0)); // Konsolenfenster wurde geschlossen
  process.on('uncaughtException', (err) => {
    log.error(`Unerwarteter Fehler: ${err.stack || err.message}`);
  });
  process.on('unhandledRejection', (err) => {
    log.error(`Unerwarteter Fehler: ${err?.stack || err}`);
  });

  app.server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log.error(`Port ${port} ist belegt. Läuft der TV-Simulator schon? Sonst in config.json einen anderen Port wählen.`);
    } else {
      log.error(`Serverfehler: ${err.message}`);
    }
    process.exit(2);
  });

  app.server.listen(port, host, () => {
    log.info(`TV-Simulator ${VERSION} läuft.`);
    log.info(`  Anzeige:        ${localUrl}`);
    log.info(`  Fernbedienung:  ${localUrl}admin`);
    log.info(`  Filme:          ${app.mediaDir()}`);
    if (host !== '127.0.0.1' && host !== 'localhost') {
      log.info(`  Im Netzwerk erreichbar (Adresse dieses Rechners, Port ${port})${serverSettings.pin ? ', PIN aktiv' : ' – ohne PIN!'}`);
    }
    for (const warning of store.warnings) log.warn(warning.message);
    if (args.kiosk) {
      kiosk = new Kiosk({
        url: localUrl,
        profileDir: path.join(path.resolve(args.data || path.join(ROOT, 'data')), 'browser-profil'),
        settings: store.baseSettings().kiosk,
        log,
      });
      app.setKiosk(kiosk);
      kiosk.start();
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
