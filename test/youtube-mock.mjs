// Nachbau des YouTube-Players für die Browser-Tests.
// YouTube selbst ist im Testlauf weder erreichbar noch verlässlich; der Nachbau spielt
// stattdessen Testfilme ab und bietet dieselben Aufrufe, die youtube.js benutzt.
// Geprüft wird damit unsere Steuerlogik – nicht das Verhalten des echten YouTube.

const API = `
(() => {
  const STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
  class Player {
    constructor(el, opts) {
      this.opts = opts;
      this.state = STATE.UNSTARTED;
      this.list = [];
      this.calls = [];
      const frame = document.createElement('iframe');
      frame.allow = 'autoplay';
      frame.src = location.origin + '/__ytmock';
      el.replaceWith(frame);
      frame.addEventListener('load', () => {
        const video = (this.video = frame.contentDocument.querySelector('video'));
        video.addEventListener('playing', () => video.getAttribute('src') && this.setState(STATE.PLAYING));
        video.addEventListener('pause', () => !video.ended && video.getAttribute('src') && this.setState(STATE.PAUSED));
        video.addEventListener('ended', () => this.setState(STATE.ENDED));
        opts.events.onReady({ target: this });
      });
      window.__ytPlayers.push(this);
    }
    setState(state) {
      this.state = state;
      this.opts.events.onStateChange({ data: state, target: this });
    }
    load(request, play) {
      this.calls.push([play ? 'loadVideoById' : 'cueVideoById', request.videoId, Math.round(request.startSeconds)]);
      this.id = request.videoId;
      const seq = (this.seq = (this.seq || 0) + 1);
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
      this.state = STATE.UNSTARTED;
      const src = window.__ytMock.videos[request.videoId];
      if (!src) {
        setTimeout(() => seq === this.seq && this.opts.events.onError({ data: request.videoId.startsWith('NOEMBED') ? 150 : 100, target: this }), 60);
        return;
      }
      const video = this.video;
      video.src = src;
      video.addEventListener('loadedmetadata', () => {
        if (seq !== this.seq) return;
        video.currentTime = Math.min(request.startSeconds || 0, Math.max(0, video.duration - 0.05));
        if (play) video.play().catch(() => {});
        else this.setState(STATE.CUED);
      }, { once: true });
    }
    loadVideoById(request) { this.load(request, true); }
    cueVideoById(request) { this.load(request, false); }
    cuePlaylist(request) {
      this.list = window.__ytMock.playlists[request.list] || [];
      setTimeout(() => this.setState(STATE.CUED), 60);
    }
    getPlaylist() { return this.list; }
    playVideo() { if (this.video.getAttribute('src')) this.video.play().catch(() => {}); }
    pauseVideo() { this.video.pause(); }
    stopVideo() { this.video.pause(); this.video.removeAttribute('src'); this.video.load(); this.state = STATE.UNSTARTED; }
    seekTo(seconds) { this.calls.push(['seekTo', Math.round(seconds)]); this.video.currentTime = seconds; }
    getCurrentTime() { return this.video.currentTime; }
    getDuration() { return Number.isFinite(this.video.duration) ? this.video.duration : 0; }
    getPlayerState() { return this.state; }
    setVolume(value) { this.volume = value; this.video.volume = value / 100; }
    mute() { this.mutedFlag = true; this.video.muted = true; }
    unMute() { this.mutedFlag = false; this.video.muted = false; }
    getVideoData() { return { video_id: this.id, title: 'Nachbau ' + this.id, isLive: false }; }
  }
  window.__ytPlayers = [];
  window.YT = { Player, PlayerState: STATE };
  setTimeout(() => window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady(), 30);
})();
`;

const PAGE = `<!doctype html><html><body style="margin:0;background:#000;overflow:hidden">
<video playsinline style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain"></video></body></html>`;

/** Leitet YouTubes Skript auf den Nachbau um. videos: Kennung -> Adresse eines Testfilms. */
export async function installYouTubeMock(page, { videos, playlists = {} }) {
  await page.addInitScript((data) => (window.__ytMock = data), { videos, playlists });
  await page.route('https://www.youtube.com/iframe_api', (route) => route.fulfill({ contentType: 'text/javascript', body: API }));
  await page.route('**/__ytmock', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }));
}
