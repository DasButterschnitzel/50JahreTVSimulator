import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };

const { parseWebUrl, pickArchiveFiles, resolveWebChannel, applyHiddenFiles } = await import('../public/js/online.js');
const { PRESETS_1977 } = await import('../public/js/presets1977.js');
const { parseYouTubeUrl } = await import('../public/js/youtube.js');

// Ausschnitt aus den echten Metadaten von archive.org (Stand November 2026), auf wenige Dateien gekürzt
const COMMERCIALS = {
  metadata: { identifier: 'Commercials_de_1970s', title: 'German Commercials (1970s)' },
  files: [
    { name: '1976 Persil.mp4', format: 'MPEG4', source: 'original', size: '5000000', length: '30.1' },
    { name: '1976 Persil.ia.mp4', format: 'h.264 IA', source: 'derivative', original: '1976 Persil.mp4', size: '5000000', length: '30.1' },
    { name: '1977 4711 - Echt Kölnisch Wasser (4711).ia.mp4', format: 'h.264 IA', source: 'derivative', original: '1977 4711 - Echt Kölnisch Wasser (4711).mp4', size: '6944856', length: '21.58' },
    { name: '1977 4711 - Echt Kölnisch Wasser (4711).mp4', format: 'MPEG4', source: 'original', size: '6944856', length: '21.58' },
    { name: '1977 Asbach Uralt Kopie.mp4', format: 'MPEG4', source: 'original', size: '9000000', length: '30.67' },
    { name: '1977 Asbach Uralt Kopie.ia.mp4', format: 'h.264 IA', source: 'derivative', original: '1977 Asbach Uralt Kopie.mp4', size: '9000000', length: '30.67' },
    { name: '1977 Asbach Uralt.mp4', format: 'MPEG4', source: 'original', size: '8000000', length: '30.7' },
    { name: '1977 Asbach Uralt.ia.mp4', format: 'h.264 IA', source: 'derivative', original: '1977 Asbach Uralt.mp4', size: '8000000', length: '30.7' },
    { name: '1977 Raider.mp4', format: 'MPEG4', source: 'original', size: '4000000', length: '0:25' },
    { name: '197x Afri Cola.mp4', format: 'MPEG4', source: 'original', size: '4000000', length: '20' },
    { name: 'Commercials_de_1970s.thumbs/1977 Raider_000001.jpg', format: 'Thumbnail', source: 'derivative', original: '1977 Raider.mp4', size: '5000' },
    { name: '__ia_thumb.jpg', format: 'Item Tile', source: 'original', size: '9000' },
    { name: 'Commercials_de_1970s_meta.xml', format: 'Metadata', source: 'original', size: '900' },
  ],
};
const LEHRFILM = {
  metadata: { identifier: 'GeberitAbwasser' },
  files: [
    { name: 'Abwasser.MPG', format: 'MPEG1', source: 'original', size: '526000000', length: '2184.74' },
    { name: 'Abwasser.mp4', format: 'h.264', source: 'derivative', original: 'Abwasser.MPG', size: '212000000', length: '2184.79' },
    { name: 'Abwasser.ogv', format: 'Ogg Video', source: 'derivative', original: 'Abwasser.MPG', size: '150000000', length: '2184.8' },
    { name: 'Nur Original.avi', format: 'Cinepack', source: 'original', size: '1', length: '10' },
  ],
};

test('Adressen von archive.org und direkte Videoadressen werden erkannt', () => {
  assert.deepEqual(parseWebUrl('https://archive.org/details/Commercials_de_1970s#1977'), { archive: 'Commercials_de_1970s', prefix: '1977' });
  assert.deepEqual(parseWebUrl(' archive.org/details/GeberitAbwasser '), { archive: 'GeberitAbwasser', prefix: '' });
  assert.deepEqual(parseWebUrl('https://www.archive.org/details/x-1.2_y/'), { archive: 'x-1.2_y', prefix: '' });
  assert.deepEqual(parseWebUrl('https://archive.org/download/GeberitAbwasser'), { archive: 'GeberitAbwasser', prefix: '' });
  assert.deepEqual(parseWebUrl('https://archive.org/details/abc#1977%20Asbach'), { archive: 'abc', prefix: '1977 Asbach' });
  assert.deepEqual(parseWebUrl('https://archive.org/download/GeberitAbwasser/Abwasser.mp4'), { direct: 'https://archive.org/download/GeberitAbwasser/Abwasser.mp4', name: 'Abwasser' });
  assert.deepEqual(parseWebUrl('https://example.org/a/Mein%20Film.WEBM?x=1#t=3'), { direct: 'https://example.org/a/Mein%20Film.WEBM?x=1', name: 'Mein Film' });
  for (const bad of ['', 'hallo welt', 'https://archive.org/', 'https://archive.org/details/', 'https://archive.org/search?query=1977', 'https://example.org/seite.html', 'ftp://example.org/film.mp4', 'https://youtu.be/dQw4w9WgXcQ', 'javascript:alert(1)//.mp4']) {
    assert.equal(parseWebUrl(bad), null, bad);
  }
});

test('aus einem archive.org-Eintrag werden die abspielbaren Filme gewählt', () => {
  const spots = pickArchiveFiles(COMMERCIALS, '1977');
  assert.deepEqual(
    spots.map((f) => [f.name, f.duration]),
    [
      ['1977 4711 - Echt Kölnisch Wasser (4711)', 21.58],
      ['1977 Asbach Uralt', 30.7], // die "Kopie" desselben Spots entfällt
      ['1977 Raider', 25], // Länge "0:25"
    ]
  );
  // bevorzugt die von archive.org erzeugte H.264-Fassung, sonst das Original
  // abgerufen wird über den eigenen Server (/remote/…), weil der Browser fremde Videos nicht in die Simulation holen darf
  const target = (file) => decodeURIComponent(file.url.replace(/^\/remote\//, ''));
  assert.ok(spots.every((f) => f.url.startsWith('/remote/https%3A%2F%2Farchive.org%2Fdownload%2F')));
  assert.equal(target(spots[0]), 'https://archive.org/download/Commercials_de_1970s/1977%204711%20-%20Echt%20K%C3%B6lnisch%20Wasser%20(4711).ia.mp4');
  assert.equal(target(spots[2]), 'https://archive.org/download/Commercials_de_1970s/1977%20Raider.mp4');
  assert.equal(spots[0].size, 6944856);

  assert.equal(pickArchiveFiles(COMMERCIALS).length, 5, 'ohne Filter alle Jahre, ohne Vorschaubilder und Metadaten');
  assert.equal(pickArchiveFiles(COMMERCIALS, '1977 ASBACH').length, 1, 'Filter achtet nicht auf Groß-/Kleinschreibung');
  assert.equal(pickArchiveFiles(COMMERCIALS, '1980').length, 0);

  // nicht abspielbares Original (MPG): die abgeleitete MP4-Fassung; AVI ohne Ableitung entfällt
  assert.deepEqual(
    pickArchiveFiles(LEHRFILM).map((f) => [f.name, target(f), Math.round(f.duration)]),
    [['Abwasser', 'https://archive.org/download/GeberitAbwasser/Abwasser.mp4', 2185]]
  );
  assert.deepEqual(pickArchiveFiles(null), []);
  assert.deepEqual(pickArchiveFiles({ files: [{ name: 'a.mp4' }] }), []);
});

test('Internet-Sender wird aufgelöst; ohne Netz gilt die zuletzt bekannte Liste', async () => {
  store.clear();
  const realFetch = globalThis.fetch;
  let calls = 0;
  let online = true;
  globalThis.fetch = async (url) => {
    calls++;
    if (!online) throw new Error('offline');
    const id = decodeURIComponent(String(url).split('/').pop());
    const data = { Commercials_de_1970s: COMMERCIALS, GeberitAbwasser: LEHRFILM }[id];
    return { ok: !!data, status: data ? 200 : 404, json: async () => data || {} };
  };
  const quiet = { warn() {} };
  try {
    const ch = { id: 'web-1', type: 'video', remote: true, options: { urls: ['https://archive.org/details/Commercials_de_1970s#1977', 'https://example.org/direkt.mp4', 'unsinn', 'https://archive.org/details/gibtesnicht'] } };
    await resolveWebChannel(ch, quiet);
    assert.deepEqual(
      ch.files.map((f) => f.name),
      ['1977 4711 - Echt Kölnisch Wasser (4711)', '1977 Asbach Uralt', '1977 Raider', 'direkt']
    );
    assert.deepEqual(ch.invalidUrls, ['unsinn', 'https://archive.org/details/gibtesnicht']);
    assert.equal(ch.files[3].duration, undefined, 'direkte Adressen werden von der Anzeige vermessen');
    assert.equal(ch.files[3].url, '/remote/https%3A%2F%2Fexample.org%2Fdirekt.mp4');

    // zweiter Aufruf kommt aus dem Zwischenspeicher (nur der unbekannte Eintrag wird erneut versucht)
    calls = 0;
    await resolveWebChannel(ch, quiet);
    assert.equal(calls, 1);

    // offline und Zwischenspeicher veraltet: die alte Liste bleibt in Gebrauch
    const cache = JSON.parse(store.get('tv77.archive'));
    cache.Commercials_de_1970s.at = Date.now() - 48 * 3600 * 1000;
    store.set('tv77.archive', JSON.stringify(cache));
    online = false;
    await resolveWebChannel(ch, quiet);
    assert.equal(ch.files.length, 4);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('abgewählte Filme laufen nicht mit; Sender ohne Filme verschwinden', () => {
  const channels = [
    { id: 'a', type: 'video', files: [{ url: '/media/a/1.mp4' }, { url: '/media/a/2.mp4' }] },
    { id: 'b', type: 'video', files: [{ url: '/media/b/1.mp4' }] },
    { id: 'c', type: 'testcard', files: [] },
    { id: 'd', type: 'youtube', files: [] },
    { id: 'e', type: 'video', files: [] },
  ];
  assert.equal(applyHiddenFiles(channels, []), channels);
  assert.equal(applyHiddenFiles(channels, 'kaputt'), channels);
  const result = applyHiddenFiles(channels, ['/media/a/2.mp4', '/media/b/1.mp4', '/media/gibtesnicht.mp4']);
  assert.deepEqual(
    result.map((c) => [c.id, c.files.length]),
    [
      ['a', 1],
      ['c', 0],
      ['d', 0],
      ['e', 0],
    ]
  );
  assert.equal(channels[0].files.length, 2, 'die ursprüngliche Liste bleibt unverändert');
});

test('Vorschläge 1977: jede Adresse ist gültig und passt zur Art des Senders', () => {
  const ids = new Set();
  for (const preset of PRESETS_1977) {
    assert.ok(!ids.has(preset.id), preset.id);
    ids.add(preset.id);
    assert.ok(preset.name && preset.note && preset.urls.length, preset.id);
    for (const url of preset.urls) {
      if (preset.kind === 'youtube') assert.ok(parseYouTubeUrl(url)?.video, url);
      else assert.ok(parseWebUrl(url)?.archive && !parseYouTubeUrl(url), url);
    }
  }
  assert.equal(new Set(PRESETS_1977.flatMap((p) => p.urls)).size, PRESETS_1977.flatMap((p) => p.urls).length, 'keine Adresse doppelt');
});
