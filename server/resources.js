// Zugriff auf die mitgelieferten Dateien des Programms (Anzeige, Standardwerte, Version).
//
// Normalerweise liegen sie als Dateien neben server.js. In der eigenständigen
// TV-Simulator.exe stecken sie in der Programmdatei selbst; daneben liegen dann nur
// noch die Dinge, die man anfasst: config.json, der Ordner media und der Ordner data.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

let sea = null;
try {
  const candidate = createRequire(import.meta.url)('node:sea');
  if (candidate.isSea()) sea = candidate;
} catch {
  // ältere Node-Version oder normaler Start: Dateien liegen auf der Platte
}

/** true in der eigenständigen Programmdatei */
export const isPackaged = sea !== null;

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Ordner für config.json, media und data: neben der Programmdatei bzw. neben server.js */
export const APP_DIR = isPackaged ? path.dirname(process.execPath) : SOURCE_ROOT;

/** Inhalt einer mitgelieferten Datei ("public/index.html", "server/defaults.jsonc" …) oder null. */
export function readResource(name) {
  if (typeof name !== 'string' || name.includes('\0') || name.includes('\\')) return null;
  const normalized = path.posix.normalize(name);
  if (normalized.startsWith('..') || normalized.startsWith('/')) return null;
  if (sea) {
    try {
      return Buffer.from(sea.getAsset(normalized));
    } catch {
      return null;
    }
  }
  try {
    const file = path.join(SOURCE_ROOT, normalized);
    return fs.statSync(file).isFile() ? fs.readFileSync(file) : null;
  } catch {
    return null;
  }
}
