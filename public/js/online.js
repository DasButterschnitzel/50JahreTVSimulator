// Internet-Sender: Filme von archive.org oder direkte Videoadressen als Programm.
//
// Anders als bei YouTube liefert archive.org die Videodateien selbst aus. Der eigene Server
// holt sie ab und reicht sie weiter (siehe viaServer); so laufen diese Filme wie eigene
// Dateien durch die volle Röhrensimulation.

const CACHE_KEY = 'tv77.archive';
const CACHE_MAX_AGE_MS = 24 * 3600 * 1000;
const FETCH_TIMEOUT_MS = 15000;
const VIDEO_EXTENSION = /\.(mp4|m4v|webm|mov|ogv)$/i;
// Formate, die archive.org selbst aus dem Original erzeugt und die jeder Browser abspielt
const DERIVATIVE_FORMATS = ['h.264', 'h.264 IA', 'h.264 HD', 'MPEG4', '512Kb MPEG4', 'WebM', 'Ogg Video'];
const ARCHIVE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/;

/**
 * Adresse, unter der die Anzeige einen Film aus dem Internet abruft: über den eigenen Server.
 * Fremde Server erlauben dem Browser meist nicht, ihre Videos durch die Röhrensimulation zu
 * schicken – auch archive.org nicht (nur die Weiterleitung trägt die Freigabe, die Datei nicht).
 */
export const viaServer = (url) => `/remote/${encodeURIComponent(url)}`;

const naturalCompare = (a, b) => a.localeCompare(b, 'de', { numeric: true, sensitivity: 'base' });

/**
 * Versteht Adressen von archive.org und direkte Videoadressen.
 *   https://archive.org/details/KENNUNG          -> alle Filme des Eintrags
 *   https://archive.org/details/KENNUNG#1977     -> nur Filme, deren Name mit "1977" beginnt
 *   https://archive.org/download/KENNUNG/film.mp4 oder https://…/film.mp4 -> genau diese Datei
 * Liefert { archive, prefix } oder { direct, name } oder null.
 */
export function parseWebUrl(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.replace(/^www\./, '');
  const parts = url.pathname.split('/').filter(Boolean);
  let prefix = '';
  try {
    prefix = decodeURIComponent(url.hash.slice(1)).trim();
  } catch {
    prefix = url.hash.slice(1).trim();
  }
  if (host === 'archive.org' && (parts[0] === 'details' || parts[0] === 'download') && parts[1] && ARCHIVE_ID.test(parts[1])) {
    if (parts.length === 2 || parts[0] === 'details') return { archive: parts[1], prefix };
  }
  if (VIDEO_EXTENSION.test(url.pathname)) {
    let name = parts[parts.length - 1] || 'Film';
    try {
      name = decodeURIComponent(name);
    } catch {
      // Name bleibt kodiert
    }
    url.hash = '';
    return { direct: url.href, name: name.replace(VIDEO_EXTENSION, '') };
  }
  return null;
}

/** "2184.79", "36:24" oder "1:02:03" -> Sekunden */
function parseLength(value) {
  const text = String(value ?? '').trim();
  if (!text) return 0;
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const parts = text.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((sum, n) => sum * 60 + n, 0);
}

const encodePath = (name) => name.split('/').map(encodeURIComponent).join('/');

/**
 * Wählt aus der Dateiliste eines archive.org-Eintrags die abspielbaren Filme:
 * je Film eine Datei (bevorzugt die von archive.org erzeugte H.264-Fassung), ohne Doppelte.
 */
export function pickArchiveFiles(metadata, prefix = '') {
  const id = metadata?.metadata?.identifier;
  const files = Array.isArray(metadata?.files) ? metadata.files : [];
  if (!id) return [];
  // Dateien zu Filmen bündeln: abgeleitete Fassungen gehören zu ihrem Original
  const groups = new Map();
  for (const file of files) {
    if (!file?.name || file.private === 'true') continue;
    const derivative = file.source === 'derivative' && file.original;
    const key = derivative ? file.original : file.name;
    if (!groups.has(key)) groups.set(key, { original: null, derivatives: [] });
    if (derivative) groups.get(key).derivatives.push(file);
    else groups.get(key).original = file;
  }
  const wanted = prefix.toLowerCase();
  const seen = new Set();
  const result = [];
  const titleOf = (key) => key.replace(/\.[A-Za-z0-9]{2,5}$/, '');
  for (const key of [...groups.keys()].sort((a, b) => naturalCompare(titleOf(a), titleOf(b)))) {
    const group = groups.get(key);
    const title = titleOf(key);
    if (wanted && !title.toLowerCase().startsWith(wanted)) continue;
    let chosen = null;
    for (const format of DERIVATIVE_FORMATS) {
      chosen = group.derivatives.find((f) => f.format === format && VIDEO_EXTENSION.test(f.name));
      if (chosen) break;
    }
    if (!chosen && group.original && VIDEO_EXTENSION.test(group.original.name)) chosen = group.original;
    if (!chosen) continue;
    // "Film Kopie.mp4" ist derselbe Film noch einmal
    const dedupe = title.replace(/\s+(Kopie|copy)(\s*\d+)?$/i, '').toLowerCase();
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const file = { url: viaServer(`https://archive.org/download/${id}/${encodePath(chosen.name)}`), name: title, size: Number(chosen.size) || 0, mtime: Number(chosen.mtime) || 0 };
    const duration = parseLength(chosen.length || group.original?.length);
    if (duration > 0) file.duration = duration;
    result.push(file);
  }
  return result;
}

function readCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function writeCache(cache) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // ohne Speicher wird beim nächsten Start neu abgefragt
  }
}

async function fetchArchive(id) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://archive.org/metadata/${encodeURIComponent(id)}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`archive.org antwortet mit ${res.status}`);
    const data = await res.json();
    if (!data?.metadata?.identifier) throw new Error('Eintrag nicht gefunden');
    // nur das Nötige aufheben
    return {
      metadata: { identifier: data.metadata.identifier, title: data.metadata.title },
      files: (data.files || []).map(({ name, format, source, original, size, length, mtime }) => ({ name, format, source, original, size, length, mtime })),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Löst die Adressen eines Internet-Senders in eine Filmliste auf (ch.files).
 * Einträge von archive.org werden einmal täglich neu abgefragt; ist archive.org nicht
 * erreichbar, gilt die zuletzt bekannte Liste.
 */
export async function resolveWebChannel(ch, log = console) {
  const cache = readCache();
  const files = [];
  const invalid = [];
  let changed = false;
  for (const entry of Array.isArray(ch.options?.urls) ? ch.options.urls : []) {
    const parsed = parseWebUrl(entry);
    if (!parsed) {
      if (String(entry).trim()) invalid.push(String(entry));
      continue;
    }
    if (parsed.direct) {
      files.push({ url: viaServer(parsed.direct), name: parsed.name, size: 0, mtime: 0 });
      continue;
    }
    let known = cache[parsed.archive];
    if (!known || Date.now() - (known.at || 0) > CACHE_MAX_AGE_MS) {
      try {
        known = { at: Date.now(), data: await fetchArchive(parsed.archive) };
        cache[parsed.archive] = known;
        changed = true;
      } catch (err) {
        log.warn(`archive.org-Eintrag „${parsed.archive}“: ${err.name === 'AbortError' ? 'keine Antwort' : err.message}`);
      }
    }
    const picked = known ? pickArchiveFiles(known.data, parsed.prefix) : [];
    if (!picked.length) invalid.push(String(entry));
    files.push(...picked);
  }
  if (changed) writeCache(cache);
  ch.files = files;
  ch.invalidUrls = invalid;
  return ch;
}

/**
 * Entfernt in der Fernbedienung abgewählte Filme. Sender, bei denen alle Filme abgewählt
 * sind, verschwinden ganz aus der Senderliste.
 */
export function applyHiddenFiles(channels, hidden) {
  const set = new Set(Array.isArray(hidden) ? hidden : []);
  if (!set.size) return channels;
  const result = [];
  for (const ch of channels) {
    if (ch.type !== 'video' || !ch.files?.length) {
      result.push(ch);
      continue;
    }
    const files = ch.files.filter((f) => !set.has(f.url));
    if (files.length) result.push(files.length === ch.files.length ? ch : { ...ch, files });
  }
  return result;
}
