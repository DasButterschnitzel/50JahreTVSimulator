// Zeitlicher Ablauf der Effekte: Rauschen beim Umschalten, Durchlaufen des Bildes,
// Aufwärmen der Röhre, Zusammenfallen des Bildes beim Ausschalten, Bildstörungen.

const rand = (min, max) => min + Math.random() * (max - min);
const smooth = (x) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

export class Director {
  constructor(settings) {
    this.settings = settings;
    // Werte, die der Renderer pro Bild ausliest
    this.dyn = { static: 0, roll: 0, skew: 0, jitter: 0, noise: 0, gain: 1, collapseX: 1, collapseY: 1, dot: 0 };
    this.mode = 'idle'; // idle | static | settle
    this.holdStatic = false;
    this.rollVelocity = 0;
    this.power = 'on'; // on | warming | turningOff | off
    this.powerTime = 0;
    this.glitchTime = 0;
    this.glitchLength = 0;
    this.glitchStrength = 0;
    this.nextGlitch = this.scheduleGlitch();
  }

  applySettings(settings) {
    this.settings = settings;
    this.nextGlitch = this.scheduleGlitch();
  }

  get fx() {
    return this.settings.effects;
  }

  scheduleGlitch() {
    const perHour = Number(this.fx.glitches) || 0;
    if (perHour <= 0) return Infinity;
    const mean = 3600 / perHour;
    return rand(0.4, 1.6) * mean;
  }

  /** Senderwechsel beginnt: sofort Schnee. */
  beginSwitch() {
    this.mode = 'static';
    this.holdStatic = false;
    this.dyn.static = 1;
    this.dyn.roll = 0;
    this.dyn.skew = 0;
    this.rollVelocity = 0;
  }

  /** Sender ohne Signal: Schnee bleibt stehen. */
  stayStatic() {
    this.mode = 'static';
    this.holdStatic = true;
    this.dyn.static = 1;
  }

  /** Neues Bild ist da: Schnee blendet aus, das Bild läuft kurz durch und rastet ein. */
  endSwitch() {
    if (this.mode !== 'static') return;
    this.mode = 'settle';
    this.holdStatic = false;
    const amount = this.fx.enabled === false ? 0 : Number(this.fx.switchRoll) || 0;
    if (amount > 0) {
      this.rollVelocity = (Math.random() < 0.5 ? -1 : 1) * rand(2.5, 5.5) * amount;
      this.dyn.roll = rand(0.2, 0.8);
      this.dyn.skew = rand(-0.25, 0.25) * amount;
    } else {
      this.rollVelocity = 0;
      this.dyn.roll = 0;
      this.dyn.skew = 0;
    }
  }

  /** Kurze Bildstörung (auch als Übergang bei Sprüngen im Film). */
  glitch(length = rand(0.15, 0.45), strength = rand(0.35, 0.8)) {
    this.glitchTime = 0;
    this.glitchLength = length;
    this.glitchStrength = strength;
  }

  powerOn() {
    if (this.power === 'on' || this.power === 'warming') return;
    this.power = this.fx.powerAnimation === false ? 'on' : 'warming';
    this.powerTime = 0;
  }

  powerOff() {
    if (this.power === 'off' || this.power === 'turningOff') return;
    this.power = this.fx.powerAnimation === false ? 'off' : 'turningOff';
    this.powerTime = 0;
  }

  setPowerImmediately(on) {
    this.power = on ? 'on' : 'off';
    this.powerTime = 0;
  }

  get isOff() {
    return this.power === 'off';
  }

  update(dt) {
    const d = this.dyn;
    dt = Math.min(dt, 0.1);

    // Senderwechsel
    if (this.mode === 'settle') {
      d.static *= Math.exp(-dt / 0.09);
      this.rollVelocity *= Math.exp(-dt * 5.5);
      d.roll += this.rollVelocity * dt;
      d.skew *= Math.exp(-dt * 9);
      if (Math.abs(this.rollVelocity) < 0.6) {
        const target = Math.round(d.roll);
        d.roll += (target - d.roll) * (1 - Math.exp(-dt * 14));
        if (Math.abs(target - d.roll) < 0.002 && d.static < 0.01) {
          d.roll = 0;
          d.skew = 0;
          d.static = 0;
          this.rollVelocity = 0;
          this.mode = 'idle';
        }
      }
    } else if (this.mode === 'static') {
      d.static = 1;
    }

    // Zufällige Bildstörungen
    let glitchNoise = 0;
    let glitchJitter = 0;
    if (this.glitchLength > 0) {
      this.glitchTime += dt;
      const k = 1 - this.glitchTime / this.glitchLength;
      if (k <= 0) {
        this.glitchLength = 0;
      } else {
        glitchNoise = this.glitchStrength * k * 0.6;
        glitchJitter = this.glitchStrength * k * 14;
      }
    }
    if (this.mode === 'idle' && this.power === 'on' && Number.isFinite(this.nextGlitch)) {
      this.nextGlitch -= dt;
      if (this.nextGlitch <= 0) {
        this.glitch();
        this.nextGlitch = this.scheduleGlitch();
      }
    }
    d.noise = glitchNoise;
    d.jitter = glitchJitter + (this.mode === 'settle' ? Math.abs(this.rollVelocity) * 1.5 : 0);

    // Ein- und Ausschalten
    this.powerTime += dt;
    const t = this.powerTime;
    switch (this.power) {
      case 'on':
        d.gain = 1;
        d.collapseX = 1;
        d.collapseY = 1;
        d.dot = 0;
        break;
      case 'warming': {
        // Die Röhre heizt auf: Das Bild erscheint langsam, anfangs etwas zu groß.
        const k = smooth((t - 0.5) / 2.4);
        d.gain = k * k;
        const breathe = 1 + 0.05 * (1 - k);
        d.collapseX = breathe;
        d.collapseY = breathe;
        d.dot = 0;
        if (t > 2.9) this.power = 'on';
        break;
      }
      case 'turningOff': {
        // Bild fällt zu einem Strich, dann zu einem Punkt zusammen, der nachleuchtet.
        const a = smooth(t / 0.16);
        const b = smooth((t - 0.16) / 0.2);
        d.collapseY = Math.max(0.006, 1 - a);
        d.collapseX = Math.max(0.01, 1 - b);
        d.gain = (1 + a * 2.2) * (1 - smooth((t - 0.3) / 0.08));
        d.dot = t < 0.3 ? 0 : Math.exp(-(t - 0.3) / 0.35) * 1.4;
        if (t > 1.9) this.power = 'off';
        break;
      }
      default:
        d.gain = 0;
        d.collapseX = 1;
        d.collapseY = 1;
        d.dot = 0;
    }
    return d;
  }
}
