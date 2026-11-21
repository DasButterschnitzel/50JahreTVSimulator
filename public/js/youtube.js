// YouTube-Sender: Videos und Playlists von YouTube als Programm.
//
// Der YouTube-Player ist ein abgeschotteter Fremdrahmen (iframe); sein Bild lässt sich nicht
// durch den Röhren-Shader schicken. Deshalb liegt das YouTube-Bild unter einer eigenen
// Effektschicht (overlay.js) und bekommt Wölbung und Farbe über Filter des Browsers.
//
// Für die Sendeuhr verhält sich ein YouTube-Video wie ein Film: Längen werden beim ersten
// Abspielen gelernt und gemerkt; bis dahin gilt ein Schätzwert.

const API_URL = 'https://www.youtube.com/iframe_api';
const PLAYER_HOST = 'https://www.youtube-nocookie.com'; // "erweiterter Datenschutzmodus" von YouTube
const DURATIONS_KEY = 'tv77.yt.durations';
const PLAYLISTS_KEY = 'tv77.yt.playlists';
const TITLES_KEY = 'tv77.yt.titles';
const PLAYLIST_MAX_AGE_MS = 24 * 3600 * 1000;
const API_TIMEOUT_MS = 15000;
const LOAD_TIMEOUT_MS = 20000;
const BLOCKED_AFTER_MS = 4000;
const SEEK_SETTLE_MS = 8000;
export const GUESSED_DURATION_S = 240;

const STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
const ERROR_TEXT = {
  2: 'ungültige Video-Adresse',
  5: 'Video lässt sich in diesem Browser nicht abspielen',
  100: 'Video nicht gefunden oder privat',
  101: 'Einbetten vom Besitzer nicht erlaubt',
  150: 'Einbetten vom Besitzer nicht erlaubt',
  153: 'YouTube verlangt eine Herkunftsangabe der Seite',
};

const ID = /^[A-Za-z0-9_-]{11}$/;
const LIST_ID = /^[A-Za-z0-9_-]{12,}$/;

function parseStart(value) {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Number(value);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(value);
  return m ? Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0) : 0;
}

/**
 * Versteht die üblichen YouTube-Adressen.
 * Liefert { video } oder { playlist } (jeweils die Kennung) oder null.
 */
export function parseYouTubeUrl(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (ID.test(raw)) return { video: raw };
  if (/^(PL|UU|FL|OL)[A-Za-z0-9_-]{10,}$/.test(raw)) return { playlist: raw };
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www\.|m\.|music\.)/, '');
  const list = url.searchParams.get('list');
  // automatische Mixe und private Listen (Später ansehen, Likes) lassen sich nicht einbetten
  const usableList = list && LIST_ID.test(list) && !/^(RD|WL|LL|LM)/.test(list) ? list : null;
  const start = parseStart(url.searchParams.get('t') || url.searchParams.get('start'));
  let video = null;
  if (host === 'youtu.be') {
    video = url.pathname.slice(1).split('/')[0];
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'playlist') return usableList ? { playlist: usableList } : null;
    if (parts[0] === 'watch') video = url.searchParams.get('v');
    else if (['embed', 'shorts', 'live', 'v'].includes(parts[0])) video = parts[1];
  } else {
    return null;
  }
  if (usableList) return { playlist: usableList };
  if (video && ID.test(video)) return start ? { video, start } : { video };
  return null;
}

function readStore(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || '{}') || {};
  } catch {
    return {};
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ohne Speicher wird beim nächsten Start neu gelernt
  }
}

const fileFor = (id, durations, titles) => ({
  url: `yt:${id}`,
  youtube: id,
  name: titles[id] || `YouTube ${id}`,
  duration: durations[id] > 0 ? durations[id] : GUESSED_DURATION_S,
  guessed: !(durations[id] > 0),
});

/**
 * Macht aus den Adressen eines YouTube-Senders die Filmliste für den Sendeplan.
 * Playlists, deren Inhalt noch nicht bekannt ist, stehen danach in ch.pendingPlaylists.
 */
export function prepareYouTubeChannel(ch) {
  const durations = readStore(DURATIONS_KEY);
  const titles = readStore(TITLES_KEY);
  const playlists = readStore(PLAYLISTS_KEY);
  const files = [];
  const pending = [];
  const invalid = [];
  for (const entry of Array.isArray(ch.options?.urls) ? ch.options.urls : []) {
    const parsed = parseYouTubeUrl(entry);
    if (!parsed) {
      if (String(entry).trim()) invalid.push(String(entry));
    } else if (parsed.video) {
      files.push(fileFor(parsed.video, durations, titles));
    } else {
      const known = playlists[parsed.playlist];
      if (known?.ids?.length) for (const id of known.ids) files.push(fileFor(id, durations, titles));
      if (!known?.ids?.length || Date.now() - (known.at || 0) > PLAYLIST_MAX_AGE_MS) pending.push(parsed.playlist);
    }
  }
  ch.files = files;
  ch.pendingPlaylists = pending;
  ch.invalidUrls = invalid;
  return ch;
}

export function rememberYouTubeDuration(id, duration) {
  const durations = readStore(DURATIONS_KEY);
  durations[id] = Math.round(duration * 100) / 100;
  writeStore(DURATIONS_KEY, durations);
}

function rememberTitle(id, title) {
  const titles = readStore(TITLES_KEY);
  if (titles[id] === title) return;
  titles[id] = title;
  writeStore(TITLES_KEY, titles);
}

/** Der eine YouTube-Player der Anzeige samt Einpassung in die Bildröhre. */
export class YouTubeDeck {
  constructor({ container, log = console, onEnded = () => {}, onError = () => {} }) {
    this.container = container;
    this.log = log;
    this.onEnded = onEnded;
    this.onError = onError;
    this.player = null;
    this.apiPromise = null;
    this.readyPromise = null;
    this.state = STATE.UNSTARTED;
    this.videoId = null;
    this.blocked = false;
    this.volume = 0.8;
    this.muted = false;
    this.audible = false;
    this.seekedAt = 0;
    this.waiters = new Set();
    this.inner = document.createElement('div');
    this.inner.className = 'yt-inner';
    this.container.appendChild(this.inner);
    this.media = this.makeMedia();
  }

  /** Sieht für den Player (player.js) aus wie ein Videoelement. */
  makeMedia() {
    const deck = this;
    return {
      youtube: true,
      get currentTime() {
        return deck.call('getCurrentTime') || 0;
      },
      set currentTime(seconds) {
        deck.seekedAt = performance.now();
        deck.call('seekTo', Math.max(0, seconds), true);
      },
      get duration() {
        const d = deck.call('getDuration');
        return d > 0 ? d : NaN;
      },
      /** Live-Übertragung: hat keine Länge und folgt nicht der Sendeuhr. */
      get live() {
        if (deck.state !== STATE.PLAYING && deck.state !== STATE.BUFFERING) return false;
        if (deck.call('getVideoData')?.isLive) return true;
        return deck.playingSince > 0 && performance.now() - deck.playingSince > 5000 && !(deck.call('getDuration') > 0);
      },
      get ended() {
        return deck.state === STATE.ENDED;
      },
      get paused() {
        return deck.state !== STATE.PLAYING && deck.state !== STATE.BUFFERING;
      },
      get readyState() {
        return deck.videoId && [STATE.PLAYING, STATE.PAUSED, STATE.BUFFERING, STATE.CUED].includes(deck.state) ? 4 : 0;
      },
      /** Nach einem Sprung und beim Puffern nicht gleich wieder springen. */
      get seeking() {
        return deck.state !== STATE.PLAYING || performance.now() - deck.seekedAt < SEEK_SETTLE_MS;
      },
      get muted() {
        return deck.muted;
      },
      pause() {
        deck.call('pauseVideo');
      },
      play() {
        deck.call('playVideo');
        return Promise.resolve();
      },
    };
  }

  call(method, ...args) {
    const p = this.player;
    if (!p || !this.isReady || typeof p[method] !== 'function') return undefined;
    try {
      return p[method](...args);
    } catch {
      return undefined;
    }
  }

  loadApi() {
    if (window.YT?.Player) return Promise.resolve();
    if (this.apiPromise) return this.apiPromise;
    this.apiPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('YouTube ist nicht erreichbar (keine Internetverbindung?)')), API_TIMEOUT_MS);
      const fail = (err) => {
        clearTimeout(timer);
        this.apiPromise = null;
        script.remove();
        reject(err);
      };
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        clearTimeout(timer);
        if (typeof previous === 'function') previous();
        resolve();
      };
      const script = document.createElement('script');
      script.src = API_URL;
      script.async = true;
      script.onerror = () => fail(new Error('YouTube ist nicht erreichbar (keine Internetverbindung?)'));
      document.head.appendChild(script);
    });
    return this.apiPromise;
  }

  /** Lädt YouTubes Programmierschnittstelle und legt den Player an. */
  ready() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.loadApi()
      .then(
        () =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('YouTube-Player startet nicht')), API_TIMEOUT_MS);
            const mount = document.createElement('div');
            this.inner.replaceChildren(mount);
            this.player = new window.YT.Player(mount, {
              host: PLAYER_HOST,
              width: '100%',
              height: '100%',
              playerVars: { autoplay: 1, controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, rel: 0, playsinline: 1, modestbranding: 1, enablejsapi: 1, origin: location.origin },
              events: {
                onReady: () => {
                  clearTimeout(timer);
                  this.isReady = true;
                  this.applyVolume();
                  resolve();
                },
                onStateChange: (e) => this.onState(e.data),
                onError: (e) => this.onPlayerError(e.data),
              },
            });
          })
      )
      .catch((err) => {
        this.readyPromise = null;
        this.isReady = false;
        this.player = null;
        throw err;
      });
    return this.readyPromise;
  }

  onState(state) {
    this.state = state;
    if (state === STATE.PLAYING) {
      if (!this.playingSince) this.playingSince = performance.now();
      this.blocked = false;
      const data = this.call('getVideoData');
      if (data?.title && data.video_id) rememberTitle(data.video_id, data.title);
    }
    for (const waiter of [...this.waiters]) waiter.state(state);
    if (state === STATE.ENDED && !this.waiters.size) this.onEnded(this.media);
  }

  onPlayerError(code) {
    const err = Object.assign(new Error(ERROR_TEXT[code] || `YouTube-Fehler ${code}`), { code, videoId: this.videoId, unplayable: [2, 5, 100, 101, 150, 153].includes(code) });
    if (this.waiters.size) {
      for (const waiter of [...this.waiters]) waiter.error(err);
    } else {
      // Fehler ohne laufenden Ladevorgang merken: Ein gleichzeitig endendes load() meldet ihn dann selbst
      this.failed = err;
      this.onError(err);
    }
  }

  /** Wartet auf einen der Zustände; bricht bei Fehler oder nach der Frist ab. */
  waitFor(states, timeoutMs, { settleOnTimeout = false, accept = () => true } = {}) {
    return new Promise((resolve, reject) => {
      const waiter = {
        state: (s, forced) => {
          if (states.includes(s) && (forced || accept())) done(resolve, s);
        },
        error: (err) => done(reject, err),
      };
      const timer = setTimeout(() => (settleOnTimeout ? done(resolve, null) : done(reject, new Error('YouTube antwortet nicht'))), timeoutMs);
      const done = (fn, value) => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
        fn(value);
      };
      this.waiters.add(waiter);
    });
  }

  /** Inhalt einer Playlist ermitteln (Liste der Video-Kennungen). */
  async resolvePlaylist(listId) {
    await this.ready();
    this.call('mute');
    const cued = this.waitFor([STATE.CUED], API_TIMEOUT_MS);
    this.call('cuePlaylist', { listType: 'playlist', list: listId });
    await cued;
    const ids = (this.call('getPlaylist') || []).filter((id) => ID.test(id));
    if (!ids.length) throw new Error('Playlist ist leer oder nicht öffentlich');
    const playlists = readStore(PLAYLISTS_KEY);
    playlists[listId] = { ids, at: Date.now() };
    writeStore(PLAYLISTS_KEY, playlists);
    return ids;
  }

  /** Noch unbekannte Playlists eines Senders auflösen; true, wenn sich die Filmliste geändert hat. */
  async resolve(ch) {
    if (!ch.pendingPlaylists?.length) return false;
    const before = JSON.stringify(ch.files.map((f) => f.youtube));
    for (const listId of [...ch.pendingPlaylists]) {
      try {
        await this.resolvePlaylist(listId);
      } catch (err) {
        this.log.warn(`YouTube-Playlist ${listId}: ${err.message}`);
        // eine früher gemerkte Fassung der Liste bleibt in Gebrauch
        const playlists = readStore(PLAYLISTS_KEY);
        if (playlists[listId]) {
          playlists[listId].at = Date.now() - PLAYLIST_MAX_AGE_MS + 600000; // in zehn Minuten erneut versuchen
          writeStore(PLAYLISTS_KEY, playlists);
        }
      }
    }
    prepareYouTubeChannel(ch);
    return JSON.stringify(ch.files.map((f) => f.youtube)) !== before;
  }

  /** Video laden und an die Stelle offset springen; kehrt zurück, sobald es läuft (oder bereitsteht, wenn pausiert). */
  async load(videoId, offset, paused) {
    await this.ready();
    this.videoId = videoId;
    this.failed = null;
    this.playingSince = 0;
    this.blocked = false;
    this.seekedAt = performance.now();
    // Meldungen eines vorher geladenen Videos dürfen nicht als Start des neuen gelten
    const accept = () => {
      const current = this.call('getVideoData')?.video_id;
      return !current || current === videoId;
    };
    const check = () => {
      if (this.failed && this.failed.videoId === videoId) throw this.failed;
    };
    this.audible = false;
    this.applyVolume();
    const request = { videoId, startSeconds: Math.max(0, offset) };
    if (paused) {
      const cued = this.waitFor([STATE.CUED, STATE.PAUSED, STATE.PLAYING], LOAD_TIMEOUT_MS, { accept });
      this.call('cueVideoById', request);
      await cued;
      check();
      return;
    }
    const started = this.waitFor([STATE.PLAYING], LOAD_TIMEOUT_MS, { accept });
    // Startet nichts, sperrt vermutlich der Browser die automatische Wiedergabe
    const blockedTimer = setTimeout(() => {
      if (this.state === STATE.UNSTARTED || this.state === STATE.CUED) {
        this.blocked = true;
        for (const waiter of [...this.waiters]) waiter.state(STATE.PLAYING, true);
      }
    }, BLOCKED_AFTER_MS);
    this.call('loadVideoById', request);
    try {
      await started;
    } finally {
      clearTimeout(blockedTimer);
    }
    check();
  }

  stop() {
    this.videoId = null;
    this.playingSince = 0;
    this.audible = false;
    this.call('stopVideo');
    this.state = STATE.UNSTARTED;
  }

  /** Nach einer Eingabe des Benutzers darf die Wiedergabe starten. */
  unlock() {
    if (!this.blocked) return;
    this.blocked = false;
    this.call('playVideo');
  }

  setVolume(volume, muted) {
    this.volume = volume;
    this.muted = !!muted;
    this.applyVolume();
  }

  /** Während des Senderrauschens bleibt YouTube stumm. */
  setAudible(audible) {
    this.audible = audible;
    this.applyVolume();
  }

  applyVolume() {
    if (!this.isReady) return;
    const silent = this.muted || !this.audible || this.volume <= 0;
    this.call(silent ? 'mute' : 'unMute');
    // gleiche Kennlinie wie der Ton der eigenen Filme
    this.call('setVolume', Math.round(Math.min(1, Math.max(0, this.volume)) ** 2 * 100));
  }

  /**
   * Player in die Bildröhre einpassen.
   * rect: Mitte und halbe Größe in CSS-Pixeln, Drehung in Grad.
   */
  layout(rect, settings, options = {}) {
    const fx = settings.effects;
    const on = fx.enabled !== false;
    const style = this.container.style;
    const width = rect.hw * 2;
    const height = rect.hh * 2;
    style.left = `${rect.cx - rect.hw}px`;
    style.top = `${rect.cy - rect.hh}px`;
    style.width = `${width}px`;
    style.height = `${height}px`;
    style.transform = rect.angle ? `rotate(${rect.angle}deg)` : '';

    // YouTube liefert 16:9; Einpassen wie bei den eigenen Filmen
    const fit = options.fit || settings.video.fit || 'fill';
    const zoom = 1 / (1 - Math.min(0.3, Math.max(0, Number(settings.screen.overscan) || 0)));
    const wide = Math.max(width, (height * 16) / 9);
    const inner = this.inner.style;
    const innerWidth = fit === 'fit' ? width : wide;
    inner.width = `${innerWidth}px`;
    inner.height = `${height}px`;
    inner.left = `${(width - innerWidth) / 2}px`;
    inner.top = '0';
    inner.transform = `scale(${fit === 'stretch' ? (width / wide) * zoom : zoom}, ${zoom})`;

    const filters = [];
    const curvature = on ? Number(fx.curvature) * 0.16 : 0;
    if (curvature > 0 && settings.youtube?.warp !== false) {
      this.updateWarp(width, height, curvature);
      filters.push('url(#yt-warp)');
    }
    if (on) {
      const bw = fx.blackWhite || options.blackWhite;
      if (bw) filters.push('grayscale(1)');
      else if (fx.saturation !== 1) filters.push(`saturate(${fx.saturation})`);
      if (fx.contrast !== 1) filters.push(`contrast(${fx.contrast})`);
      if (fx.brightness !== 1) filters.push(`brightness(${fx.brightness})`);
      if (fx.warmth > 0) filters.push(`sepia(${Math.min(1, fx.warmth * 0.35)})`);
      const blur = (Number(fx.softness) || 0) * 0.0009 * height;
      if (blur > 0.2) filters.push(`blur(${blur.toFixed(2)}px)`);
    }
    style.filter = filters.join(' ');
  }

  /** Wölbung: Der Browser verschiebt die Bildpunkte nach einer Verschiebungskarte (wie der Shader). */
  updateWarp(width, height, k) {
    const key = `${Math.round(width)}x${Math.round(height)}:${k.toFixed(4)}`;
    if (this.warpKey === key) return;
    this.warpKey = key;
    const mw = 96;
    const mh = 72;
    const canvas = document.createElement('canvas');
    canvas.width = mw;
    canvas.height = mh;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(mw, mh);
    const scale = Math.max(2, 2 * k * Math.max(width, height) * 0.5);
    for (let j = 0; j < mh; j++) {
      for (let i = 0; i < mw; i++) {
        const px = ((i + 0.5) / mw) * 2 - 1;
        const py = ((j + 0.5) / mh) * 2 - 1;
        const dx = px * k * py * py * (width / 2);
        const dy = py * k * px * px * (height / 2);
        const o = (j * mw + i) * 4;
        image.data[o] = Math.round(Math.min(1, Math.max(0, 0.5 + dx / scale)) * 255);
        image.data[o + 1] = Math.round(Math.min(1, Math.max(0, 0.5 + dy / scale)) * 255);
        image.data[o + 2] = 0;
        image.data[o + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    const ns = 'http://www.w3.org/2000/svg';
    let svg = document.getElementById('yt-filters');
    if (!svg) {
      svg = document.createElementNS(ns, 'svg');
      svg.id = 'yt-filters';
      svg.setAttribute('width', '0');
      svg.setAttribute('height', '0');
      svg.style.position = 'absolute';
      document.body.appendChild(svg);
    }
    svg.innerHTML =
      `<filter id="yt-warp" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">` +
      `<feImage href="${canvas.toDataURL('image/png')}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="none" result="map"/>` +
      `<feDisplacementMap in="SourceGraphic" in2="map" scale="${scale}" xChannelSelector="R" yChannelSelector="G"/>` +
      `</filter>`;
  }
}
