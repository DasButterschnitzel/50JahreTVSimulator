// Wiedergabe: hält das Video des eingestellten Senders synchron zur Sendeuhr,
// wechselt nahtlos zum nächsten Film und fängt Fehler ab.
import { buildSchedule, locate, mod } from './broadcast.js';
import { watchVideoFrames } from './renderer.js';
import { drawTestcard, drawFaultCard } from './testcard.js';
import { prepareYouTubeChannel, rememberYouTubeDuration } from './youtube.js';

const LOAD_TIMEOUT_MS = 12000;
const STALL_TIMEOUT_MS = 8000;
const PLAY_TIMEOUT_MS = 3000;
const SWITCH_TIMEOUT_MS = 30000;
const FINISH_GRACE_S = 3;
const YOUTUBE_STALL_TIMEOUT_MS = 120000; // Werbung und langsames Netz sind kein Hänger

/** Sender, die einen Sendeplan aus Filmen haben. */
const playable = (ch) => !!ch && (ch.type === 'video' || ch.type === 'youtube');
const FAULT_RETRY_MS = 15000;
const MAX_DRIFT_S = 2;
const PRELOAD_BEFORE_END_S = 10;
const MAX_STALLS = 6;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rand = (min, max) => min + Math.random() * (max - min);

function mediaErrorText(video) {
  const code = video.error?.code;
  const texts = { 1: 'abgebrochen', 2: 'Datei nicht lesbar', 3: 'Datei beschädigt', 4: 'Format wird nicht unterstützt' };
  return texts[code] || video.error?.message || 'unbekannter Fehler';
}

/** Lädt eine Datei, springt an die Stelle offset und meldet, wenn ein Bild bereitsteht. */
function loadVideo(video, url, offset) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer = 0;
    const events = {
      loadedmetadata: () => {
        const d = video.duration;
        const target = Number.isFinite(d) ? Math.min(offset, Math.max(0, d - 0.2)) : offset;
        if (Math.abs(video.currentTime - target) > 0.3) {
          try {
            video.currentTime = target;
          } catch {
            // Springen nicht möglich – Wiedergabe beginnt am Anfang
          }
        }
      },
      canplay: () => check(),
      seeked: () => check(),
      error: () => finish(new Error(mediaErrorText(video))),
    };
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const [name, fn] of Object.entries(events)) video.removeEventListener(name, fn);
      if (err) reject(err);
      else resolve();
    };
    const check = () => {
      if (video.readyState >= 3 && !video.seeking) finish();
    };
    for (const [name, fn] of Object.entries(events)) video.addEventListener(name, fn);
    timer = setTimeout(() => finish(new Error('Zeitüberschreitung beim Laden')), LOAD_TIMEOUT_MS);
    video.src = url;
    video.load();
  });
}

export class Player {
  constructor({ settings, clock, view, director, audio, youtube = null, log = console, onChange = () => {}, onFatal = () => {}, onDuration = () => {} }) {
    this.settings = settings;
    this.clock = clock;
    this.view = view;
    this.director = director;
    this.audio = audio;
    this.yt = youtube;
    this.log = log;
    this.onChange = onChange;
    this.onFatal = onFatal;
    this.onDuration = onDuration;

    this.channels = [];
    this.schedules = new Map();
    this.channelIndex = 0;
    this.itemIndex = -1;
    this.token = 0;
    this.loading = false;
    this.switching = false;
    this.fault = null;
    this.powered = true;
    this.needsGesture = false;
    this.suspended = false;
    this.standbyFor = null;
    this.stalls = 0;
    this.switchStarted = 0;
    this.lastTime = -1;
    this.lastAdvance = performance.now();
    this.healthySince = performance.now();

    this.videos = [this.makeVideo(), this.makeVideo()];
    this.activeIdx = 0;
    this.testCanvas = document.createElement('canvas');
    this.faultCanvas = document.createElement('canvas');
    this.drawCards();
  }

  makeVideo() {
    const v = document.createElement('video');
    v.preload = 'auto';
    v.playsInline = true;
    v.disableRemotePlayback = true;
    watchVideoFrames(v);
    this.audio.attach(v);
    v.addEventListener('ended', () => this.onEnded(v));
    v.addEventListener('error', () => {
      if (v !== this.active || this.loading || this.switching || !this.powered || !v.currentSrc) return;
      this.log.warn(`Wiedergabefehler: ${mediaErrorText(v)}`);
      this.setFault();
    });
    return v;
  }

  get active() {
    return this.videos[this.activeIdx];
  }

  get standby() {
    return this.videos[this.activeIdx ^ 1];
  }

  get channel() {
    return this.channels[this.channelIndex] || null;
  }

  /** Was gerade abgespielt wird: das aktive Videoelement oder der YouTube-Player. */
  get media() {
    return this.channel?.type === 'youtube' && this.yt ? this.yt.media : this.active;
  }

  drawCards() {
    drawTestcard(this.testCanvas, this.settings.testcard);
    drawFaultCard(this.faultCanvas);
  }

  applySettings(settings) {
    this.settings = settings;
    this.drawCards();
    this.view.markSourceDirty();
  }

  /** Senderliste übernehmen (Dateien müssen ihre Dauer schon kennen). */
  setChannels(channels, preferredId) {
    const keepId = preferredId ?? this.channel?.id;
    this.channels = channels;
    this.schedules = new Map();
    for (const ch of channels) {
      if (ch.type === 'youtube') prepareYouTubeChannel(ch);
      this.schedules.set(ch.id, buildSchedule(ch.files || []));
    }
    const index = channels.findIndex((c) => c.id === keepId);
    this.channelIndex = index >= 0 ? index : Math.min(this.channelIndex, Math.max(0, channels.length - 1));
  }

  schedule(ch) {
    return this.schedules.get(ch.id) || { items: [], total: 0 };
  }

  locateNow(ch = this.channel) {
    if (!ch) return null;
    const schedule = this.schedule(ch);
    if (!schedule.items.length) return null;
    return locate(schedule, this.clock.position(ch.id, schedule.total));
  }

  sourceOptions(ch) {
    return { fit: ch.options?.fit, blackWhite: !!ch.options?.blackWhite };
  }

  showVideo(v, ch) {
    this.view.setSource({ kind: 'video', el: v }, this.sourceOptions(ch));
  }

  /** Das Bild des Senders zeigen: eigenes Video über den Shader oder den YouTube-Player unter der Effektschicht. */
  show(ch) {
    if (ch.type === 'youtube') {
      this.view.showYouTube(ch);
      this.yt.setAudible(true);
    } else {
      this.showVideo(this.active, ch);
    }
  }

  showCard(canvas, ch) {
    this.view.setSource({ kind: 'canvas', el: canvas }, ch ? { blackWhite: !!ch.options?.blackWhite } : {});
  }

  stopVideo(v) {
    try {
      v.pause();
      if (v.getAttribute('src')) {
        v.removeAttribute('src');
        v.load();
      }
    } catch {
      // egal
    }
  }

  stopVideos() {
    this.standbyFor = null;
    for (const v of this.videos) this.stopVideo(v);
    this.yt?.stop();
  }

  resetWatchdog() {
    this.lastTime = -1;
    this.lastAdvance = performance.now();
  }

  async play(v) {
    try {
      // Der Start darf das Umschalten nie unbegrenzt aufhalten; hängt er, greift später der Wächter.
      const started = v.play();
      started.catch(() => {});
      await Promise.race([started, sleep(PLAY_TIMEOUT_MS)]);
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        // Der Browser verbietet Ton ohne Eingabe: stumm starten und um einen Tastendruck bitten.
        this.needsGesture = true;
        for (const video of this.videos) video.muted = true;
        try {
          await v.play();
        } catch {
          // wird vom Wächter erneut versucht
        }
      } else if (err.name !== 'AbortError') {
        throw err;
      }
    }
  }

  /**
   * Anzeige ist unsichtbar (App im Hintergrund, Fenster verdeckt): Wiedergabe anhalten.
   * Die Sendeuhr läuft weiter; beim Zurückkehren wird an die richtige Stelle gesprungen.
   */
  setSuspended(suspended) {
    if (this.suspended === suspended) return;
    this.suspended = suspended;
    if (suspended) {
      for (const v of this.videos) v.pause();
      this.yt?.media.pause();
    } else {
      // Die Sendeuhr ist weitergelaufen: an die aktuelle Stelle springen
      const v = this.media;
      const loc = this.locateNow();
      if (loc && loc.index === this.itemIndex && !this.fault && !this.loading && !this.switching && v.readyState >= 1 && !v.ended) {
        if (Math.abs(v.currentTime - loc.offset) > 0.3) v.currentTime = Math.min(loc.offset, Math.max(0, v.duration - 0.2));
      }
      this.resetWatchdog();
      this.tick();
    }
  }

  /** Nach der ersten Eingabe darf der Ton laufen. */
  unlockAudio() {
    this.yt?.unlock();
    if (!this.needsGesture) return;
    this.needsGesture = false;
    for (const video of this.videos) video.muted = false;
  }

  step(direction) {
    const count = this.channels.length;
    if (!count) return;
    let index = this.channelIndex + direction;
    if (this.settings.wrapChannels === false) index = Math.min(count - 1, Math.max(0, index));
    else index = mod(index, count);
    if (index !== this.channelIndex) this.tune(index);
  }

  /** Sender einstellen – mit Rauschen wie am Drehknopf. */
  async tune(index, options = {}) {
    const count = this.channels.length;
    if (!count) return;
    const token = ++this.token;
    try {
      await this.tuneNow(mod(index, count), token, options);
    } catch (err) {
      if (token !== this.token) return;
      // Sicherheitsnetz: Ein unerwarteter Fehler darf den Fernseher nicht im Rauschen hängen lassen.
      this.log.error(`Fehler beim Umschalten: ${err?.message || err}`);
      this.switching = false;
      this.loading = false;
      this.setFault();
      this.director.endSwitch();
      this.audio.setStatic(0);
    }
  }

  async tuneNow(index, token, { animate = true } = {}) {
    this.channelIndex = index;
    const ch = this.channels[index];
    this.fault = null;
    this.itemIndex = -1;
    this.loading = false;
    this.onChange();
    if (!this.powered) return;

    this.switching = true;
    this.switchStarted = performance.now();
    this.stopVideos();
    this.audio.setTone(false);
    this.audio.setChannelLevel(Number(ch.options?.volume) || 1);
    if (animate) {
      this.director.beginSwitch();
      this.audio.setStatic(1);
    }
    const length = animate ? (Number(this.settings.effects.switchStatic) || 0) * 1000 * rand(0.8, 1.4) : 0;
    const minimum = sleep(length);

    if (ch.type === 'noise') {
      this.view.setSource(null);
      this.director.stayStatic();
      this.audio.setStatic(0.7);
      this.switching = false;
      return;
    }

    if (ch.type === 'youtube' && this.yt && ch.pendingPlaylists?.length) {
      // Inhalt der Playlists bei YouTube erfragen (beim ersten Mal und danach einmal täglich)
      const changed = await this.yt.resolve(ch);
      if (token !== this.token) return;
      if (changed) this.schedules.set(ch.id, buildSchedule(ch.files));
    }
    const schedule = this.schedule(ch);
    let loaded = false;
    if (playable(ch) && schedule.items.length) {
      if (ch.options?.onSwitch === 'restart') {
        this.clock.setPosition(ch.id, schedule.total, 0);
        this.onChange();
      }
      loaded = await this.loadCurrent(token);
      if (token !== this.token) return;
    }
    await minimum;
    if (token !== this.token) return;

    if (ch.type === 'testcard') {
      this.showCard(this.testCanvas, ch);
      this.audio.setTone(true);
    } else if (loaded) {
      this.show(ch);
    } else {
      if (!schedule.items.length) this.log.warn(`Sender „${ch.name}" hat keine abspielbaren Filme.`);
      this.setFault();
    }
    this.director.endSwitch();
    this.audio.setStatic(0);
    this.switching = false;
  }

  /** Lädt den Film, der laut Sendeuhr jetzt läuft (eigenes Video oder YouTube). */
  async loadCurrent(token, attempt = 0) {
    const ch = this.channel;
    const loc = this.locateNow(ch);
    if (!loc) return false;
    this.itemIndex = loc.index;
    this.standbyFor = null;
    this.loading = true;
    const youtube = ch.type === 'youtube';
    try {
      if (youtube) {
        if (!this.yt) throw new Error('YouTube wird in dieser Anzeige nicht unterstützt');
        await this.yt.load(loc.item.youtube, loc.offset, this.clock.paused);
        if (token !== this.token) return false;
        this.needsGesture = this.needsGesture || this.yt.blocked;
        this.noteDuration(ch, loc.index, this.yt.media.duration);
      } else {
        const v = this.active;
        // kleine Zugabe für die Ladezeit, damit das Bild zur Sendeuhr passt
        await loadVideo(v, loc.item.url, loc.offset + (this.clock.paused ? 0 : 0.2));
        if (token !== this.token) return false;
        this.noteDuration(ch, loc.index, v.duration);
        if (!this.clock.paused) await this.play(v);
        if (token !== this.token) return false;
      }
      this.resetWatchdog();
      return true;
    } catch (err) {
      if (token !== this.token) return false;
      this.log.warn(`„${loc.item.name}" lässt sich nicht abspielen: ${err.message}`);
      // Dieses Video geht nicht (gelöscht, privat, Einbetten verboten): zum nächsten brauchbaren weiter
      if (youtube && err.unplayable && attempt < this.schedule(ch).items.length && this.skipUnplayable(ch, loc.index)) {
        return this.loadCurrent(token, attempt + 1);
      }
      return false;
    } finally {
      if (token === this.token) this.loading = false;
    }
  }

  /**
   * Merkt ein nicht abspielbares YouTube-Video und stellt die Sendeuhr auf das nächste brauchbare.
   * Liefert false, wenn es keines gibt.
   */
  skipUnplayable(ch, index) {
    const schedule = this.schedule(ch);
    const count = schedule.items.length;
    const fileAt = (i) => ch.files.find((f) => f.url === schedule.items[i]?.url);
    const file = fileAt(index);
    if (file) file.unplayable = true;
    for (let step = 1; step < count; step++) {
      const next = (index + step) % count;
      if (fileAt(next)?.unplayable) continue;
      this.clock.setPosition(ch.id, schedule.total, schedule.items[next].start);
      this.onChange();
      return true;
    }
    return false;
  }

  /** Fehler des YouTube-Players mitten in der Wiedergabe. */
  onMediaError(err) {
    const ch = this.channel;
    // Während eines Senderwechsels oder Ladevorgangs meldet sich der Fehler dort selbst
    if (ch?.type !== 'youtube' || !this.powered || this.switching || this.loading) return;
    this.log.warn(`YouTube: ${err.message}`);
    if (err.unplayable && !this.skipUnplayable(ch, this.itemIndex)) {
      this.setFault();
      return;
    }
    this.cut({ glitch: false });
  }

  /** Harter Schnitt ohne Senderrauschen (Filmwechsel, Sprung, neuer Versuch). */
  async cut({ glitch = true } = {}) {
    const ch = this.channel;
    if (!playable(ch) || !this.powered) return;
    const token = ++this.token;
    if (glitch) this.director.glitch(0.3, 0.7);
    const loaded = await this.loadCurrent(token);
    if (token !== this.token) return;
    if (loaded) {
      this.fault = null;
      this.show(ch);
    } else {
      this.setFault();
    }
  }

  setFault() {
    this.fault = { index: this.itemIndex, retryAt: performance.now() + FAULT_RETRY_MS };
    this.stopVideos();
    this.showCard(this.faultCanvas, null);
  }

  /** Weicht die tatsächliche Länge von der gemessenen ab, wird der Sendeplan berichtigt. */
  noteDuration(ch, index, duration) {
    const schedule = this.schedule(ch);
    const item = schedule.items[index];
    if (!item || !Number.isFinite(duration) || duration <= 0 || Math.abs(item.duration - duration) < 0.05) return;
    const loc = this.locateNow(ch);
    const file = ch.files.find((f) => f.url === item.url);
    if (!file) return;
    file.duration = duration;
    if (file.youtube) {
      file.guessed = false;
      rememberYouTubeDuration(file.youtube, duration);
    } else {
      this.onDuration(file);
    }
    const rebuilt = buildSchedule(ch.files);
    this.schedules.set(ch.id, rebuilt);
    if (loc && rebuilt.items[loc.index]) {
      const offset = Math.min(loc.offset, rebuilt.items[loc.index].duration - 0.05);
      this.clock.setPosition(ch.id, rebuilt.total, rebuilt.items[loc.index].start + offset);
    }
  }

  /** Film zu Ende: nahtlos zum nächsten wechseln. */
  onEnded(v) {
    if (v !== this.media || this.switching || this.loading || !this.powered || this.clock.paused || this.suspended) return;
    const ch = this.channel;
    if (!playable(ch)) return;
    const schedule = this.schedule(ch);
    const count = schedule.items.length;
    if (!count || this.itemIndex < 0) return;
    const next = (this.itemIndex + 1) % count;
    // War der Film etwas früher zu Ende als im Sendeplan, wird die Sendeuhr auf den Beginn
    // des nächsten Films vorgestellt. Ist sie schon dort, bleibt sie unangetastet –
    // so laufen die Sender auch nach vielen Filmwechseln im Takt.
    const loc = this.locateNow(ch);
    if (loc && loc.index === this.itemIndex && loc.offset > loc.item.duration / 2) {
      this.clock.setPosition(ch.id, schedule.total, schedule.items[next].start);
      this.onChange();
    }

    const sb = this.standby;
    const armed = !v.youtube && this.standbyFor && this.standbyFor.channel === ch.id && this.standbyFor.index === next;
    if (armed && sb.readyState >= 2 && !sb.error) {
      this.activeIdx ^= 1;
      this.itemIndex = next;
      this.standbyFor = null;
      this.showVideo(sb, ch);
      this.play(sb).catch(() => {});
      this.stopVideo(v);
      this.resetWatchdog();
    } else {
      this.cut({ glitch: false });
    }
  }

  armStandby(ch, schedule, index) {
    const next = (index + 1) % schedule.items.length;
    if (this.standbyFor && this.standbyFor.channel === ch.id && this.standbyFor.index === next) return;
    const sb = this.standby;
    this.standbyFor = { channel: ch.id, index: next };
    try {
      sb.pause();
      sb.muted = this.active.muted;
      sb.src = schedule.items[next].url;
      sb.load();
    } catch {
      this.standbyFor = null;
    }
  }

  /** Läuft mehrmals pro Sekunde: Abgleich mit der Sendeuhr und Wächter. */
  tick() {
    if (this.powered && this.switching && performance.now() - this.switchStarted > SWITCH_TIMEOUT_MS) {
      this.log.warn('Umschalten dauert zu lange – neuer Versuch.');
      this.tune(this.channelIndex);
      return;
    }
    if (!this.powered || this.switching || this.loading || this.suspended) return;
    const ch = this.channel;
    if (!playable(ch)) return;
    const schedule = this.schedule(ch);
    const count = schedule.items.length;
    const now = performance.now();

    if (this.fault) {
      const loc = this.locateNow(ch);
      if (count && (now >= this.fault.retryAt || (loc && loc.index !== this.fault.index))) this.cut({ glitch: false });
      else if (now >= this.fault.retryAt) this.fault.retryAt = now + FAULT_RETRY_MS;
      return;
    }
    if (!count) return;

    const v = this.media;
    if (this.clock.paused) {
      if (!v.paused) v.pause();
      this.resetWatchdog();
      return;
    }
    if (v.ended) {
      this.onEnded(v);
      return;
    }
    if (v.live) {
      // Live-Übertragung: läuft einfach, ohne Abgleich mit der Sendeuhr
      this.resetWatchdog();
      return;
    }

    const loc = this.locateNow(ch);
    const left = v.duration - v.currentTime;
    const finishing = Number.isFinite(left) && left < 3 && !v.paused;
    if (loc.index !== this.itemIndex) {
      // Die Sendeuhr ist schon beim nächsten Film – den laufenden noch ausspielen lassen.
      // Bleibt er dabei hängen, wird nach wenigen Sekunden hart umgeschnitten.
      const isNext = loc.index === (this.itemIndex + 1) % count;
      if (!(isNext && finishing && loc.offset < FINISH_GRACE_S)) this.cut();
      return;
    }

    if (v.paused) this.play(v).catch(() => {});

    const drift = v.currentTime - loc.offset;
    const wrapping = count === 1 && finishing && loc.offset < FINISH_GRACE_S;
    if (!wrapping && Math.abs(drift) > MAX_DRIFT_S && !v.seeking && v.readyState >= 1) {
      this.director.glitch(0.2, 0.5);
      v.currentTime = Math.min(loc.offset, Math.max(0, v.duration - 0.2));
      this.resetWatchdog();
    }

    if (!v.youtube && (loc.remaining < PRELOAD_BEFORE_END_S || (Number.isFinite(left) && left < PRELOAD_BEFORE_END_S))) {
      this.armStandby(ch, schedule, this.itemIndex);
    }

    // Wächter: Bleibt das Bild stehen, wird der Sender neu eingestellt.
    if (v.currentTime !== this.lastTime) {
      if (this.lastTime < 0) this.healthySince = now;
      this.lastTime = v.currentTime;
      this.lastAdvance = now;
      if (now - this.healthySince > 30000) this.stalls = 0;
    } else if (now - this.lastAdvance > (v.youtube ? YOUTUBE_STALL_TIMEOUT_MS : STALL_TIMEOUT_MS)) {
      this.stalls++;
      this.log.warn(`Wiedergabe hängt (${this.stalls}. Mal) – Sender wird neu eingestellt.`);
      if (this.stalls >= MAX_STALLS) {
        this.onFatal('Wiedergabe hängt wiederholt');
        return;
      }
      this.tune(this.channelIndex);
    }
  }

  /** Nach einer Änderung der Sendeuhr (Sprung, Neustart) das Bild nachführen. */
  refresh() {
    this.onChange();
    if (!this.powered || this.switching) return;
    const ch = this.channel;
    if (!playable(ch)) return;
    const loc = this.locateNow(ch);
    if (!loc) return;
    const v = this.media;
    this.standbyFor = null;
    if (!this.fault && !this.loading && loc.index === this.itemIndex && v.readyState >= 1 && !v.ended) {
      this.director.glitch(0.25, 0.6);
      v.currentTime = Math.min(loc.offset, Math.max(0, v.duration - 0.2));
      this.resetWatchdog();
    } else {
      this.cut();
    }
  }

  setPaused(paused) {
    if (paused) {
      this.clock.pause();
      this.media.pause();
    } else {
      this.clock.resume();
    }
    this.onChange();
    this.tick();
  }

  seekBy(seconds) {
    const ch = this.channel;
    if (!playable(ch)) return;
    const schedule = this.schedule(ch);
    if (!schedule.total) return;
    this.clock.shift(ch.id, schedule.total, seconds);
    this.refresh();
  }

  restartFilm() {
    const ch = this.channel;
    const loc = this.locateNow(ch);
    if (!loc) return;
    this.clock.setPosition(ch.id, this.schedule(ch).total, loc.item.start);
    this.refresh();
  }

  skipFilm(direction) {
    const ch = this.channel;
    const loc = this.locateNow(ch);
    if (!loc) return;
    const schedule = this.schedule(ch);
    const index = mod(loc.index + direction, schedule.items.length);
    this.clock.setPosition(ch.id, schedule.total, schedule.items[index].start);
    this.refresh();
  }

  restartChannel() {
    const ch = this.channel;
    if (!ch) return;
    const schedule = this.schedule(ch);
    if (!schedule.total) return;
    this.clock.setPosition(ch.id, schedule.total, 0);
    this.refresh();
  }

  restartAll() {
    for (const ch of this.channels) {
      const schedule = this.schedule(ch);
      if (schedule.total) this.clock.setPosition(ch.id, schedule.total, 0);
    }
    this.refresh();
  }

  setPower(on) {
    if (on === this.powered) return;
    this.powered = on;
    if (on) {
      this.director.powerOn();
      this.audio.setPower(true);
      this.tune(this.channelIndex, { animate: false });
    } else {
      this.token++;
      this.switching = false;
      this.loading = false;
      this.fault = null;
      this.director.powerOff();
      this.audio.setPower(false);
      this.audio.setStatic(0);
      this.audio.setTone(false);
      this.stopVideos();
      this.onChange();
    }
  }

  status() {
    const ch = this.channel;
    const loc = playable(ch) ? this.locateNow(ch) : null;
    const schedule = ch ? this.schedule(ch) : null;
    return {
      channelIndex: this.channelIndex,
      channelId: ch?.id ?? null,
      paused: this.clock.paused,
      power: this.powered,
      fault: !!this.fault,
      switching: this.switching,
      needsGesture: this.needsGesture || !!this.yt?.blocked,
      youtube: ch?.type === 'youtube',
      item: loc
        ? {
            index: loc.index,
            count: schedule.items.length,
            name: loc.item.name,
            offset: loc.offset,
            duration: loc.item.duration,
            position: loc.position,
            total: schedule.total,
          }
        : null,
      channels: this.channels.map((c) => {
        const s = this.schedule(c);
        const missing = (c.files?.length || 0) - s.items.length + (c.invalidUrls?.length || 0);
        return { id: c.id, name: c.name, type: c.type, films: s.items.length, total: s.total, missing, pending: c.pendingPlaylists?.length || 0 };
      }),
    };
  }
}
