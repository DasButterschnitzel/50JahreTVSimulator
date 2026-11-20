// WebGL-Darstellung der Bildröhre.
import { VERTEX, SIGNAL_FRAGMENT, BLUR_FRAGMENT, TUBE_FRAGMENT } from './shaders.js';

const SIGNAL_W = 768; // PAL mit quadratischen Pixeln
const SIGNAL_H = 576;
const BLUR_W = 192;
const BLUR_H = 144;
const MASK_TYPES = { none: 0, aperture: 1, slot: 2, dots: 3 };

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const supportsFrameCallback = typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

/** Meldet, sobald ein Video ein neues Bild hat, damit nur dann zur Grafikkarte kopiert wird. */
export function watchVideoFrames(video) {
  video.__frameDirty = true;
  if (!supportsFrameCallback) return;
  const tick = () => {
    video.__frameDirty = true;
    video.requestVideoFrameCallback(tick);
  };
  video.requestVideoFrameCallback(tick);
  for (const ev of ['seeked', 'loadeddata', 'playing']) {
    video.addEventListener(ev, () => (video.__frameDirty = true));
  }
}

export class Renderer {
  constructor(canvas, settings, log = console) {
    this.canvas = canvas;
    this.settings = settings;
    this.log = log;
    this.gl = null;
    this.ok = false;
    this.lost = false;
    this.source = null;
    this.sourceReady = false;
    this.frame = 0;
    this.onFatal = () => {};

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
      this.ok = false;
      this.log.warn('Grafikkontext verloren – warte auf Wiederherstellung.');
      this._lostTimer = setTimeout(() => this.onFatal('Grafikkontext nicht wiederhergestellt'), 10000);
    });
    canvas.addEventListener('webglcontextrestored', () => {
      clearTimeout(this._lostTimer);
      this.lost = false;
      this.log.warn('Grafikkontext wiederhergestellt.');
      this.init();
    });
  }

  init() {
    const attrs = {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    };
    const gl = this.canvas.getContext('webgl2', attrs) || this.canvas.getContext('webgl', attrs);
    if (!gl) {
      this.ok = false;
      return false;
    }
    this.gl = gl;
    try {
      this.programs = {
        signal: this.makeProgram(SIGNAL_FRAGMENT),
        blur: this.makeProgram(BLUR_FRAGMENT),
        tube: this.makeProgram(TUBE_FRAGMENT),
      };
    } catch (err) {
      this.log.error(`Shader-Fehler: ${err.message}`);
      this.ok = false;
      return false;
    }

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    this.srcTex = this.makeTexture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    this.signalA = this.makeTarget(SIGNAL_W, SIGNAL_H);
    this.signalB = this.makeTarget(SIGNAL_W, SIGNAL_H);
    this.blurA = this.makeTarget(BLUR_W, BLUR_H);
    this.blurB = this.makeTarget(BLUR_W, BLUR_H);
    this.sourceReady = false;
    if (this.source) this.source.dirty = true;
    this.ok = true;
    this.resize();
    return true;
  }

  makeProgram(fragmentSource) {
    const gl = this.gl;
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader) || 'Shader lässt sich nicht übersetzen');
      }
      return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
    gl.bindAttribLocation(program, 0, 'aPos');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || 'Shader lässt sich nicht binden');
    }
    const uniforms = {};
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i);
      uniforms[info.name] = gl.getUniformLocation(program, info.name);
    }
    return { program, uniforms };
  }

  makeTexture() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  makeTarget(width, height) {
    const gl = this.gl;
    const tex = this.makeTexture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, width, height };
  }

  applySettings(settings) {
    this.settings = settings;
    this.resize();
  }

  resize() {
    const scale = Math.min(1, Math.max(0.25, Number(this.settings.effects.renderScale) || 1));
    const dpr = (window.devicePixelRatio || 1) * scale;
    const width = Math.max(2, Math.round(this.canvas.clientWidth * dpr));
    const height = Math.max(2, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  /**
   * Bildquelle setzen: { kind: 'video', el } | { kind: 'canvas', el } | null.
   * options: { fit, blackWhite }
   */
  setSource(source, options = {}) {
    this.sourceOptions = options;
    if (source && this.source && this.source.el === source.el) {
      // gleiche Quelle, nur neue Optionen: das vorhandene Bild bleibt gültig
      this.source.dirty = true;
      return;
    }
    this.source = source ? { ...source, dirty: true, lastUpload: 0 } : null;
    this.sourceReady = false;
  }

  markSourceDirty() {
    if (this.source) this.source.dirty = true;
  }

  uploadSource(nowMs) {
    const gl = this.gl;
    const src = this.source;
    if (!src) return;
    let ready = false;
    let dirty = src.dirty;
    if (src.kind === 'video') {
      const v = src.el;
      ready = v.readyState >= 2 && v.videoWidth > 0;
      if (v.__frameDirty || !supportsFrameCallback) dirty = true;
      // Sicherheitsnetz, falls ein Bildwechsel nicht gemeldet wurde
      if (nowMs - src.lastUpload > 500) dirty = true;
    } else {
      ready = src.el.width > 0;
    }
    if (!ready || !dirty) return;
    try {
      gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src.el);
      src.dirty = false;
      src.lastUpload = nowMs;
      if (src.kind === 'video') src.el.__frameDirty = false;
      this.sourceReady = true;
    } catch (err) {
      if (!this._uploadWarned) {
        this._uploadWarned = true;
        this.log.warn(`Videobild konnte nicht übernommen werden: ${err.message}`);
      }
    }
  }

  sourceSize() {
    const src = this.source;
    if (!src) return [4, 3];
    if (src.kind === 'video') return [src.el.videoWidth || 4, src.el.videoHeight || 3];
    return [src.el.width || 4, src.el.height || 3];
  }

  /** Bildausschnitt: Wie wird die Quelle in die 4:3-Röhre eingepasst? */
  sourceMap() {
    const screen = this.settings.screen;
    const tubeAspect = Number(screen.aspect) || 4 / 3;
    const [sw, sh] = this.sourceSize();
    const sourceAspect = sw / sh;
    const fit = this.sourceOptions?.fit || this.settings.video.fit || 'fill';
    let sx = 1;
    let sy = 1;
    if (this.source?.kind === 'canvas' || fit === 'stretch') {
      // Testbild und "stretch" füllen die Röhre immer ganz
    } else if (fit === 'fit') {
      if (sourceAspect > tubeAspect) sy = sourceAspect / tubeAspect;
      else sx = tubeAspect / sourceAspect;
    } else if (sourceAspect > tubeAspect) {
      sx = tubeAspect / sourceAspect;
    } else {
      sy = sourceAspect / tubeAspect;
    }
    const zoom = 1 - Math.min(0.3, Math.max(0, Number(screen.overscan) || 0));
    return [sx * zoom, sy * zoom, 0, 0];
  }

  /** Lage der Röhre auf dem Monitor in Pixeln. */
  tubeRect() {
    const screen = this.settings.screen;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const angle = ((Number(screen.rotate) || 0) * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const w = (Number(screen.aspect) || 4 / 3) * (Number(screen.stretchX) || 1);
    const boxW = Math.abs(cos) * w + Math.abs(sin);
    const boxH = Math.abs(sin) * w + Math.abs(cos);
    const k = Math.min(W / boxW, H / boxH) * (Number(screen.scale) || 1);
    const cx = W / 2 + (Number(screen.x) || 0) * H;
    const cy = H / 2 + (Number(screen.y) || 0) * H;
    return { cx, cy: H - cy, hw: (w * k) / 2, hh: k / 2, cos, sin };
  }

  /**
   * Ein Bild zeichnen.
   * dyn: Werte der Animationen { static, roll, skew, jitter, noise, gain, collapseX, collapseY, dot }
   */
  render(timeSec, dyn, dt = 1 / 60) {
    if (!this.ok || this.lost) return;
    const gl = this.gl;
    const fx = this.settings.effects;
    const on = fx.enabled !== false;
    const nowMs = performance.now();
    this.frame++;
    this.uploadSource(nowMs);

    const seed = Math.random() * 64;
    const t = timeSec % 3600;
    const bw = fx.blackWhite || this.sourceOptions?.blackWhite ? 1 : 0;

    // 1. Signal
    const sig = this.programs.signal;
    const target = this.signalA;
    const prev = this.signalB;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.width, target.height);
    gl.useProgram(sig.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, prev.tex);
    const su = sig.uniforms;
    gl.uniform1i(su.uSrc, 0);
    gl.uniform1i(su.uPrev, 1);
    gl.uniform2f(su.uRes, target.width, target.height);
    const map = this.sourceMap();
    gl.uniform4f(su.uSrcMap, map[0], map[1], map[2], map[3]);
    gl.uniform1f(su.uHasSrc, this.source && this.sourceReady ? 1 : 0);
    gl.uniform1f(su.uSeed, seed);
    gl.uniform1f(su.uTime, t);
    gl.uniform1f(su.uStatic, dyn.static);
    gl.uniform1f(su.uRoll, dyn.roll);
    gl.uniform1f(su.uSkew, dyn.skew);
    gl.uniform1f(su.uNoise, on ? fx.noise + dyn.noise : 0);
    gl.uniform1f(su.uColorNoise, on ? fx.colorNoise + dyn.noise * 0.5 : 0);
    gl.uniform1f(su.uJitter, on ? fx.jitter + dyn.jitter : 0);
    gl.uniform1f(su.uWobble, on ? fx.wobble : 0);
    gl.uniform1f(su.uGhost, on ? fx.ghost : 0);
    gl.uniform1f(su.uChroma, on ? fx.chroma : 0);
    gl.uniform1f(su.uSoft, on ? fx.softness : 0);
    gl.uniform1f(su.uHum, on ? fx.hum : 0);
    gl.uniform1f(su.uSat, on ? fx.saturation : 1);
    gl.uniform1f(su.uContrast, on ? fx.contrast : 1);
    gl.uniform1f(su.uBright, on ? fx.brightness : 1);
    gl.uniform1f(su.uWarm, on ? fx.warmth : 0);
    gl.uniform1f(su.uBW, bw);
    // Nachleuchten ist auf 60 Bilder/s bezogen, damit es bei jeder Bildrate gleich lang wirkt
    const persist = on ? Math.pow(Math.min(0.95, Math.max(0, fx.persistence)), Math.min(8, Math.max(0.25, dt * 60))) : 0;
    gl.uniform1f(su.uPersist, persist);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.signalA = prev;
    this.signalB = target;

    // 2. Weichzeichner für das Überstrahlen
    const halation = on ? fx.halation : 0;
    if (halation > 0) {
      const blur = this.programs.blur;
      gl.useProgram(blur.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(blur.uniforms.uTex, 0);
      gl.viewport(0, 0, BLUR_W, BLUR_H);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.blurA.fbo);
      gl.bindTexture(gl.TEXTURE_2D, target.tex);
      gl.uniform2f(blur.uniforms.uDir, 1.6 / BLUR_W, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.blurB.fbo);
      gl.bindTexture(gl.TEXTURE_2D, this.blurA.tex);
      gl.uniform2f(blur.uniforms.uDir, 0, 1.6 / BLUR_H);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // 3. Bildröhre
    const tube = this.programs.tube;
    const tu = tube.uniforms;
    const rect = this.tubeRect();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(tube.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.blurB.tex);
    gl.uniform1i(tu.uSignal, 0);
    gl.uniform1i(tu.uBlur, 1);
    gl.uniform2f(tu.uCenter, rect.cx, rect.cy);
    gl.uniform2f(tu.uHalf, rect.hw, rect.hh);
    gl.uniform2f(tu.uRot, rect.cos, rect.sin);
    const lines = Math.max(60, Number(fx.scanlineCount) || 288);
    const pxPerLine = (rect.hh * 2) / lines;
    // Zu feine Zeilen würden mit dem Pixelraster des Monitors Muster bilden
    const scanFade = Math.min(1, Math.max(0, (pxPerLine - 1.6) / 1.4));
    gl.uniform1f(tu.uLines, on ? lines : SIGNAL_H);
    gl.uniform1f(tu.uField, on && fx.interlace ? (this.frame % 2) * 0.5 : 0);
    gl.uniform1f(tu.uCurv, on ? fx.curvature * 0.16 : 0);
    gl.uniform1f(tu.uCorner, on ? Math.min(0.6, Math.max(0.001, fx.cornerRadius)) : 0.001);
    gl.uniform1f(tu.uEdgeShadow, on ? fx.edgeShadow : 0);
    gl.uniform1f(tu.uScan, on ? fx.scanlines * scanFade : 0);
    gl.uniform1f(tu.uMask, on ? Math.min(0.9, fx.mask) : 0);
    gl.uniform1f(tu.uMaskType, MASK_TYPES[fx.maskType] ?? 2);
    gl.uniform1f(tu.uMaskScale, Math.max(1, Math.round(Number(fx.maskScale) || 1)));
    gl.uniform1f(tu.uHalation, halation);
    gl.uniform1f(tu.uVignette, on ? fx.vignette : 0);
    gl.uniform1f(tu.uReflect, on ? fx.reflection : 0);
    gl.uniform1f(tu.uAmbient, on ? fx.ambient : 0);
    const flicker = on ? 1 + (Math.random() - 0.5) * 2 * fx.flicker : 1;
    gl.uniform1f(tu.uGain, dyn.gain * flicker);
    gl.uniform2f(tu.uCollapse, dyn.collapseX, dyn.collapseY);
    gl.uniform1f(tu.uDot, dyn.dot);
    gl.uniform1f(tu.uSeed, seed);
    const bg = hexToRgb(this.settings.screen.background);
    gl.uniform3f(tu.uBg, bg[0], bg[1], bg[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
