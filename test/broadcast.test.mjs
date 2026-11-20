import test from 'node:test';
import assert from 'node:assert/strict';
import { BroadcastClock, buildSchedule, locate, mod } from '../public/js/broadcast.js';

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('mod bleibt auch bei negativen Zahlen positiv', () => {
  assert.equal(mod(-1, 10), 9);
  assert.equal(mod(25, 10), 5);
});

test('Sendeplan überspringt Filme ohne bekannte Länge', () => {
  const s = buildSchedule([{ url: 'a', duration: 10 }, { url: 'kaputt' }, { url: 'b', duration: 20 }, { url: 'c', duration: 0 }]);
  assert.equal(s.items.length, 2);
  assert.equal(s.total, 30);
  assert.deepEqual(
    s.items.map((i) => i.start),
    [0, 10]
  );
});

test('locate findet Film und Stelle, auch nach mehreren Durchläufen', () => {
  const s = buildSchedule([
    { url: 'a', duration: 10 },
    { url: 'b', duration: 20 },
    { url: 'c', duration: 5 },
  ]);
  assert.equal(locate(s, 0).index, 0);
  assert.equal(locate(s, 9.99).index, 0);
  assert.equal(locate(s, 10).index, 1);
  near(locate(s, 12.5).offset, 2.5);
  near(locate(s, 12.5).remaining, 17.5);
  assert.equal(locate(s, 30).index, 2);
  assert.equal(locate(s, 35).index, 0); // Schleife
  assert.equal(locate(s, 35 * 1000 + 31).index, 2);
  assert.equal(locate(s, -1).index, 2);
  assert.equal(locate(buildSchedule([]), 5), null);
});

test('alle Sender laufen gleichzeitig weiter', () => {
  const clock = new BroadcastClock();
  const t0 = 1_000_000;
  clock.setPosition('ard', 100, 0, t0);
  clock.setPosition('zdf', 60, 30, t0);
  near(clock.position('ard', 100, t0 + 42), 42);
  near(clock.position('zdf', 60, t0 + 42), 12); // 30 + 42 = 72 -> Schleife bei 60
});

test('Pause hält alle Sender an, danach geht es an derselben Stelle weiter', () => {
  const clock = new BroadcastClock();
  const t0 = 2_000_000;
  clock.setPosition('a', 100, 10, t0);
  clock.pause(t0 + 5);
  assert.equal(clock.paused, true);
  near(clock.position('a', 100, t0 + 50), 15);
  clock.pause(t0 + 60); // doppelte Pause ändert nichts
  clock.resume(t0 + 65);
  assert.equal(clock.paused, false);
  near(clock.position('a', 100, t0 + 70), 20);
});

test('Springen und Neustart während der Pause', () => {
  const clock = new BroadcastClock();
  const t0 = 3_000_000;
  clock.pause(t0);
  clock.setPosition('a', 100, 0, t0 + 10);
  near(clock.position('a', 100, t0 + 20), 0);
  clock.shift('a', 100, -5, t0 + 20);
  near(clock.position('a', 100, t0 + 20), 95);
  clock.resume(t0 + 30);
  near(clock.position('a', 100, t0 + 33), 98);
});

test('Zustand übersteht Speichern und Laden (Neustart des Rechners)', () => {
  const clock = new BroadcastClock();
  const t0 = 4_000_000;
  clock.setPosition('a', 100, 25, t0);
  clock.pause(t0 + 1);
  clock.resume(t0 + 11);
  const restored = new BroadcastClock(JSON.parse(JSON.stringify(clock)));
  near(restored.position('a', 100, t0 + 3600), clock.position('a', 100, t0 + 3600));
  near(restored.position('a', 100, t0 + 21), 36);
});

test('ohne gespeicherten Zustand ergibt sich die Position allein aus der Uhrzeit', () => {
  const a = new BroadcastClock();
  const b = new BroadcastClock({ offsets: { x: 'kaputt' }, pausedAt: 'nein' });
  near(a.position('x', 77, 5_000_000), b.position('x', 77, 5_000_000));
  assert.equal(b.paused, false);
});

test('Sprung an einen Filmanfang landet trotz Rundungsfehlern immer in diesem Film', () => {
  // Regression: Mit echten Uhrzeiten (rund 1,8 Milliarden Sekunden) landete der Sprung
  // manchmal einen Hauch vor dem Filmanfang, also am Ende des vorherigen Films.
  let seed = 12345;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let run = 0; run < 20000; run++) {
    const count = 1 + Math.floor(random() * 5);
    const schedule = buildSchedule(Array.from({ length: count }, (_, i) => ({ url: String(i), duration: 5 + random() * 4000 })));
    const clock = new BroadcastClock({ pauseAccum: random() * 100000 });
    const wall = 1_700_000_000 + random() * 300_000_000;
    if (random() < 0.3) clock.pause(wall - random() * 1000);
    const target = Math.floor(random() * count);
    clock.setPosition('x', schedule.total, schedule.items[target].start, wall);
    const loc = locate(schedule, clock.position('x', schedule.total, wall));
    assert.equal(loc.index, target, `Lauf ${run}: Film ${target} erwartet, Position ${loc.position} von ${schedule.total}`);
    assert.ok(loc.offset < 0.01, `Lauf ${run}: Abstand zum Filmanfang ${loc.offset}`);
  }
});
