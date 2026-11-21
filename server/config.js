import fs from 'node:fs';
import path from 'node:path';

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Tiefes Zusammenführen; Arrays und einfache Werte werden ersetzt. */
export function deepMerge(base, ...overrides) {
  const out = isPlainObject(base) ? { ...base } : {};
  for (const key of Object.keys(out)) {
    if (isPlainObject(out[key])) out[key] = deepMerge(out[key]);
  }
  for (const over of overrides) {
    if (!isPlainObject(over)) continue;
    for (const [key, value] of Object.entries(over)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      if (isPlainObject(value)) out[key] = deepMerge(isPlainObject(out[key]) ? out[key] : {}, value);
      else if (value !== undefined) out[key] = Array.isArray(value) ? [...value] : value;
    }
  }
  return out;
}

/**
 * JSON mit Kommentaren (// und /* *\/) und überzähligen Kommas lesen,
 * damit die Konfiguration von Hand bearbeitet werden kann.
 */
export function parseLooseJson(text) {
  text = String(text).replace(/^\uFEFF/, '');
  let stripped = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (inString) {
      stripped += c;
      if (c === '\\') {
        stripped += n ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
    } else if (c === '"') {
      inString = true;
      stripped += c;
      i++;
    } else if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
    } else {
      stripped += c;
      i++;
    }
  }

  let out = '';
  inString = false;
  for (i = 0; i < stripped.length; i++) {
    const c = stripped[i];
    if (inString) {
      out += c;
      if (c === '\\') out += stripped[++i] ?? '';
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < stripped.length && /\s/.test(stripped[j])) j++;
      if (stripped[j] === '}' || stripped[j] === ']') continue;
    }
    out += c;
  }
  return JSON.parse(out);
}

export function readLooseJsonFile(file) {
  return parseLooseJson(fs.readFileSync(file, 'utf8'));
}

/** Standardwerte; dieselbe Datei benutzt auch die Android-App. */
export const DEFAULTS = readLooseJsonFile(new URL('./defaults.jsonc', import.meta.url));

/**
 * Verwaltet config.json (von Hand gepflegt) und data/state.json
 * (Laufzeitzustand und Änderungen aus der Fernbedienung).
 */
export class Store {
  constructor({ configFile, dataDir, log = console }) {
    this.configFile = configFile;
    this.dataDir = dataDir;
    this.stateFile = path.join(dataDir, 'state.json');
    this.log = log;
    this.warnings = [];
    this.fileConfig = {};
    this.state = { settings: {}, broadcast: {}, channel: null, power: true };
    this._saveTimer = null;
    this.loadConfig();
    this.loadState();
  }

  loadConfig() {
    this.warnings = this.warnings.filter((w) => w.source !== 'config');
    if (!fs.existsSync(this.configFile)) {
      this.fileConfig = {};
      return;
    }
    try {
      const parsed = readLooseJsonFile(this.configFile);
      if (!isPlainObject(parsed)) throw new Error('Die Datei muss ein JSON-Objekt enthalten.');
      this.fileConfig = parsed;
    } catch (err) {
      // Ein Tippfehler in der Konfiguration darf die Ausstellung nicht lahmlegen.
      this.fileConfig = {};
      const message = `config.json ist fehlerhaft und wird ignoriert: ${err.message}`;
      this.warnings.push({ source: 'config', message });
      this.log.warn(message);
    }
  }

  loadState() {
    try {
      if (!fs.existsSync(this.stateFile)) return;
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (isPlainObject(parsed)) {
        this.state = {
          settings: isPlainObject(parsed.settings) ? parsed.settings : {},
          broadcast: isPlainObject(parsed.broadcast) ? parsed.broadcast : {},
          channel: typeof parsed.channel === 'string' ? parsed.channel : null,
          power: parsed.power !== false,
        };
      }
    } catch (err) {
      this.log.warn(`data/state.json nicht lesbar, starte mit leerem Zustand: ${err.message}`);
    }
  }

  /** Einstellungen ohne die Änderungen aus der Fernbedienung. */
  baseSettings() {
    return deepMerge(DEFAULTS, this.fileConfig);
  }

  settings() {
    return deepMerge(DEFAULTS, this.fileConfig, this.state.settings);
  }

  patchSettings(patch) {
    if (!isPlainObject(patch)) return;
    const clean = { ...patch };
    delete clean.server; // Serverdaten lassen sich nur in config.json ändern
    delete clean.kiosk;
    delete clean.mediaDir;
    this.state.settings = deepMerge(this.state.settings, clean);
    this.scheduleSave();
  }

  resetSettings(section) {
    if (section) delete this.state.settings[section];
    else this.state.settings = {};
    this.scheduleSave();
  }

  patchState(patch) {
    if (!isPlainObject(patch)) return;
    if (isPlainObject(patch.broadcast)) this.state.broadcast = patch.broadcast;
    if (typeof patch.channel === 'string') this.state.channel = patch.channel;
    if (typeof patch.power === 'boolean') this.state.power = patch.power;
    this.scheduleSave();
  }

  scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveNow();
    }, 400);
    this._saveTimer.unref?.();
  }

  saveNow() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const tmp = `${this.stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmp, this.stateFile);
    } catch (err) {
      this.log.warn(`Zustand konnte nicht gespeichert werden: ${err.message}`);
    }
  }
}
