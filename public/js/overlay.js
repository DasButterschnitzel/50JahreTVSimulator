// Effektschicht über dem YouTube-Player: dieselbe Bildröhre wie im Renderer, aber ohne
// eigenes Bild – Röhrenform, Zeilen, Maske, Glas, Rauschen, Schnee beim Umschalten und
// die Ein-/Ausschaltanimation werden durchsichtig über das YouTube-Bild gelegt.
import { VERTEX, OVERLAY_FRAGMENT } from './shaders.js';
import { computeTubeRect, hexToRgb, MASK_TYPES } from './renderer.js';

export class Overlay {
  constructor(canvas, settings, log = console) {
    this.canvas = canvas;
    this.settings = settings;
    this.log = log;
    this.gl = null;
    this.ok = false;
    this.tried = false;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.ok = false;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.tried = false;
      this.init();
    });
  }

  /** Wird erst beim ersten YouTube-Sender aufgerufen, damit sonst kein zweiter Grafikkontext nötig ist. */
  init() {
    if (this.tried) return this.ok;
    this.tried = true;
    const attrs = { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' };
    const gl = this.canvas.getContext('webgl2', attrs) || this.canvas.getContext('webgl', attrs);
    if (!gl) return false;
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'Shader lässt sich nicht übersetzen');
      return shader;
    };
    try {
      const program = gl.createProgram();
      gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, OVERLAY_FRAGMENT));
      gl.bindAttribLocation(program, 0, 'aPos');
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Shader lässt sich nicht binden');
      this.uniforms = {};
      const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < count; i++) {
        const info = gl.getActiveUniform(program, i);
        this.uniforms[info.name] = gl.getUniformLocation(program, info.name);
      }
      gl.useProgram(program);
    } catch (err) {
      this.log.warn(`Effektschicht für YouTube nicht verfügbar: ${err.message}`);
      return false;
    }
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    this.gl = gl;
    this.ok = true;
    return true;
  }

  applySettings(settings) {
    this.settings = settings;
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

  render(timeSec, dyn) {
    if (!this.ok) return;
    this.resize();
    const gl = this.gl;
    const u = this.uniforms;
    const fx = this.settings.effects;
    const on = fx.enabled !== false;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const rect = computeTubeRect(this.settings.screen, W, H);
    gl.viewport(0, 0, W, H);
    gl.uniform2f(u.uCenter, rect.cx, H - rect.cy);
    gl.uniform2f(u.uHalf, rect.hw, rect.hh);
    gl.uniform2f(u.uRot, rect.cos, rect.sin);
    const lines = Math.max(60, Number(fx.scanlineCount) || 288);
    const pxPerLine = (rect.hh * 2) / lines;
    const scanFade = Math.min(1, Math.max(0, (pxPerLine - 1.6) / 1.4));
    gl.uniform1f(u.uLines, lines);
    gl.uniform1f(u.uCurv, on ? fx.curvature * 0.16 : 0);
    gl.uniform1f(u.uCorner, on ? Math.min(0.6, Math.max(0.001, fx.cornerRadius)) : 0.001);
    gl.uniform1f(u.uEdgeShadow, on ? fx.edgeShadow : 0);
    gl.uniform1f(u.uScan, on ? fx.scanlines * scanFade : 0);
    gl.uniform1f(u.uMask, on ? Math.min(0.9, fx.mask) : 0);
    gl.uniform1f(u.uMaskType, MASK_TYPES[fx.maskType] ?? 2);
    gl.uniform1f(u.uMaskScale, Math.max(1, Math.round(Number(fx.maskScale) || 1)));
    gl.uniform1f(u.uVignette, on ? fx.vignette : 0);
    gl.uniform1f(u.uReflect, on ? fx.reflection : 0);
    gl.uniform1f(u.uAmbient, on ? fx.ambient : 0);
    const flicker = on ? 1 + (Math.random() - 0.5) * 2 * fx.flicker : 1;
    gl.uniform1f(u.uGain, dyn.gain * flicker);
    gl.uniform2f(u.uCollapse, dyn.collapseX, dyn.collapseY);
    gl.uniform1f(u.uDot, dyn.dot);
    gl.uniform1f(u.uSeed, Math.random() * 64);
    gl.uniform1f(u.uTime, timeSec % 3600);
    gl.uniform1f(u.uStatic, dyn.static);
    gl.uniform1f(u.uNoise, on ? fx.noise + dyn.noise : 0);
    const bg = hexToRgb(this.settings.screen.background);
    gl.uniform3f(u.uBg, bg[0], bg[1], bg[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
