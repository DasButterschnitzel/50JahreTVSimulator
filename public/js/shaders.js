// GLSL-Programme der Röhrensimulation (GLSL ES 1.00, läuft mit WebGL 1 und 2).
//
// Ablauf pro Bild:
//   1. SIGNAL  – Video -> "Antennensignal" in PAL-Auflösung: Farbunschärfe, Rauschen,
//                Geisterbild, Durchlaufen des Bildes, Schnee, Nachleuchten
//   2. BLUR    – weichgezeichnete Kopie für das Überstrahlen
//   3. TUBE    – Bildröhre: Wölbung, Zeilen, Lochmaske, Glas, Ein-/Ausschalten

const PRECISION = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`;

const HASH = `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

export const VERTEX = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

export const SIGNAL_FRAGMENT = `${PRECISION}
varying vec2 vUv;
uniform sampler2D uSrc;
uniform sampler2D uPrev;
uniform vec2 uRes;
uniform vec4 uSrcMap;      // xy = Skalierung, zw = Verschiebung (Bildausschnitt)
uniform float uHasSrc;
uniform float uSeed;
uniform float uTime;
uniform float uStatic;     // 0 = Bild, 1 = nur Schnee
uniform float uNoise;
uniform float uColorNoise;
uniform float uRoll;       // Bilddurchlauf in Bildhöhen
uniform float uSkew;       // Zeilenkippen (Verlust der Zeilensynchronisation)
uniform float uJitter;
uniform float uWobble;
uniform float uGhost;
uniform float uChroma;
uniform float uSoft;
uniform float uHum;
uniform float uSat;
uniform float uContrast;
uniform float uBright;
uniform float uWarm;
uniform float uBW;
uniform float uPersist;
${HASH}
const vec3 LUMA = vec3(0.299, 0.587, 0.114);

vec3 tap(vec2 uv) {
  vec2 s = (uv - 0.5) * uSrcMap.xy + 0.5 + uSrcMap.zw;
  vec2 inside = step(vec2(0.0), s) * step(s, vec2(1.0));
  return texture2D(uSrc, clamp(s, 0.0, 1.0)).rgb * inside.x * inside.y * uHasSrc;
}

vec2 chromaOf(vec3 c) {
  float y = dot(c, LUMA);
  return vec2((c.b - y) * 0.493, (c.r - y) * 0.877);
}

float snow(vec2 fc) {
  vec2 g = floor(fc * vec2(0.5, 0.5));
  vec2 s = uSeed * vec2(91.7, 13.3);
  float a = hash12(g + s);
  float b = hash12(g + vec2(1.0, 0.0) + s);
  float v = mix(a, b, 0.35);
  v = smoothstep(0.22, 0.95, v);
  v *= 0.78 + 0.22 * sin(fc.y * 0.05 + uTime * 11.0);
  return v * 0.92 + 0.03;
}

void main() {
  vec2 uv = vUv;
  vec2 fc = gl_FragCoord.xy;
  float line = floor(fc.y);

  // Bilddurchlauf mit sichtbarer Austastlücke (schwarzer Balken)
  const float BLANK = 0.07;
  float ph = fract(uv.y / (1.0 + BLANK) + uRoll) * (1.0 + BLANK);
  float blank = step(1.0, ph);
  uv.y = min(ph, 1.0);

  // Zeilenweise Störungen
  float jl = hash12(vec2(line, uSeed * 7.3)) - 0.5;
  uv.x += uSkew * (vUv.y - 0.5);
  uv.x += (jl * uJitter + sin(vUv.y * 9.0 + uTime * 1.7) * uWobble) / uRes.x;
  uv.x = mix(uv.x, fract(uv.x), step(0.0005, abs(uSkew)));

  // Helligkeit scharf, Farbe unscharf (PAL überträgt Farbe mit geringer Bandbreite)
  vec2 px = vec2(1.0 / uRes.x, 0.0);
  vec3 c0 = tap(uv);
  vec3 l1 = tap(uv - px * (0.6 + uSoft));
  vec3 r1 = tap(uv + px * (0.6 + uSoft));
  vec3 l2 = tap(uv - px * uChroma * 2.5);
  vec3 r2 = tap(uv + px * uChroma * 2.5);
  vec3 l3 = tap(uv - px * uChroma * 5.5);
  vec3 r3 = tap(uv + px * uChroma * 5.5);

  float soft = clamp(uSoft, 0.0, 1.0) * 0.5;
  float y = dot(c0, LUMA) * (1.0 - soft) + (dot(l1, LUMA) + dot(r1, LUMA)) * soft * 0.5;
  vec2 ch = chromaOf(c0) * 0.2 + (chromaOf(l1) + chromaOf(r1)) * 0.15
          + (chromaOf(l2) + chromaOf(r2)) * 0.15 + (chromaOf(l3) + chromaOf(r3)) * 0.1;

  // Geisterbild: verzögertes Echo des Signals
  float yg = dot(tap(uv - vec2(0.032, 0.0)), LUMA);
  y = y * (1.0 - uGhost * 0.4) + yg * uGhost;

  // Rauschen
  float n1 = hash12(fc + uSeed * vec2(37.0, 17.0));
  float n2 = hash12(floor(fc * vec2(0.5, 1.0)) + uSeed * vec2(11.0, 53.0));
  y += (n1 + n2 - 1.0) * uNoise;
  vec2 cg = floor(fc * vec2(0.125, 0.5));
  ch += (vec2(hash12(cg + uSeed * 3.1), hash12(cg + uSeed * 5.7 + 40.0)) - 0.5) * uColorNoise;

  // Brummstreifen
  y *= 1.0 + uHum * sin((vUv.y + uTime * 0.21) * 6.2831853);

  ch *= uSat * (1.0 - uBW) * (1.0 - clamp(uStatic * 1.5, 0.0, 1.0));
  float r = y + ch.y / 0.877;
  float b = y + ch.x / 0.493;
  float g = (y - 0.299 * r - 0.114 * b) / 0.587;
  vec3 col = vec3(r, g, b);
  col = (col - 0.5) * uContrast + 0.5;
  col *= uBright;
  col *= mix(vec3(1.0), vec3(1.07, 1.0, 0.86), uWarm);
  col *= 1.0 - blank;

  col = mix(col, vec3(snow(fc)), uStatic);
  col = clamp(col, 0.0, 1.0);

  // Nachleuchten des Leuchtstoffs
  vec3 prev = texture2D(uPrev, vUv).rgb;
  col = max(col, prev * uPersist);
  gl_FragColor = vec4(col, 1.0);
}
`;

export const BLUR_FRAGMENT = `${PRECISION}
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;
void main() {
  vec3 c = texture2D(uTex, vUv).rgb * 0.227027;
  c += (texture2D(uTex, vUv + uDir * 1.384615).rgb + texture2D(uTex, vUv - uDir * 1.384615).rgb) * 0.316216;
  c += (texture2D(uTex, vUv + uDir * 3.230769).rgb + texture2D(uTex, vUv - uDir * 3.230769).rgb) * 0.070270;
  gl_FragColor = vec4(c, 1.0);
}
`;

export const TUBE_FRAGMENT = `${PRECISION}
uniform sampler2D uSignal;
uniform sampler2D uBlur;
uniform vec2 uCenter;      // Mitte der Bildröhre in Pixeln
uniform vec2 uHalf;        // halbe Breite/Höhe in Pixeln
uniform vec2 uRot;         // cos, sin der Drehung
uniform float uLines;
uniform float uField;      // 0 oder 0.5: Halbbildversatz beim Zeilensprung
uniform float uCurv;
uniform float uCorner;
uniform float uEdgeShadow;
uniform float uScan;
uniform float uMask;
uniform float uMaskType;
uniform float uMaskScale;
uniform float uHalation;
uniform float uVignette;
uniform float uReflect;
uniform float uAmbient;
uniform float uGain;       // Helligkeit (Ein-/Ausschalten, Flimmern)
uniform vec2 uCollapse;    // Bild fällt beim Ausschalten zu Strich und Punkt zusammen
uniform float uDot;
uniform float uSeed;
uniform vec3 uBg;
${HASH}
vec3 maskAt(vec2 fc) {
  if (uMask <= 0.0 || uMaskType < 0.5) return vec3(1.0);
  vec2 m = floor(fc / uMaskScale);
  float dark = 1.0 - uMask;
  vec3 res;
  if (uMaskType > 2.5) {
    // Lochmaske mit versetzten Punkten (Delta-Röhre)
    float x = mod(m.x + floor(m.y * 0.5) * 3.0, 6.0);
    res = x < 2.0 ? vec3(1.0, dark, dark) : (x < 4.0 ? vec3(dark, 1.0, dark) : vec3(dark, dark, 1.0));
  } else {
    float x = mod(m.x, 3.0);
    res = x < 0.5 ? vec3(1.0, dark, dark) : (x < 1.5 ? vec3(dark, 1.0, dark) : vec3(dark, dark, 1.0));
    if (uMaskType > 1.5) {
      // Schlitzmaske (Inline-Röhre): senkrechte Schlitze mit Stegen
      float tri = floor(m.x / 3.0);
      float row = mod(m.y + mod(tri, 2.0) * 2.0, 4.0);
      if (row < 1.0) res *= 1.0 - 0.6 * uMask;
    }
  }
  return res / (1.0 - uMask * 0.5);
}

void main() {
  vec2 d = gl_FragCoord.xy - uCenter;
  d = vec2(d.x * uRot.x - d.y * uRot.y, d.x * uRot.y + d.y * uRot.x);
  vec2 p = vec2(d.x, -d.y) / uHalf;
  float aspect = uHalf.x / uHalf.y;

  // Wölbung der Röhre
  vec2 q = p * (1.0 + uCurv * p.yx * p.yx);

  // Umriss der Bildröhre: Rechteck mit runden Ecken
  vec2 qa = abs(q) * vec2(aspect, 1.0);
  vec2 bx = vec2(aspect, 1.0) - uCorner;
  float sdf = length(max(qa - bx, 0.0)) + min(max(qa.x - bx.x, qa.y - bx.y), 0.0) - uCorner;
  float pxSize = 1.5 / uHalf.y;
  float face = 1.0 - smoothstep(-pxSize, pxSize, sdf);
  if (face <= 0.0) {
    gl_FragColor = vec4(uBg, 1.0);
    return;
  }

  vec2 pc = q / uCollapse;
  float inPic = step(abs(pc.x), 1.0) * step(abs(pc.y), 1.0);
  vec2 uv = clamp(pc * 0.5 + 0.5, 0.0, 1.0);

  // Zeilenstruktur: Jede Zeile ist ein Elektronenstrahl mit hellem Kern,
  // helle Stellen machen den Strahl breiter.
  float ly = uv.y * uLines - 0.5 + uField;
  float l0 = floor(ly);
  float f = ly - l0;
  vec3 c0 = texture2D(uSignal, vec2(uv.x, (l0 + 0.5 - uField) / uLines)).rgb;
  vec3 c1 = texture2D(uSignal, vec2(uv.x, (l0 + 1.5 - uField) / uLines)).rgb;
  c0 *= c0;
  c1 *= c1;
  vec3 plain = mix(c0, c1, f);
  vec3 s0 = mix(vec3(0.30), vec3(0.52), sqrt(c0));
  vec3 s1 = mix(vec3(0.30), vec3(0.52), sqrt(c1));
  float g = 1.0 - f;
  vec3 beam = c0 * exp(-(f * f) / (s0 * s0)) + c1 * exp(-(g * g) / (s1 * s1));
  vec3 col = mix(plain, beam * 1.3, uScan);

  // Überstrahlen: Licht streut im Glas
  vec3 bl = texture2D(uBlur, uv).rgb;
  col += bl * bl * uHalation;

  col *= inPic * uGain;

  // Leuchtpunkt nach dem Ausschalten
  vec2 qd = q * vec2(aspect, 1.0);
  col += vec3(0.85, 0.95, 1.0) * uDot * exp(-dot(qd, qd) * 700.0);

  col *= maskAt(gl_FragCoord.xy);

  float r2 = dot(p, p) * 0.5;
  col *= 1.0 - uVignette * r2;

  // Glas: graue Röhre im Raumlicht und Spiegelungen
  vec3 glass = uAmbient * vec3(0.016, 0.019, 0.018) * (1.0 - 0.5 * r2);
  vec2 g1 = (p - vec2(-0.50, -0.56)) * vec2(1.25, 2.3);
  vec2 g2 = (p - vec2(0.58, -0.78)) * vec2(2.4, 5.0);
  glass += uReflect * (exp(-dot(g1, g1)) * 0.035 + exp(-dot(g2, g2)) * 0.015) * vec3(1.0, 0.98, 0.93);
  glass += uReflect * smoothstep(-0.12, 0.0, sdf) * 0.012;
  col += glass;

  // Schatten des Gehäuserands auf dem Glas
  col *= mix(1.0, 0.35 + 0.65 * smoothstep(0.0, -0.07, sdf), uEdgeShadow);

  col = sqrt(clamp(col, 0.0, 1.0));
  col += (hash12(gl_FragCoord.xy + uSeed * 17.0) - 0.5) / 255.0;
  gl_FragColor = vec4(mix(uBg, col, face), 1.0);
}
`;
