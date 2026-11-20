// Sendeuhr: Alle Sender laufen gleichzeitig, auch wenn gerade niemand zuschaut.
// Die Position eines Senders ergibt sich allein aus der Uhrzeit – dadurch läuft
// das Programm auch nach einem Neustart des Rechners nahtlos weiter.

const POSITION_BIAS_S = 1e-4;

export function mod(a, n) {
  return ((a % n) + n) % n;
}

/** Baut aus einer Filmliste einen Sendeplan mit Startzeiten. */
export function buildSchedule(items) {
  const list = [];
  let start = 0;
  for (const item of items) {
    const duration = Number(item.duration);
    if (!Number.isFinite(duration) || duration <= 0) continue;
    list.push({ ...item, duration, start });
    start += duration;
  }
  return { items: list, total: start };
}

/** Welcher Film läuft an Position pos (Sekunden seit Programmbeginn)? */
export function locate(schedule, pos) {
  if (!schedule.items.length || schedule.total <= 0) return null;
  const p = mod(pos, schedule.total);
  let lo = 0;
  let hi = schedule.items.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (schedule.items[mid].start <= p) lo = mid;
    else hi = mid - 1;
  }
  const item = schedule.items[lo];
  const offset = Math.min(Math.max(p - item.start, 0), item.duration);
  return { index: lo, item, offset, remaining: item.duration - offset, position: p };
}

export class BroadcastClock {
  constructor(state = {}) {
    this.pauseAccum = Number.isFinite(state.pauseAccum) ? state.pauseAccum : 0;
    this.pausedAt = Number.isFinite(state.pausedAt) ? state.pausedAt : null;
    this.offsets = {};
    if (state.offsets && typeof state.offsets === 'object') {
      for (const [id, value] of Object.entries(state.offsets)) {
        if (Number.isFinite(value)) this.offsets[id] = value;
      }
    }
  }

  static wall() {
    return Date.now() / 1000;
  }

  get paused() {
    return this.pausedAt !== null;
  }

  /** Sendezeit in Sekunden; steht still, solange pausiert ist. */
  now(wall = BroadcastClock.wall()) {
    return (this.pausedAt ?? wall) - this.pauseAccum;
  }

  pause(wall = BroadcastClock.wall()) {
    if (this.pausedAt === null) this.pausedAt = wall;
  }

  resume(wall = BroadcastClock.wall()) {
    if (this.pausedAt === null) return;
    this.pauseAccum += Math.max(0, wall - this.pausedAt);
    this.pausedAt = null;
  }

  position(id, total, wall = BroadcastClock.wall()) {
    if (!(total > 0)) return 0;
    return mod(this.now(wall) + (this.offsets[id] || 0), total);
  }

  setPosition(id, total, pos, wall = BroadcastClock.wall()) {
    if (!(total > 0)) return;
    // Die Uhrzeit ist eine sehr große Zahl; beim Rechnen bleiben winzige Rundungsfehler.
    // Die kleine Zugabe stellt sicher, dass ein Sprung „an den Anfang von Film 2“ nie
    // einen Hauch davor landet – also am Ende von Film 1.
    this.offsets[id] = mod(pos - this.now(wall), total) + POSITION_BIAS_S;
  }

  shift(id, total, delta, wall = BroadcastClock.wall()) {
    this.setPosition(id, total, this.position(id, total, wall) + delta, wall);
  }

  toJSON() {
    return { pauseAccum: this.pauseAccum, pausedAt: this.pausedAt, offsets: { ...this.offsets } };
  }
}
