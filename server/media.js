import fs from 'node:fs';
import path from 'node:path';
import { isPlainObject, readLooseJsonFile } from './config.js';

export const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.webm', '.mov', '.mkv', '.ogv', '.3gp']);

const CHANNEL_TYPES = new Set(['video', 'testcard', 'noise', 'youtube']);
const naturalCompare = (a, b) => a.localeCompare(b, 'de', { numeric: true, sensitivity: 'base' });

/** "01-hessentag_dreieich" -> "Hessentag Dreieich" */
export function prettifyName(folder) {
  const cleaned = folder
    .replace(/^[\d\s._-]+/, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  const base = cleaned || folder;
  return base.replace(/(^|\s)(\p{L})/gu, (m, space, letter) => space + letter.toUpperCase());
}

function listVideos(dir, urlPrefix) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    if (!VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    try {
      const stat = fs.statSync(path.join(dir, entry.name));
      if (stat.size === 0) continue;
      files.push({
        name: entry.name,
        url: `${urlPrefix}${encodeURIComponent(entry.name)}`,
        size: stat.size,
        mtime: Math.round(stat.mtimeMs),
      });
    } catch {
      // Datei ist zwischenzeitlich verschwunden
    }
  }
  files.sort((a, b) => naturalCompare(a.name, b.name));
  return files;
}

/**
 * Liest den Medienordner ein. Jeder Unterordner ist ein Sender;
 * die Sender werden nach Ordnernamen sortiert, die Filme darin nach Dateinamen.
 */
export function scanMedia(mediaDir) {
  const warnings = [];
  const channels = [];
  let entries = [];
  try {
    entries = fs.readdirSync(mediaDir, { withFileTypes: true });
  } catch {
    warnings.push(`Medienordner nicht gefunden: ${mediaDir}`);
  }

  const rootFiles = listVideos(mediaDir, '/media/');
  if (rootFiles.length) {
    channels.push({ id: '_root', folder: '', name: 'Programm', type: 'video', options: {}, files: rootFiles });
  }

  const folders = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
    .map((e) => e.name)
    .sort(naturalCompare);

  for (const folder of folders) {
    const dir = path.join(mediaDir, folder);
    let options = {};
    const optionsFile = path.join(dir, 'channel.json');
    if (fs.existsSync(optionsFile)) {
      try {
        const parsed = readLooseJsonFile(optionsFile);
        if (isPlainObject(parsed)) options = parsed;
      } catch (err) {
        warnings.push(`${folder}/channel.json ist fehlerhaft und wird ignoriert: ${err.message}`);
      }
    }
    const files = listVideos(dir, `/media/${encodeURIComponent(folder)}/`);
    let type = CHANNEL_TYPES.has(options.type) ? options.type : files.length ? 'video' : 'testcard';
    if (type === 'video' && !files.length) type = 'testcard';
    channels.push({
      id: folder,
      folder,
      name: typeof options.name === 'string' && options.name.trim() ? options.name.trim() : prettifyName(folder),
      type,
      options,
      files: type === 'video' ? files : [],
    });
  }

  if (!channels.length) {
    channels.push({ id: '_testbild', folder: '', name: 'Testbild', type: 'testcard', options: {}, files: [] });
  }
  return { channels, warnings };
}

function onlineEntries(list, prefix, build) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach((entry, index) => {
    if (!isPlainObject(entry) || !Array.isArray(entry.urls)) return;
    const urls = entry.urls.filter((u) => typeof u === 'string' && u.trim()).map((u) => u.trim());
    if (!urls.length) return;
    const id = typeof entry.id === 'string' && entry.id ? entry.id : `${prefix}-${index + 1}`;
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : `${prefix === 'yt' ? 'YouTube' : 'Internet'} ${index + 1}`;
    const options = { urls };
    if (entry.blackWhite) options.blackWhite = true;
    if (typeof entry.fit === 'string') options.fit = entry.fit;
    out.push(build(id, name, options));
  });
  return out;
}

/**
 * Hängt die Sender aus den Einstellungen an die Senderliste an: Internet-Sender ("web.channels",
 * Filme von archive.org oder direkte Videoadressen) und YouTube-Sender ("youtube.channels").
 * Die Adressen wertet die Anzeige aus; hier werden sie nur durchgereicht.
 */
export function addOnlineChannels(scan, settings) {
  const extra = [
    ...onlineEntries(settings?.web?.channels, 'web', (id, name, options) => ({ id, folder: '', name, type: 'video', remote: true, options, files: [] })),
    ...onlineEntries(settings?.youtube?.channels, 'yt', (id, name, options) => ({ id, folder: '', name, type: 'youtube', options, files: [] })),
  ];
  if (!extra.length) return scan;
  // das Ersatz-Testbild wird nur gebraucht, wenn es sonst gar keinen Sender gibt
  const channels = scan.channels.filter((c) => c.id !== '_testbild');
  return { ...scan, channels: [...channels, ...extra] };
}
