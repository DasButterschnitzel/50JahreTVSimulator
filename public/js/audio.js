// Ton: kleiner Mono-Lautsprecher, Rauschen beim Umschalten, Brummen, Testton.

export class AudioEngine {
  constructor(settings, log = console) {
    this.settings = settings;
    this.log = log;
    this.ctx = null;
    this.ok = false;
    this.powered = true;
    this.staticLevel = 0;
    this.toneOn = false;
    this.sources = new WeakMap();
  }

  init() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    try {
      const ctx = new Ctx({ latencyHint: 'playback' });
      this.ctx = ctx;

      this.input = ctx.createGain();
      this.program = ctx.createGain();
      this.master = ctx.createGain();
      this.master.gain.value = 0;

      // Unverfälschter Weg
      this.dry = ctx.createGain();
      this.input.connect(this.dry).connect(this.program);

      // "Fernsehlautsprecher": Mono, wenig Bass, wenig Höhen, leichte Sättigung
      const mono = ctx.createGain();
      mono.channelCount = 1;
      mono.channelCountMode = 'explicit';
      mono.channelInterpretation = 'speakers';
      const highpass = ctx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 150;
      highpass.Q.value = 0.8;
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 4600;
      lowpass.Q.value = 0.7;
      const presence = ctx.createBiquadFilter();
      presence.type = 'peaking';
      presence.frequency.value = 1900;
      presence.Q.value = 0.9;
      presence.gain.value = 4;
      const shaper = ctx.createWaveShaper();
      const curve = new Float32Array(1024);
      for (let i = 0; i < curve.length; i++) {
        const x = (i / (curve.length - 1)) * 2 - 1;
        curve[i] = Math.tanh(x * 1.6) / Math.tanh(1.6);
      }
      shaper.curve = curve;
      this.wet = ctx.createGain();
      this.input.connect(mono).connect(highpass).connect(lowpass).connect(presence).connect(shaper).connect(this.wet).connect(this.program);

      this.program.connect(this.master);
      this.master.connect(ctx.destination);

      // Rauschen
      const length = ctx.sampleRate * 2;
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
      const noise = ctx.createBufferSource();
      noise.buffer = buffer;
      noise.loop = true;
      const noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = 'lowpass';
      noiseFilter.frequency.value = 5200;
      this.noiseGain = ctx.createGain();
      this.noiseGain.gain.value = 0;
      noise.connect(noiseFilter).connect(this.noiseGain).connect(this.master);
      noise.start();

      this.humGain = this.makeOscillators([50, 100, 150], [1, 0.5, 0.2]);
      this.whistleGain = this.makeOscillators([15625], [1]);
      this.toneGain = this.makeOscillators([1000], [1]);

      this.ok = true;
      this.applySettings(this.settings);
      return true;
    } catch (err) {
      this.log.warn(`Tonaufbereitung nicht verfügbar: ${err.message}`);
      this.ok = false;
      return false;
    }
  }

  makeOscillators(frequencies, levels) {
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    frequencies.forEach((frequency, i) => {
      const osc = this.ctx.createOscillator();
      osc.frequency.value = frequency;
      const level = this.ctx.createGain();
      level.gain.value = levels[i];
      osc.connect(level).connect(gain);
      osc.start();
    });
    gain.connect(this.master);
    return gain;
  }

  /** Video an die Tonaufbereitung anschließen (einmal pro Element). */
  attach(video) {
    if (!this.ok || this.sources.has(video)) return;
    try {
      const source = this.ctx.createMediaElementSource(video);
      source.connect(this.input);
      this.sources.set(video, source);
    } catch (err) {
      this.log.warn(`Videoton konnte nicht angeschlossen werden: ${err.message}`);
    }
  }

  get running() {
    return this.ok && this.ctx.state === 'running';
  }

  /** Browser erlauben Ton oft erst nach einer Eingabe. */
  async resume() {
    if (!this.ok || this.ctx.state === 'running') return this.running;
    try {
      await this.ctx.resume();
    } catch {
      // erneuter Versuch bei der nächsten Eingabe
    }
    return this.running;
  }

  ramp(param, value, time = 0.05) {
    const now = this.ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setTargetAtTime(value, now, Math.max(0.005, time / 3));
  }

  applySettings(settings) {
    this.settings = settings;
    if (!this.ok) return;
    const a = settings.audio;
    const vintage = a.vintage !== false && settings.effects.enabled !== false;
    this.ramp(this.dry.gain, vintage ? 0 : 1);
    this.ramp(this.wet.gain, vintage ? 1 : 0);
    this.update();
  }

  update() {
    if (!this.ok) return;
    const a = this.settings.audio;
    const volume = a.muted ? 0 : Math.min(1, Math.max(0, Number(a.volume) || 0));
    // quadratische Kennlinie, damit sich der Regler gleichmäßig anfühlt
    this.ramp(this.master.gain, this.powered ? volume * volume : 0, 0.08);
    this.ramp(this.noiseGain.gain, this.staticLevel * (Number(a.staticVolume) || 0) * 0.5, 0.03);
    this.ramp(this.humGain.gain, (Number(a.hum) || 0) * 0.05, 0.2);
    this.ramp(this.whistleGain.gain, (Number(a.whistle) || 0) * 0.03, 0.2);
    this.ramp(this.toneGain.gain, this.toneOn ? (Number(a.testTone) || 0) * 0.25 : 0, 0.05);
    // Während des Rauschens ist der Programmton weg
    this.ramp(this.program.gain, 1 - Math.min(1, this.staticLevel), 0.03);
  }

  /** Lautstärkeausgleich einzelner Sender (channel.json: "volume"). */
  setChannelLevel(level) {
    if (!this.ok) return;
    this.ramp(this.input.gain, Math.min(4, Math.max(0, level)), 0.05);
  }

  setStatic(level) {
    this.staticLevel = level;
    this.update();
  }

  setTone(on) {
    this.toneOn = on;
    this.update();
  }

  setPower(on) {
    this.powered = on;
    this.update();
  }
}
