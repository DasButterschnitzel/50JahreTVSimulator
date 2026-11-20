import fs from 'node:fs';
import path from 'node:path';
import { isPlainObject, readLooseJsonFile } from './config.js';

export const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.webm', '.mov', '.mkv', '.ogv']);

const CHANNEL_TYPES = new Set(['video', 'testcard', 'noise']);
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
