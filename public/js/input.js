// Eingaben: Tastatur (auch USB-Drehregler, die sich als Tastatur melden), Mausrad und Berührung.

const REPEATABLE = new Set(['volumeUp', 'volumeDown', 'seekForward', 'seekBack']);
const LONG_PRESS_MS = 800;
const SWIPE_MIN_PX = 50;
const SWIPE_MAX_MS = 900;

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
    this.bindTouch();
  }

  /** Berührungsbildschirm: Wischen wechselt den Sender, langes Drücken öffnet die Einstellungen. */
  bindTouch() {
    let start = null;
    let timer = 0;
    const cancel = () => {
      clearTimeout(timer);
      timer = 0;
    };
    const outside = (e) => !(e.target instanceof Element) || !e.target.closest('#settings');
    window.addEventListener(
      'touchstart',
      (e) => {
        cancel();
        if (!outside(e) || e.touches.length !== 1) {
          start = null;
          return;
        }
        const t = e.touches[0];
        start = { x: t.clientX, y: t.clientY, time: performance.now(), moved: false };
        if (this.settings.input?.touchMenu !== false) {
          timer = setTimeout(() => {
            if (start && !start.moved) {
              start = null;
              this.onAction('settings');
            }
          }, LONG_PRESS_MS);
        }
      },
      { passive: true }
    );
    window.addEventListener(
      'touchmove',
      (e) => {
        if (!start) return;
        const t = e.touches[0];
        if (Math.hypot(t.clientX - start.x, t.clientY - start.y) > 14) {
          start.moved = true;
          cancel();
        }
      },
      { passive: true }
    );
    window.addEventListener(
      'touchend',
      (e) => {
        cancel();
        const from = start;
        start = null;
        if (!from || (this.settings.input?.touch || 'channel') === 'none') return;
        const t = e.changedTouches[0];
        const dx = t.clientX - from.x;
        const dy = t.clientY - from.y;
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        if (distance < SWIPE_MIN_PX || performance.now() - from.time > SWIPE_MAX_MS) return;
        // nach links oder oben wischen = nächster Sender
        const forward = Math.abs(dx) > Math.abs(dy) ? dx < 0 : dy < 0;
        this.onAction(forward ? 'channelUp' : 'channelDown');
      },
      { passive: true }
    );
    window.addEventListener('touchcancel', () => {
      cancel();
      start = null;
    });
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
