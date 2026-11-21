// Hauptprogramm der Anzeige.
import { BroadcastClock } from './broadcast.js';
import { Renderer } from './renderer.js';
import { Director } from './director.js';
import { AudioEngine } from './audio.js';
import { Player } from './player.js';
import { Input } from './input.js';

const $ = (id) => document.getElementById(id);
const startedAt = Date.now();
const DURATION_CACHE_KEY = 'tv77.durations';

// ---------------------------------------------------------------- Server

async function request(path, body) {
  const options = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(path, { cache: 'no-store', ...options });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

function post(path, body) {
  return request(path, body).catch(() => null);
}

let logBudget = 30;
setInterval(() => (logBudget = 30), 60000);
const log = {
  info: (m) => console.log(m),
  warn: (m) => report('warn', m),
  error: (m) => report('error', m),
};
function report(level, message) {
  console[level](message);
  errors.push({ t: Date.now(), level, message: String(message) });
  if (errors.length > 20) errors.shift();
  if (logBudget-- > 0) post('/api/log', { level, message: String(message) });
}
const errors = [];

window.addEventListener('error', (e) => log.error(`Skriptfehler: ${e.message} (${e.filename}:${e.lineno})`));
window.addEventListener('unhandledrejection', (e) => log.error(`Skriptfehler: ${e.reason?.message || e.reason}`));

// ---------------------------------------------------------------- Filmlängen

function readDurationCache() {
  try {
    return JSON.parse(localStorage.getItem(DURATION_CACHE_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function writeDurationCache(cache) {
  try {
    localStorage.setItem(DURATION_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // ohne Zwischenspeicher wird beim nächsten Start neu gemessen
  }
}

const fileKey = (file) => `${file.url}|${file.size}|${file.mtime}`;

function measureDuration(url) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      v.removeAttribute('src');
      v.load();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 20000);
    const check = () => {
      if (Number.isFinite(v.duration) && v.duration > 0) finish(v.duration);
    };
    v.addEventListener('loadedmetadata', () => {
      check();
      // Dateien ohne Längenangabe: ans Ende springen, dann kennt der Browser die Dauer
      if (!done) v.currentTime = 1e7;
    });
    v.addEventListener('durationchange', check);
    v.addEventListener('error', () => finish(null));
    v.src = url;
  });
}

/** Ermittelt die Länge aller Filme (für die Sendeuhr); bekannte Werte kommen aus dem Zwischenspeicher. */
async function measureChannels(channels) {
  const cache = readDurationCache();
  const fresh = {};
  const queue = [];
  for (const ch of channels) {
    for (const file of ch.files || []) {
      const key = fileKey(file);
      if (cache[key] > 0) {
        file.duration = cache[key];
        fresh[key] = cache[key];
      } else {
        queue.push(file);
      }
    }
  }
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) {
      const file = queue.shift();
      const duration = await measureDuration(file.url);
      if (duration) {
        file.duration = duration;
        fresh[fileKey(file)] = duration;
      } else {
        log.warn(`Film lässt sich nicht lesen und wird übersprungen: ${decodeURIComponent(file.url)}`);
      }
    }
  });
  await Promise.all(workers);
  writeDurationCache(fresh);
  return channels;
}

const channelSignature = (channels) => JSON.stringify(channels.map((c) => [c.id, c.name, c.type, c.options, (c.files || []).map((f) => [f.url, f.size, f.mtime])]));

// ---------------------------------------------------------------- Start

const app = {
  settings: null,
  clock: null,
  renderer: null,
  director: null,
  audio: null,
  player: null,
  input: null,
  version: '',
  signature: '',
  warnings: [],
  plain: false,
  fps: 0,
};

async function loadConfig() {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request('/api/config');
    } catch (err) {
      console.warn('Server nicht erreichbar, neuer Versuch …', err);
      await new Promise((r) => setTimeout(r, Math.min(5000, 500 + attempt * 500)));
    }
  }
}

let saveTimer = 0;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    post('/api/state', { broadcast: app.clock.toJSON(), channel: app.player.channel?.id, power: app.player.powered });
  }, 300);
}

function reloadPage(reason) {
  log.warn(`Anzeige wird neu geladen: ${reason}`);
  setTimeout(() => location.reload(), 500);
}

/** Bildausgabe: normalerweise die Röhrensimulation, im Notbetrieb das Video direkt. */
function makeView(renderer) {
  const plainBox = $('plain');
  return {
    get source() {
      return renderer.source;
    },
    setSource(source, options) {
      renderer.setSource(source, options);
      if (!app.plain) return;
      for (const child of plainBox.children) child.classList.remove('shown');
      if (source?.el) {
        if (source.el.parentNode !== plainBox) plainBox.appendChild(source.el);
        source.el.classList.add('shown');
      }
    },
    markSourceDirty() {
      renderer.markSourceDirty();
    },
  };
}

async function boot() {
  const config = await loadConfig();
  app.settings = config.settings;
  app.version = config.version;
  app.platform = config.platform || 'desktop';
  app.warnings = config.warnings || [];
  app.clock = new BroadcastClock(config.state.broadcast);
  app.director = new Director(app.settings);
  app.audio = new AudioEngine(app.settings, log);
  app.audio.init();

  app.renderer = new Renderer($('screen'), app.settings, log);
  app.renderer.onFatal = reloadPage;
  if (!app.renderer.init()) {
    app.plain = true;
    document.body.classList.add('plain');
    log.error('Keine Grafikbeschleunigung (WebGL) verfügbar – Notbetrieb ohne Röhreneffekte.');
  }

  app.player = new Player({
    settings: app.settings,
    clock: app.clock,
    view: makeView(app.renderer),
    director: app.director,
    audio: app.audio,
    log,
    onChange: saveState,
    onFatal: reloadPage,
    onDuration: (file) => {
      const cache = readDurationCache();
      cache[fileKey(file)] = file.duration;
      writeDurationCache(cache);
    },
  });

  app.input = new Input(app.settings, (action) => handleAction(action));
  for (const ev of ['keydown', 'pointerdown']) {
    window.addEventListener(ev, unlockAudio, true);
  }

  window.addEventListener('resize', () => app.renderer.resize());
  document.addEventListener('visibilitychange', () => {
    const hidden = document.visibilityState === 'hidden';
    app.player.setSuspended(hidden);
    app.audio.setSuspended(hidden);
  });
  $('settings-close').addEventListener('click', () => toggleSettings(false));
  window.addEventListener('message', (e) => {
    if (e.origin === location.origin && e.data === 'tv-close-settings') toggleSettings(false);
  });

  // Sender einlesen und einschalten
  const channels = await measureChannels(config.channels);
  app.signature = channelSignature(config.channels);
  let startId = config.state.channel;
  const start = app.settings.startChannel;
  if (start !== 'last' && Number.isFinite(Number(start))) startId = channels[Math.max(0, Number(start) - 1)]?.id ?? startId;
  app.player.setChannels(channels, startId);

  const power = config.state.power !== false;
  app.player.powered = power;
  app.audio.setPower(power);
  if (power) {
    app.director.setPowerImmediately(false);
    app.director.powerOn();
    app.player.tune(app.player.channelIndex, { animate: false });
  } else {
    app.director.setPowerImmediately(false);
  }

  connectEvents();
  requestAnimationFrame(frame);
  setInterval(() => app.player.tick(), 250);
  setInterval(sendStatus, 2000);
  setInterval(updateInfo, 500);
  setInterval(checkSchedule, 20000);
  setInterval(() => rescan(false), 120000);
  keepAwake();
  if (app.platform === 'android') {
    const noFilms = config.channels.every((c) => c.type !== 'video');
    showTip(noFilms ? 'Noch keine Filme: lange drücken und „Filmordner wählen“ – Wischen wechselt den Sender' : 'Wischen: Sender wechseln · lange drücken: Einstellungen', noFilms ? 20000 : 7000);
  }
  sendStatus();
  window.tv = app; // für Fehlersuche in der Browserkonsole
}

// ---------------------------------------------------------------- Bildschleife

let lastFrame = performance.now();
let lastRender = 0;
let fpsFrames = 0;
let fpsSince = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  const maxFps = Number(app.settings.effects.maxFps) || 0;
  if (maxFps > 0 && now - lastRender < 1000 / maxFps - 2) return;
  lastRender = now;
  const dt = Math.max(0, (now - lastFrame) / 1000);
  lastFrame = now;
  const dyn = app.director.update(dt);
  app.renderer.render(now / 1000, dyn, dt);
  fpsFrames++;
  if (now - fpsSince >= 1000) {
    app.fps = Math.round((fpsFrames * 1000) / (now - fpsSince));
    fpsFrames = 0;
    fpsSince = now;
  }
}

// ---------------------------------------------------------------- Bedienung

function patchSettings(patch) {
  for (const [section, values] of Object.entries(patch)) {
    app.settings[section] = { ...app.settings[section], ...values };
  }
  applySettings(app.settings);
  post('/api/settings', { patch });
}

function applySettings(settings) {
  app.settings = settings;
  app.renderer.applySettings(settings);
  app.director.applySettings(settings);
  app.audio.applySettings(settings);
  app.player.applySettings(settings);
  app.input.applySettings(settings);
}

function handleAction(action) {
  const direct = /^channel(\d+)$/.exec(action);
  if (direct) return command('tune', { index: Number(direct[1]) - 1 });
  const seek = Number(app.settings.input?.seekStep) || 30;
  switch (action) {
    case 'seekForward':
      return command('seek', { seconds: seek });
    case 'seekBack':
      return command('seek', { seconds: -seek });
    case 'volumeUp':
      return command('volume', { delta: 0.05 });
    case 'volumeDown':
      return command('volume', { delta: -0.05 });
    default:
      return command(action);
  }
}

function command(cmd, args = {}) {
  const p = app.player;
  switch (cmd) {
    case 'channelUp':
      return p.step(1);
    case 'channelDown':
      return p.step(-1);
    case 'tune': {
      let index = Number.isFinite(args.index) ? args.index : p.channels.findIndex((c) => c.id === args.id);
      if (index < 0 || index >= p.channels.length) return;
      if (index === p.channelIndex && !p.fault && !args.force) return;
      return p.tune(index);
    }
    case 'pause':
      return p.setPaused(typeof args.paused === 'boolean' ? args.paused : !app.clock.paused);
    case 'restartFilm':
      return p.restartFilm();
    case 'restartChannel':
      return p.restartChannel();
    case 'restartAll':
      return p.restartAll();
    case 'nextFilm':
      return p.skipFilm(1);
    case 'prevFilm':
      return p.skipFilm(-1);
    case 'seek':
      return p.seekBy(Number(args.seconds) || 0);
    case 'volume': {
      const current = Number(app.settings.audio.volume) || 0;
      const value = Number.isFinite(args.value) ? args.value : current + (Number(args.delta) || 0);
      return patchSettings({ audio: { volume: Math.round(Math.min(1, Math.max(0, value)) * 100) / 100, muted: false } });
    }
    case 'mute':
      return patchSettings({ audio: { muted: typeof args.muted === 'boolean' ? args.muted : !app.settings.audio.muted } });
    case 'power':
      return p.setPower(typeof args.on === 'boolean' ? args.on : !p.powered);
    case 'effects':
      return patchSettings({ effects: { enabled: app.settings.effects.enabled === false } });
    case 'glitch':
      return app.director.glitch();
    case 'info':
      $('info').classList.toggle('shown');
      return updateInfo();
    case 'settings':
      return toggleSettings();
    case 'rescan':
      return rescan(true);
    case 'reload':
      return location.reload();
    case 'quit':
      return post('/api/system', { action: 'quit' });
    default:
      console.warn('Unbekannter Befehl', cmd);
  }
}

function unlockAudio() {
  app.audio.resume().then(() => {
    app.player.unlockAudio();
    updateHint();
  });
}

let tip = { text: '', until: 0 };

/** Kurzer Bedienhinweis am unteren Bildrand. */
function showTip(text, ms) {
  tip = { text, until: Date.now() + ms };
  updateHint();
  setTimeout(updateHint, ms + 50);
}

function updateHint() {
  const hint = $('hint');
  const blocked = (app.player.needsGesture || (app.audio.ok && !app.audio.running)) && app.player.powered && document.visibilityState !== 'hidden';
  const text = blocked ? 'Ton ist vom Browser gesperrt – bitte eine Taste drücken, klicken oder tippen.' : Date.now() < tip.until ? tip.text : '';
  hint.textContent = text;
  hint.classList.toggle('shown', !!text);
}

function toggleSettings(show) {
  const box = $('settings');
  const open = typeof show === 'boolean' ? show : !box.classList.contains('shown');
  box.classList.toggle('shown', open);
  let frameEl = box.querySelector('iframe');
  if (open) tip.until = 0;
  if (open && !frameEl) {
    frameEl = document.createElement('iframe');
    frameEl.src = 'admin.html?embedded=1';
    box.appendChild(frameEl);
  } else if (!open && frameEl) {
    frameEl.remove();
    window.focus();
  }
  document.documentElement.style.cursor = open ? 'auto' : '';
  document.body.style.cursor = open ? 'auto' : '';
}

// ---------------------------------------------------------------- Server-Nachrichten

function connectEvents() {
  const source = new EventSource('/api/events?role=display');
  source.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === 'command') command(msg.cmd, msg.args || {});
    else if (msg.type === 'settings') applySettings(msg.settings);
  };
}

async function rescan(force) {
  if (rescan.busy) return;
  rescan.busy = true;
  try {
    const data = await request('/api/channels');
    const signature = channelSignature(data.channels);
    app.warnings = data.warnings || [];
    if (!force && signature === app.signature) return;
    const previous = app.player.channel;
    const before = previous ? channelSignature([previous]) : '';
    const channels = await measureChannels(data.channels);
    app.signature = signature;
    app.player.setChannels(channels);
    const current = app.player.channel;
    const changed = !current || !previous || current.id !== previous.id || channelSignature([current]) !== before;
    if (changed || app.player.fault) app.player.tune(app.player.channelIndex);
  } catch (err) {
    console.warn('Sender konnten nicht neu eingelesen werden', err);
  } finally {
    rescan.busy = false;
  }
}

// ---------------------------------------------------------------- Zeitsteuerung, Status

const firedToday = {};
function checkSchedule() {
  const s = app.settings.schedule || {};
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const stamp = `${now.toDateString()} ${hhmm}`;
  const due = (name) => {
    if (!s[name] || String(s[name]).trim() !== hhmm || firedToday[name] === stamp) return false;
    firedToday[name] = stamp;
    return true;
  };
  if (due('powerOn')) command('power', { on: true });
  if (due('powerOff')) command('power', { on: false });
  if (due('restartAll')) command('restartAll');
  if (due('reload') && Date.now() - startedAt > 10 * 60 * 1000) reloadPage('tägliches Neuladen');
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '--:--';
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
}

function currentStatus() {
  return {
    ...app.player.status(),
    version: app.version,
    time: Date.now(),
    uptime: Math.round((Date.now() - startedAt) / 1000),
    fps: app.fps,
    plain: app.plain,
    volume: app.settings.audio.volume,
    muted: !!app.settings.audio.muted,
    audioBlocked: app.player.needsGesture || (app.audio.ok && !app.audio.running),
    warnings: app.warnings,
    errors: errors.slice(-5),
  };
}

function sendStatus() {
  updateHint();
  post('/api/status', currentStatus());
}

function updateInfo() {
  const box = $('info');
  if (!box.classList.contains('shown')) return;
  const st = currentStatus();
  const ch = st.channels[st.channelIndex];
  const lines = [
    `TV-Simulator ${st.version}   ${new Date().toLocaleTimeString('de-DE')}   ${st.fps} Bilder/s${st.plain ? '   NOTBETRIEB' : ''}`,
    `Sender ${st.channelIndex + 1}/${st.channels.length}: ${ch ? ch.name : '–'}${st.paused ? '   [PAUSE]' : ''}${st.power ? '' : '   [AUS]'}${st.fault ? '   [STÖRUNG]' : ''}`,
  ];
  if (st.item) {
    lines.push(`Film ${st.item.index + 1}/${st.item.count}: ${st.item.name}`);
    lines.push(`       ${formatTime(st.item.offset)} / ${formatTime(st.item.duration)}   (Programm ${formatTime(st.item.position)} / ${formatTime(st.item.total)})`);
  }
  lines.push(`Lautstärke ${Math.round(st.volume * 100)} %${st.muted ? ' (stumm)' : ''}`);
  lines.push('');
  lines.push('↑/↓ Sender   1–9 Sender direkt   Leertaste Pause   R Film neu');
  lines.push('Umschalt+R Sender neu   Pos1 alle neu   N/B Film vor/zurück');
  lines.push(', . springen   +/− Lautstärke   M stumm   P ein/aus   F2 Einstellungen');
  for (const w of st.warnings) lines.push(`! ${w}`);
  for (const e of st.errors) lines.push(`! ${e.message}`);
  box.textContent = lines.join('\n');
}

async function keepAwake() {
  if (!('wakeLock' in navigator)) return;
  const acquire = async () => {
    try {
      await navigator.wakeLock.request('screen');
    } catch {
      // nicht verfügbar – Energiesparen muss im Betriebssystem abgeschaltet werden
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') acquire();
  });
  acquire();
}

boot().catch((err) => {
  log.error(`Start fehlgeschlagen: ${err.stack || err.message}`);
  setTimeout(() => location.reload(), 10000);
});
