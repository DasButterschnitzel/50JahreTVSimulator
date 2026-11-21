import test from 'node:test';
import assert from 'node:assert/strict';

// localStorage gibt es in Node nicht; ein einfacher Ersatz genügt
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };

const { parseYouTubeUrl, prepareYouTubeChannel, rememberYouTubeDuration, GUESSED_DURATION_S } = await import('../public/js/youtube.js');
const { addOnlineChannels } = await import('../server/media.js');
const { buildSchedule } = await import('../public/js/broadcast.js');

test('YouTube-Adressen aller üblichen Formen werden erkannt', () => {
  const video = { video: 'dQw4w9WgXcQ' };
  for (const url of [
    'dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'http://youtube.com/watch?v=dQw4w9WgXcQ&feature=share',
    'www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?si=abcdef',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ',
    '  https://youtu.be/dQw4w9WgXcQ  ',
    // automatische Mixe und private Listen sind nicht einbettbar: nur das Video zählt
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=WL',
  ]) {
    assert.deepEqual(parseYouTubeUrl(url), video, url);
  }
  assert.deepEqual(parseYouTubeUrl('https://youtu.be/dQw4w9WgXcQ?t=90'), { video: 'dQw4w9WgXcQ', start: 90 });
  assert.deepEqual(parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s'), { video: 'dQw4w9WgXcQ', start: 90 });

  const playlist = { playlist: 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf' };
  for (const url of [
    'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf',
    'https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf&index=3',
    'https://youtu.be/dQw4w9WgXcQ?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf',
  ]) {
    assert.deepEqual(parseYouTubeUrl(url), playlist, url);
  }

  for (const bad of ['', '   ', 'hallo', 'https://vimeo.com/123456', 'https://www.youtube.com/', 'https://www.youtube.com/watch?v=zukurz', 'https://www.youtube.com/playlist?list=WL', 'https://example.com/watch?v=dQw4w9WgXcQ', 'javascript:alert(1)']) {
    assert.equal(parseYouTubeUrl(bad), null, bad);
  }
});

test('YouTube-Sender wird zur Filmliste für die Sendeuhr; Längen und Playlists werden gemerkt', () => {
  store.clear();
  const ch = { id: 'yt-1', type: 'youtube', options: { urls: ['https://youtu.be/AAAAAAAAAAA', 'kein link', 'https://www.youtube.com/playlist?list=PLtestlist0001', 'BBBBBBBBBBB'] } };
  prepareYouTubeChannel(ch);
  assert.deepEqual(
    ch.files.map((f) => [f.youtube, f.duration, f.guessed]),
    [
      ['AAAAAAAAAAA', GUESSED_DURATION_S, true],
      ['BBBBBBBBBBB', GUESSED_DURATION_S, true],
    ]
  );
  assert.deepEqual(ch.pendingPlaylists, ['PLtestlist0001'], 'Inhalt der Playlist ist noch unbekannt');
  assert.deepEqual(ch.invalidUrls, ['kein link']);
  assert.equal(buildSchedule(ch.files).total, 2 * GUESSED_DURATION_S);

  // Länge gelernt und Playlist aufgelöst (so legt es die Anzeige ab)
  rememberYouTubeDuration('AAAAAAAAAAA', 61.5);
  store.set('tv77.yt.playlists', JSON.stringify({ PLtestlist0001: { ids: ['CCCCCCCCCCC', 'AAAAAAAAAAA'], at: Date.now() } }));
  prepareYouTubeChannel(ch);
  assert.deepEqual(
    ch.files.map((f) => [f.youtube, f.duration]),
    [
      ['AAAAAAAAAAA', 61.5],
      ['CCCCCCCCCCC', GUESSED_DURATION_S],
      ['AAAAAAAAAAA', 61.5],
      ['BBBBBBBBBBB', GUESSED_DURATION_S],
    ]
  );
  assert.deepEqual(ch.pendingPlaylists, []);

  // nach einem Tag wird die Playlist erneut abgefragt, die alte Fassung bleibt solange in Gebrauch
  store.set('tv77.yt.playlists', JSON.stringify({ PLtestlist0001: { ids: ['CCCCCCCCCCC'], at: Date.now() - 25 * 3600 * 1000 } }));
  prepareYouTubeChannel(ch);
  assert.equal(ch.files.length, 3);
  assert.deepEqual(ch.pendingPlaylists, ['PLtestlist0001']);
});

test('YouTube-Sender aus den Einstellungen kommen hinter die Ordner-Sender', () => {
  const scan = { channels: [{ id: '01-a', type: 'video', files: [] }], warnings: ['w'] };
  const settings = {
    youtube: {
      channels: [
        { id: 'yt-abc', name: ' Hessenschau ', urls: [' https://youtu.be/AAAAAAAAAAA ', '', 5], blackWhite: true },
        { name: '', urls: ['PLtestlist0001'] },
        { name: 'leer', urls: [] },
        'kaputt',
        { name: 'ohne urls' },
      ],
    },
  };
  const result = addOnlineChannels(scan, settings);
  assert.deepEqual(result.warnings, ['w']);
  assert.deepEqual(
    result.channels.map((c) => [c.id, c.name, c.type]),
    [
      ['01-a', undefined, 'video'],
      ['yt-abc', 'Hessenschau', 'youtube'],
      ['yt-2', 'YouTube 2', 'youtube'],
    ]
  );
  assert.deepEqual(result.channels[1].options, { urls: ['https://youtu.be/AAAAAAAAAAA'], blackWhite: true });

  // ohne eigene Filme ersetzt der YouTube-Sender das Ersatz-Testbild
  const empty = { channels: [{ id: '_testbild', type: 'testcard', files: [] }], warnings: [] };
  assert.deepEqual(
    addOnlineChannels(empty, settings).channels.map((c) => c.id),
    ['yt-abc', 'yt-2']
  );
  assert.equal(addOnlineChannels(empty, {}).channels.length, 1);
  assert.equal(addOnlineChannels(empty, { youtube: { channels: 'x' } }).channels.length, 1);

  // Internet-Sender (archive.org, direkte Adressen) sind gewöhnliche Film-Sender, deren Liste die Anzeige auflöst
  const web = addOnlineChannels(scan, { web: { channels: [{ name: 'Werbung 1977', urls: ['https://archive.org/details/Commercials_de_1970s#1977 '] }] }, youtube: settings.youtube });
  assert.deepEqual(
    web.channels.map((c) => [c.id, c.type, !!c.remote]),
    [
      ['01-a', 'video', false],
      ['web-1', 'video', true],
      ['yt-abc', 'youtube', false],
      ['yt-2', 'youtube', false],
    ]
  );
  assert.deepEqual(web.channels[1].options.urls, ['https://archive.org/details/Commercials_de_1970s#1977']);
});
