// Eingaben: Tastatur (auch USB-Drehregler, die sich als Tastatur melden) und Mausrad.

const REPEATABLE = new Set(['volumeUp', 'volumeDown', 'seekForward', 'seekBack']);

function comboId({ ctrl, alt, meta, shift, key }) {
  return `${ctrl ? 'C' : ''}${alt ? 'A' : ''}${meta ? 'M' : ''}${shift ? 'S' : ''}:${key}`;
}

function normalizeKey(key, shift) {
  if (key === 'Spacebar' || key === 'Space') key = ' ';
  if (key.length === 1) {
    const lower = key.toLowerCase();
    const isLetter = lower !== key.toUpperCase();
    // Bei Zeichen wie "+" hängt die Umschalttaste vom Tastaturlayout ab – ignorieren.
    return { key: lower, shift: isLetter ? shift : false };
  }
  return { key, shift };
}

/** "Ctrl+Shift+R" -> Kennung */
export function parseCombo(text) {
  let rest = String(text);
  const mods = { ctrl: false, alt: false, meta: false, shift: false };
  for (;;) {
    const m = /^(ctrl|strg|control|alt|meta|cmd|win|shift|umschalt)\+(?=.)/i.exec(rest);
    if (!m) break;
    const name = m[1].toLowerCase();
    if (name === 'ctrl' || name === 'strg' || name === 'control') mods.ctrl = true;
    else if (name === 'alt') mods.alt = true;
    else if (name === 'shift' || name === 'umschalt') mods.shift = true;
    else mods.meta = true;
    rest = rest.slice(m[0].length);
  }
  if (!rest) return null;
  const { key, shift } = normalizeKey(rest, mods.shift);
  return comboId({ ...mods, shift, key });
}

export class Input {
  constructor(settings, onAction) {
    this.onAction = onAction;
    this.map = new Map();
    this.wheelSum = 0;
    this.applySettings(settings);

    window.addEventListener('keydown', (e) => this.onKey(e), true);
    window.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.onWheel(e);
      },
      { passive: false }
    );
    window.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  applySettings(settings) {
    this.settings = settings;
    this.map.clear();
    for (const [action, combos] of Object.entries(settings.keys || {})) {
      for (const combo of Array.isArray(combos) ? combos : [combos]) {
        const id = parseCombo(combo);
        if (id) this.map.set(id, action);
      }
    }
  }

  onKey(e) {
    if (e.isComposing || ['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    const { key, shift } = normalizeKey(e.key, e.shiftKey);
    const action = this.map.get(comboId({ ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, shift, key }));
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat && !REPEATABLE.has(action)) return;
    this.onAction(action);
  }

  onWheel(e) {
    const mode = this.settings.input?.wheel || 'none';
    if (mode === 'none') return;
    const step = Math.max(1, Number(this.settings.input?.wheelStep) || 100);
    this.wheelSum += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    while (Math.abs(this.wheelSum) >= step) {
      const up = this.wheelSum < 0;
      this.wheelSum -= Math.sign(this.wheelSum) * step;
      if (mode === 'volume') this.onAction(up ? 'volumeUp' : 'volumeDown');
      else this.onAction(up ? 'channelUp' : 'channelDown');
    }
  }
}
