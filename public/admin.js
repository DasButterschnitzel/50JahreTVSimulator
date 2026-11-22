// Fernbedienung: steuert die Anzeige über den Server.
import { parseYouTubeUrl } from './js/youtube.js';
import { parseWebUrl, resolveWebChannel } from './js/online.js';
import { PRESETS_1977 } from './js/presets1977.js';

const $ = (id) => document.getElementById(id);
const PIN_KEY = 'tv77.pin';
let pin = '';
try {
  pin = localStorage.getItem(PIN_KEY) || '';
} catch {
  // ohne Speicher wird der PIN bei jedem Aufruf abgefragt
}

let settings = null;
let status = null;
let statusAt = 0;
let serverInfo = null;

// ---------------------------------------------------------------- Server

async function api(path, body) {
  const headers = { 'X-TV-Pin': pin };
  const options = body === undefined ? { headers } : { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(path, { cache: 'no-store', ...options });
  if (res.status === 401) {
    const entered = window.prompt('PIN für die Fernbedienung:');
    if (entered === null) throw new Error('PIN erforderlich');
    pin = entered.trim();
    try {
      localStorage.setItem(PIN_KEY, pin);
    } catch {
      // siehe oben
    }
    return api(path, body);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
  return data;
}

function send(cmd, args) {
  return api('/api/command', { cmd, args }).catch((err) => alert(err.message));
}

function getPath(obj, path) {
  return path.split('.').reduce((o, key) => (o == null ? undefined : o[key]), obj);
}

function makePatch(path, value) {
  const keys = path.split('.');
  const patch = {};
  let node = patch;
  keys.forEach((key, i) => {
    node[key] = i === keys.length - 1 ? value : {};
    node = node[key];
  });
  return patch;
}

const pending = new Map();
function setSetting(path, value) {
  clearTimeout(pending.get(path));
  pending.set(
    path,
    setTimeout(() => {
      pending.delete(path);
      api('/api/settings', { patch: makePatch(path, value) }).catch((err) => console.warn(err));
    }, 80)
  );
}

// ---------------------------------------------------------------- Regler

const pct = (v) => `${Math.round(v * 100)} %`;
const num = (digits) => (v) => Number(v).toFixed(digits);

const GROUPS = {
  'controls-device': [{ items: [{ path: 'audio.volume', label: 'Lautstärke', min: 0, max: 1, step: 0.01, format: pct }] }],
  'controls-picture': [
    {
      items: [{ path: 'effects.enabled', label: 'Röhrensimulation eingeschaltet', type: 'check' }],
    },
    {
      title: 'Bildröhre',
      items: [
        { path: 'effects.curvature', label: 'Wölbung', min: 0, max: 1.5, step: 0.01, format: num(2) },
        { path: 'effects.cornerRadius', label: 'Runde Ecken', min: 0, max: 0.4, step: 0.005, format: num(3) },
        { path: 'effects.edgeShadow', label: 'Schatten am Rand', min: 0, max: 1, step: 0.01, format: pct },
        { path: 'effects.scanlines', label: 'Zeilenstruktur', min: 0, max: 1, step: 0.01, format: pct },
        { path: 'effects.scanlineCount', label: 'Anzahl Zeilen', min: 120, max: 576, step: 1, format: num(0), hint: '288 = ein PAL-Halbbild. Auf kleinen Monitoren wird die Zeilenstruktur automatisch abgeschwächt.' },
        { path: 'effects.interlace', label: 'Zeilensprung-Flimmern', type: 'check' },
        {
          path: 'effects.maskType',
          label: 'Lochmaske',
          type: 'select',
          options: [
            ['slot', 'Schlitzmaske'],
            ['dots', 'Punktmaske (Delta)'],
            ['aperture', 'Streifenmaske'],
            ['none', 'keine'],
          ],
        },
        { path: 'effects.mask', label: 'Stärke der Maske', min: 0, max: 0.9, step: 0.01, format: pct },
        { path: 'effects.maskScale', label: 'Größe der Maske', min: 1, max: 4, step: 1, format: num(0) },
        { path: 'effects.halation', label: 'Überstrahlen', min: 0, max: 1.5, step: 0.01, format: num(2) },
        { path: 'effects.persistence', label: 'Nachleuchten', min: 0, max: 0.9, step: 0.01, format: pct },
        { path: 'effects.flicker', label: 'Flimmern', min: 0, max: 0.1, step: 0.001, format: num(3) },
      ],
    },
    {
      title: 'Empfang',
      items: [
        { path: 'effects.noise', label: 'Bildrauschen', min: 0, max: 0.5, step: 0.005, format: num(3) },
        { path: 'effects.colorNoise', label: 'Farbrauschen', min: 0, max: 0.3, step: 0.005, format: num(3) },
        { path: 'effects.ghost', label: 'Geisterbild', min: 0, max: 0.6, step: 0.01, format: num(2) },
        { path: 'effects.jitter', label: 'Zeilenzittern', min: 0, max: 6, step: 0.05, format: num(2) },
        { path: 'effects.wobble', label: 'Bildwabern', min: 0, max: 4, step: 0.05, format: num(2) },
        { path: 'effects.hum', label: 'Brummstreifen', min: 0, max: 0.3, step: 0.005, format: num(3) },
        { path: 'effects.softness', label: 'Unschärfe', min: 0, max: 2, step: 0.01, format: num(2) },
        { path: 'effects.chroma', label: 'Farbunschärfe', min: 0, max: 3, step: 0.01, format: num(2) },
        { path: 'effects.glitches', label: 'Zufällige Bildstörungen pro Stunde', min: 0, max: 60, step: 1, format: num(0) },
      ],
    },
    {
      title: 'Farbe und Helligkeit',
      items: [
        { path: 'effects.blackWhite', label: 'Schwarz-Weiß-Gerät', type: 'check' },
        { path: 'effects.brightness', label: 'Helligkeit', min: 0.4, max: 1.6, step: 0.01, format: num(2) },
        { path: 'effects.contrast', label: 'Kontrast', min: 0.5, max: 1.6, step: 0.01, format: num(2) },
        { path: 'effects.saturation', label: 'Farbsättigung', min: 0, max: 2, step: 0.01, format: num(2) },
        { path: 'effects.warmth', label: 'Warmer Farbstich', min: 0, max: 1, step: 0.01, format: pct },
      ],
    },
    {
      title: 'Glas',
      items: [
        { path: 'effects.vignette', label: 'Randabdunklung', min: 0, max: 1, step: 0.01, format: pct },
        { path: 'effects.reflection', label: 'Spiegelung', min: 0, max: 2, step: 0.01, format: num(2) },
        { path: 'effects.ambient', label: 'Aufhellung durch Raumlicht', min: 0, max: 2, step: 0.01, format: num(2) },
      ],
    },
    {
      title: 'Umschalten und Leistung',
      items: [
        { path: 'effects.switchStatic', label: 'Rauschen beim Umschalten (Sekunden)', min: 0, max: 2, step: 0.05, format: num(2) },
        { path: 'effects.switchRoll', label: 'Durchlaufen des Bildes', min: 0, max: 2, step: 0.05, format: num(2) },
        { path: 'effects.powerAnimation', label: 'Ein-/Ausschaltanimation', type: 'check' },
        { path: 'effects.renderScale', label: 'Auflösung der Darstellung', min: 0.4, max: 1, step: 0.05, format: pct, hint: 'Kleiner = weniger Last für schwache Rechner (Raspberry Pi).' },
        { path: 'effects.maxFps', label: 'Bilder pro Sekunde begrenzen (0 = aus)', min: 0, max: 60, step: 5, format: num(0) },
        { path: 'youtube.warp', label: 'Wölbung auch für das YouTube-Bild', type: 'check', hint: 'Ausschalten, falls YouTube-Sender ruckeln.' },
      ],
    },
  ],
  'controls-screen': [
    {
      items: [
        { path: 'screen.scale', label: 'Größe', min: 0.3, max: 1.6, step: 0.002, format: pct },
        { path: 'screen.x', label: 'Verschieben waagerecht', min: -0.5, max: 0.5, step: 0.001, format: num(3) },
        { path: 'screen.y', label: 'Verschieben senkrecht', min: -0.5, max: 0.5, step: 0.001, format: num(3) },
        { path: 'screen.stretchX', label: 'Breite dehnen', min: 0.7, max: 1.4, step: 0.002, format: pct },
        { path: 'screen.rotate', label: 'Drehung (Grad)', min: -180, max: 180, step: 0.5, format: num(1) },
        { path: 'screen.overscan', label: 'Bild vergrößern (Overscan)', min: 0, max: 0.2, step: 0.005, format: pct },
        {
          path: 'screen.aspect',
          label: 'Format der Bildröhre',
          type: 'select',
          numeric: true,
          options: [
            [1.3333, '4:3'],
            [1.25, '5:4'],
            [1.7778, '16:9'],
          ],
        },
        {
          path: 'video.fit',
          label: 'Breitbild-Filme',
          type: 'select',
          options: [
            ['fill', 'formatfüllend (Ränder abschneiden)'],
            ['fit', 'ganz zeigen (schwarze Balken)'],
            ['stretch', 'verzerren'],
          ],
        },
      ],
    },
  ],
  'controls-audio': [
    {
      items: [
        { path: 'audio.vintage', label: 'Klang eines alten Fernsehlautsprechers', type: 'check' },
        { path: 'audio.staticVolume', label: 'Rauschen beim Umschalten', min: 0, max: 1, step: 0.01, format: pct },
        { path: 'audio.hum', label: 'Netzbrummen', min: 0, max: 1, step: 0.01, format: pct },
        { path: 'audio.whistle', label: 'Zeilenpfeifen (15,6 kHz)', min: 0, max: 1, step: 0.01, format: pct },
        { path: 'audio.testTone', label: 'Ton auf dem Testbild', min: 0, max: 1, step: 0.01, format: pct },
      ],
    },
  ],
  'controls-schedule': [
    {
      items: [
        { path: 'schedule.powerOn', label: 'Täglich einschalten um', type: 'text' },
        { path: 'schedule.powerOff', label: 'Täglich ausschalten um', type: 'text' },
        { path: 'schedule.restartAll', label: 'Alle Sender von vorn um', type: 'text' },
        { path: 'schedule.reload', label: 'Anzeige neu laden um', type: 'text', hint: 'Vorsorge für den Dauerbetrieb; das Programm läuft danach nahtlos weiter.' },
      ],
    },
  ],
};

const PRESETS = [
  { name: 'Farbfernseher 1977', patch: {} },
  { name: 'Schwarz-Weiß', patch: { blackWhite: true, mask: 0, chroma: 0, colorNoise: 0, warmth: 0.08, scanlines: 0.55, halation: 0.4 } },
  { name: 'Schlechter Empfang', patch: { noise: 0.22, colorNoise: 0.12, ghost: 0.28, jitter: 1.6, wobble: 1.2, hum: 0.08, glitches: 12 } },
  { name: 'Dezent', patch: { curvature: 0.3, scanlines: 0.25, mask: 0.12, noise: 0.03, colorNoise: 0.01, ghost: 0, jitter: 0.2, wobble: 0.1, hum: 0, reflection: 0.2 } },
  { name: 'Ohne Effekte', patch: { enabled: false } },
];

const controls = [];

function buildControls() {
  for (const [containerId, groups] of Object.entries(GROUPS)) {
    const container = $(containerId);
    for (const group of groups) {
      let parent = container;
      if (group.title) {
        parent = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = group.title;
        parent.appendChild(summary);
        container.appendChild(parent);
      }
      for (const item of group.items) parent.appendChild(buildControl(item));
    }
  }
  const presetBox = $('presets');
  for (const preset of PRESETS) {
    const button = document.createElement('button');
    button.textContent = preset.name;
    button.addEventListener('click', () => {
      api('/api/settings', { reset: 'effects', patch: { effects: preset.patch } }).catch((err) => alert(err.message));
    });
    presetBox.appendChild(button);
  }
}

function buildControl(item) {
  const type = item.type || 'range';
  const wrap = document.createElement('div');
  wrap.className = 'control' + (type === 'range' ? '' : ' inline');
  const id = `c-${item.path.replace(/\./g, '-')}`;
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = item.label;
  wrap.appendChild(label);

  let input;
  let valueEl = null;
  if (type === 'select') {
    input = document.createElement('select');
    for (const [value, text] of item.options) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = text;
      input.appendChild(option);
    }
    input.addEventListener('change', () => setSetting(item.path, item.numeric ? Number(input.value) : input.value));
  } else if (type === 'check') {
    input = document.createElement('input');
    input.type = 'checkbox';
    input.addEventListener('change', () => setSetting(item.path, input.checked));
  } else if (type === 'text') {
    input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'aus';
    input.inputMode = 'numeric';
    input.maxLength = 5;
    input.addEventListener('change', () => {
      const value = input.value.trim();
      const m = /^(\d{1,2})[:.](\d{2})$/.exec(value);
      if (value === '') setSetting(item.path, '');
      else if (m && Number(m[1]) < 24 && Number(m[2]) < 60) {
        input.value = `${m[1].padStart(2, '0')}:${m[2]}`;
        setSetting(item.path, input.value);
      } else {
        input.value = getPath(settings, item.path) || '';
      }
    });
  } else {
    valueEl = document.createElement('span');
    valueEl.className = 'value';
    wrap.appendChild(valueEl);
    input = document.createElement('input');
    input.type = 'range';
    input.min = item.min;
    input.max = item.max;
    input.step = item.step;
    input.addEventListener('input', () => {
      const value = Number(input.value);
      valueEl.textContent = item.format(value);
      setSetting(item.path, value);
    });
  }
  input.id = id;
  wrap.appendChild(input);
  if (item.hint) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = item.hint;
    wrap.appendChild(hint);
  }
  controls.push({ item, input, valueEl, type });
  return wrap;
}

// ---------------------------------------------------------------- Internet-Sender (YouTube, archive.org)

const KINDS = { youtube: 'youtube', web: 'web' };

function onlineChannels(kind) {
  const list = settings?.[kind]?.channels;
  return Array.isArray(list) ? list.filter((c) => c && Array.isArray(c.urls)) : [];
}

function saveOnlineChannels(kind, channels) {
  return api('/api/settings', { patch: { [kind]: { channels } } }).catch((err) => alert(err.message));
}

function describeUrls(kind, urls) {
  if (kind === KINDS.youtube) {
    const lists = urls.filter((u) => parseYouTubeUrl(u)?.playlist).length;
    const videos = urls.length - lists;
    return ['YouTube', videos ? `${videos} Video${videos === 1 ? '' : 's'}` : '', lists ? `${lists} Playlist${lists === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
  }
  const items = urls.filter((u) => parseWebUrl(u)?.archive).length;
  const files = urls.length - items;
  return [items ? `archive.org · ${items} Eintr${items === 1 ? 'ag' : 'äge'}` : '', files ? `${files} Datei${files === 1 ? '' : 'en'}` : ''].filter(Boolean).join(' · ');
}

function showOnlineChannels() {
  const box = $('yt-list');
  box.replaceChildren();
  for (const kind of [KINDS.web, KINDS.youtube]) {
    for (const channel of onlineChannels(kind)) {
      const row = document.createElement('div');
      row.className = 'entry';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = channel.name || 'Internet-Sender';
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = describeUrls(kind, channel.urls);
      const remove = document.createElement('button');
      remove.textContent = 'Entfernen';
      remove.addEventListener('click', () => {
        if (confirm(`Sender „${channel.name}“ entfernen?`)) saveOnlineChannels(kind, onlineChannels(kind).filter((c) => c !== channel));
      });
      row.append(name, meta, remove);
      box.appendChild(row);
    }
  }
  showPresets();
}

function addOnlineChannel() {
  const error = $('yt-error');
  const lines = $('yt-urls')
    .value.split(/[\n,;]+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    error.textContent = 'Bitte mindestens eine Adresse eintragen.';
    return;
  }
  const youtube = lines.filter((line) => parseYouTubeUrl(line));
  const web = lines.filter((line) => !parseYouTubeUrl(line) && parseWebUrl(line));
  const bad = lines.filter((line) => !parseYouTubeUrl(line) && !parseWebUrl(line));
  if (bad.length) {
    error.textContent = `Keine gültige Adresse von YouTube, archive.org oder einer Videodatei: ${bad.join(', ')}`;
    return;
  }
  if (youtube.length && web.length) {
    error.textContent = 'Bitte YouTube-Adressen und andere Adressen in getrennten Sendern anlegen.';
    return;
  }
  error.textContent = '';
  const kind = youtube.length ? KINDS.youtube : KINDS.web;
  const existing = onlineChannels(kind);
  const name = $('yt-name').value.trim() || `${kind === KINDS.youtube ? 'YouTube' : 'Internet'} ${existing.length + 1}`;
  const id = `${kind === KINDS.youtube ? 'yt' : 'web'}-${Date.now().toString(36)}`;
  saveOnlineChannels(kind, [...existing, { id, name, urls: lines }]).then(() => {
    $('yt-name').value = '';
    $('yt-urls').value = '';
  });
}

/** Fertige Vorschläge mit Material von 1977. */
function showPresets() {
  const box = $('presets-1977');
  box.replaceChildren();
  for (const preset of PRESETS_1977) {
    const added = onlineChannels(preset.kind).some((c) => c.id === preset.id);
    const row = document.createElement('div');
    row.className = 'entry preset';
    const text = document.createElement('div');
    text.className = 'name';
    const title = document.createElement('b');
    title.textContent = preset.name;
    const source = document.createElement('span');
    source.className = 'meta';
    source.textContent = preset.kind === KINDS.web ? ' · archive.org · volle Röhrensimulation' : ' · YouTube';
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = preset.note;
    text.append(title, source, note);
    const button = document.createElement('button');
    button.textContent = added ? 'Hinzugefügt' : 'Hinzufügen';
    button.disabled = added;
    button.addEventListener('click', () => {
      saveOnlineChannels(preset.kind, [...onlineChannels(preset.kind), { id: preset.id, name: preset.name, urls: preset.urls }]);
    });
    row.append(text, button);
    box.appendChild(row);
  }
}

// ---------------------------------------------------------------- Filme auswählen

let library = [];
let libraryKey = '';

function hiddenFiles() {
  return new Set(Array.isArray(settings?.hiddenFiles) ? settings.hiddenFiles : []);
}

/** Senderliste mit allen Filmen laden (auch den abgewählten); Internet-Sender werden hier aufgelöst. */
async function loadLibrary() {
  try {
    const data = await api('/api/channels');
    const channels = data.channels.filter((c) => c.type === 'video');
    await Promise.all(channels.filter((c) => c.remote).map((c) => resolveWebChannel(c)));
    library = channels.filter((c) => c.files?.length);
  } catch {
    library = [];
  }
  showLibrary(true);
}

function showLibrary(force) {
  const box = $('library');
  const hidden = hiddenFiles();
  const key = JSON.stringify([library.map((c) => [c.id, c.name, c.files.map((f) => f.url)]), [...hidden]]);
  if (!force && key === libraryKey) return;
  libraryKey = key;
  const open = new Set([...box.querySelectorAll('details[open]')].map((d) => d.dataset.id));
  box.replaceChildren();
  if (!library.length) {
    const empty = document.createElement('p');
    empty.className = 'note';
    empty.textContent = 'Noch keine Sender mit eigenen Filmen.';
    box.appendChild(empty);
    return;
  }
  for (const channel of library) {
    const details = document.createElement('details');
    details.dataset.id = channel.id;
    details.open = open.has(channel.id);
    const shown = channel.files.filter((f) => !hidden.has(f.url)).length;
    const summary = document.createElement('summary');
    summary.textContent = `${channel.name} – ${shown} von ${channel.files.length} Film${channel.files.length === 1 ? '' : 'en'}`;
    details.appendChild(summary);

    const buttons = document.createElement('div');
    buttons.className = 'row';
    for (const [label, on] of [
      ['Alle', true],
      ['Keine', false],
    ]) {
      const button = document.createElement('button');
      button.textContent = label;
      button.addEventListener('click', () => {
        const next = hiddenFiles();
        for (const file of channel.files) on ? next.delete(file.url) : next.add(file.url);
        saveHidden(next);
      });
      buttons.appendChild(button);
    }
    details.appendChild(buttons);

    for (const file of channel.files) {
      const row = document.createElement('label');
      row.className = 'film';
      const box2 = document.createElement('input');
      box2.type = 'checkbox';
      box2.checked = !hidden.has(file.url);
      box2.addEventListener('change', () => {
        const next = hiddenFiles();
        box2.checked ? next.delete(file.url) : next.add(file.url);
        saveHidden(next);
      });
      const name = document.createElement('span');
      name.textContent = file.name;
      row.append(box2, name);
      details.appendChild(row);
    }
    box.appendChild(details);
  }
}

function saveHidden(set) {
  // nur Einträge behalten, die es noch gibt – sonst wächst die Liste mit jedem gelöschten Film
  const known = new Set(library.flatMap((c) => c.files.map((f) => f.url)));
  const list = [...set].filter((url) => known.has(url));
  settings = { ...settings, hiddenFiles: list };
  showLibrary(true);
  setSetting('hiddenFiles', list);
}

function showSettings() {
  if (!settings) return;
  showOnlineChannels();
  showLibrary(false);
  for (const { item, input, valueEl, type } of controls) {
    if (document.activeElement === input && type !== 'check') continue;
    const value = getPath(settings, item.path);
    if (value === undefined && type !== 'check') continue;
    if (type === 'check') input.checked = value !== false && !!value;
    else if (type === 'select') {
      const match = item.options.find(([v]) => (item.numeric ? Math.abs(Number(v) - Number(value)) < 0.01 : v === value));
      if (match) input.value = String(match[0]);
    } else if (type === 'text') input.value = value || '';
    else {
      input.value = value;
      valueEl.textContent = item.format(Number(value));
    }
  }
}

// ---------------------------------------------------------------- Anzeige des Zustands

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
}

function badge(text, cls = '') {
  const el = document.createElement('span');
  el.className = `pill ${cls}`;
  el.textContent = text;
  return el;
}

let channelSignature = '';
let listedChannels = '';
let libraryTimer = 0;

function showStatus() {
  const alive = status && Date.now() - statusAt < 8000;
  const link = $('link');
  link.textContent = alive ? 'Anzeige läuft' : 'keine Anzeige';
  link.className = `pill ${alive ? 'on' : 'off'}`;
  if (!status) return;

  const ch = status.channels?.[status.channelIndex];
  $('now-channel').textContent = ch ? `${status.channelIndex + 1} · ${ch.name}` : '–';
  const item = status.item;
  $('now-film').textContent = item ? `Film ${item.index + 1} von ${item.count}: ${item.name}` : ch?.type === 'testcard' ? 'Testbild' : ch?.type === 'noise' ? 'Kein Signal (Rauschen)' : '';
  $('progress').style.width = item && item.duration ? `${Math.min(100, (item.offset / item.duration) * 100)}%` : '0';
  $('time-pos').textContent = item ? formatTime(item.offset) : '';
  $('time-total').textContent = item ? formatTime(item.duration) : '';

  const badges = $('badges');
  badges.replaceChildren();
  if (!status.power) badges.appendChild(badge('ausgeschaltet'));
  if (status.paused) badges.appendChild(badge('Pause', 'off'));
  if (status.fault) badges.appendChild(badge('Störung', 'off'));
  if (status.muted) badges.appendChild(badge('stumm'));
  if (status.plain) badges.appendChild(badge('Notbetrieb', 'off'));

  $('pause').textContent = status.paused ? 'Weiter' : 'Pause';
  $('power').textContent = status.power ? 'Ausschalten' : 'Einschalten';
  $('mute').textContent = status.muted ? 'Ton an' : 'Ton aus';

  const alerts = $('alerts');
  alerts.replaceChildren();
  const messages = [...(status.warnings || [])];
  if (status.audioBlocked) messages.push('Der Browser sperrt den Ton. An der Anzeige einmal eine Taste drücken oder den Kioskmodus (start-Skript) benutzen.');
  for (const c of status.channels || []) {
    if (c.missing > 0) messages.push(`Sender „${c.name}“: ${c.missing} ${c.type === 'youtube' ? 'Adresse(n) sind keine gültigen YouTube-Adressen' : 'Datei(en) lassen sich nicht abspielen'}.`);
  }
  for (const e of status.errors || []) messages.push(e.message);
  for (const message of [...new Set(messages)].slice(0, 8)) {
    const el = document.createElement('div');
    el.textContent = message;
    alerts.appendChild(el);
  }

  const signature = JSON.stringify([status.channels, status.channelIndex]);
  const listed = JSON.stringify((status.channels || []).map((c) => [c.id, c.films]));
  if (listed !== listedChannels) {
    listedChannels = listed;
    clearTimeout(libraryTimer);
    libraryTimer = setTimeout(loadLibrary, 800);
  }
  if (signature !== channelSignature) {
    channelSignature = signature;
    const box = $('channels');
    box.replaceChildren();
    (status.channels || []).forEach((c, index) => {
      const button = document.createElement('button');
      if (index === status.channelIndex) button.className = 'active';
      const numEl = document.createElement('span');
      numEl.className = 'num';
      numEl.textContent = String(index + 1);
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = c.name;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent =
        c.type === 'video'
          ? `${c.films} Film${c.films === 1 ? '' : 'e'} · ${formatTime(c.total)}`
          : c.type === 'youtube'
            ? `YouTube · ${c.films ? `${c.films} Video${c.films === 1 ? '' : 's'}` : 'Playlist'}`
            : c.type === 'testcard'
              ? 'Testbild'
              : 'Rauschen';
      button.append(numEl, name, meta);
      button.addEventListener('click', () => send('tune', { index }));
      box.appendChild(button);
    });
  }

  const info = [];
  if (status.version) info.push(`Version ${status.version}`);
  if (Number.isFinite(status.fps)) info.push(`${status.fps} Bilder/s`);
  if (Number.isFinite(status.uptime)) info.push(`Anzeige läuft seit ${formatTime(status.uptime)}`);
  if (serverInfo) info.push(`Browser-Neustarts: ${serverInfo.browserRestarts}`);
  if (status.youtubeFilters) info.push(`YouTube-Filter: Farbe „${status.youtubeFilters.color}“, Wölbung „${status.youtubeFilters.warp}“${status.youtubeFilters.grey ? ', Grau-Schicht an' : ''}`);
  $('system-info').textContent = info.join(' · ');
}

// ---------------------------------------------------------------- Filmordner (Android-App)

let platform = 'desktop';

function showMedia(config) {
  if (platform !== 'android') return;
  $('media-card').hidden = false;
  const media = config.media || {};
  $('media-label').textContent = media.label || '–';
  $('media-app-folder').textContent = media.appFolder ? `Zusätzlich liest die App immer ihren eigenen Ordner: ${media.appFolder}` : '';
  // Funktionen, die es nur am PC gibt
  document.querySelectorAll('[data-system="restartBrowser"]').forEach((b) => (b.textContent = 'Anzeige neu starten'));
}

function refreshMedia() {
  api('/api/config')
    .then(showMedia)
    .catch(() => {});
}

// ---------------------------------------------------------------- Start

function connect() {
  const source = new EventSource(`/api/events?role=admin&pin=${encodeURIComponent(pin)}`);
  source.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === 'status') {
      status = msg.status;
      statusAt = Date.now();
      showStatus();
    } else if (msg.type === 'settings') {
      const before = JSON.stringify([settings?.web, settings?.youtube]);
      settings = msg.settings;
      showSettings();
      if (JSON.stringify([settings?.web, settings?.youtube]) !== before) loadLibrary();
      if (platform === 'android') refreshMedia();
    }
  };
}

async function start() {
  buildControls();
  document.querySelectorAll('button[data-cmd]').forEach((button) => {
    button.addEventListener('click', () => send(button.dataset.cmd, button.dataset.args ? JSON.parse(button.dataset.args) : {}));
  });
  document.querySelectorAll('button[data-system]').forEach((button) => {
    button.addEventListener('click', () => {
      api('/api/system', { action: button.dataset.system })
        .then((r) => {
          if (r.warnings?.length) alert(r.warnings.join('\n'));
        })
        .catch((err) => alert(err.message));
    });
  });
  $('yt-add').addEventListener('click', addOnlineChannel);
  $('library-reload').addEventListener('click', loadLibrary);
  $('reset').addEventListener('click', () => {
    if (confirm('Alle in der Fernbedienung geänderten Einstellungen verwerfen? Es gelten dann wieder die Werte aus config.json.')) {
      api('/api/settings', { reset: true }).catch((err) => alert(err.message));
    }
  });
  $('quit').addEventListener('click', () => {
    if (confirm('TV-Simulator wirklich beenden? Der Bildschirm zeigt danach kein Programm mehr.')) {
      api('/api/system', { action: 'quit' }).catch((err) => alert(err.message));
    }
  });

  if (new URLSearchParams(location.search).has('embedded')) {
    document.querySelector('header').style.display = 'none';
    window.addEventListener('keydown', (e) => {
      if (e.key === 'F2' || e.key === 'Escape') {
        e.preventDefault();
        window.parent.postMessage('tv-close-settings', location.origin);
      }
    });
  }

  const config = await api('/api/config');
  settings = config.settings;
  platform = config.platform || 'desktop';
  showMedia(config);
  showSettings();
  const current = await api('/api/status');
  serverInfo = current.server;
  if (current.status) {
    status = current.status;
    statusAt = Date.now() - (current.age || 0);
  }
  showStatus();
  loadLibrary();
  connect();
  setInterval(showStatus, 2000);
}

start().catch((err) => {
  document.querySelector('main').insertAdjacentHTML('afterbegin', `<section class="card"><b>Keine Verbindung zum TV-Simulator.</b><p class="note"></p></section>`);
  document.querySelector('main .note').textContent = err.message;
});
