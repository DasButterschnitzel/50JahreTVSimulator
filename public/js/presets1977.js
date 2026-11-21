// Vorschläge: deutsches Fernsehen von 1977 als fertige Sender.
//
// Recherchiert und geprüft am 21.11.2026:
//   - archive.org: Einträge und Dateien über die Metadaten-Schnittstelle abgerufen.
//   - YouTube: Existenz und Einbettbarkeit jedes Videos über YouTubes oEmbed-Schnittstelle abgefragt.
// Die Jahresangabe 1977 stammt aus Titel, Dateiname oder Beschreibung des jeweiligen Uploads
// (meist mit genauem Sendedatum); gesichtet wurden die Filme nicht.
//
// Fast alle Aufnahmen stammen von privaten Sammlern, nicht von den Sendern. Uploads können
// verschwinden, und für eine öffentliche Vorführung müssen die Rechte geklärt werden.

const yt = (id) => `https://www.youtube.com/watch?v=${id}`;
const ia = (id, prefix = '') => `https://archive.org/details/${id}${prefix ? `#${prefix}` : ''}`;

export const PRESETS_1977 = [
  {
    id: 'p77-werbung',
    kind: 'web',
    name: 'Werbefernsehen 1977',
    source: 'archive.org',
    note: 'Rund 80 deutsche Werbespots mit Jahr 1977 im Dateinamen (4711, Asbach Uralt, Jacobs Krönung, Raider …), zusammen etwa 37 Minuten.',
    urls: [ia('Commercials_de_1970s', '1977')],
  },
  {
    id: 'p77-nachrichten',
    kind: 'youtube',
    name: 'Nachrichten 1977',
    source: 'YouTube',
    note: 'ZDF heute mit Sendeschluss (5.3.), Tagesschau (26.5., 12.10., 13.10., 24.12.), ZDF heute (4.9.), Tagesschau-Sondersendung (19.10.).',
    urls: [yt('k-Jm6MMmNFY'), yt('tqx-6_OgkIE'), yt('6rqFatam_nw'), yt('0F74cFh1Oig'), yt('I-K9-_lLLsY'), yt('WMCwqxQpnBY'), yt('yGhXnDC3MVA')],
  },
  {
    id: 'p77-show',
    kind: 'youtube',
    name: 'Samstagabend 1977',
    source: 'YouTube',
    note: 'Am laufenden Band mit Rudi Carrell (20.8., 17.9., Silvester), ZDF-Hitparade (1.10., 29.10., 26.11.), Musikladen (13.8.).',
    urls: [yt('NUB3zX_TThE'), yt('Fr_4_WVyn7Y'), yt('yHIiGlddS-4'), yt('h6tQ4-scsrw'), yt('idQhkDCrfbM'), yt('ptrom-6OBOE'), yt('SVMj1jb4Jh8')],
  },
  {
    id: 'p77-zdf-werbung',
    kind: 'youtube',
    name: 'ZDF-Werbung und Ansagen 1977',
    source: 'YouTube',
    note: 'Werbeblöcke mit Mainzelmännchen (27.10.), Ende der Hitparade mit IFA-Spot und Programmansage (11.6.).',
    urls: [yt('FCR9oMxDOAo'), yt('bgO407ICa6U'), yt('0xWwXt7eiqI')],
  },
  {
    id: 'p77-fernsehen',
    kind: 'web',
    name: 'Fernsehen 1977',
    source: 'archive.org',
    note: 'Spiel ohne Grenzen (ARD, 7.9., Teil 1), ZDF-Reportage „Kein Weg nach Simbabwe“ (17.4.), Schul-Lehrfilm über Abwasser (FWU/Geberit).',
    urls: [ia('spiel-ohne-grenzen-1977-09-07'), ia('Rhodesien'), ia('GeberitAbwasser')],
  },
  {
    id: 'p77-ddr-wochenschau',
    kind: 'youtube',
    name: 'DDR-Wochenschau 1977',
    source: 'YouTube',
    note: 'DEFA-Wochenschau „Der Augenzeuge“ 1977/10 und 1977/40, vom offiziellen Kanal „DEFA Filmwelt“.',
    urls: [yt('8WoXICk_tp8'), yt('5uV2hXB-RMo')],
  },
  {
    id: 'p77-ddr-fernsehen',
    kind: 'web',
    name: 'DDR-Fernsehen 1977',
    source: 'archive.org',
    note: 'Jan und Tini im Porzellanwerk Colditz, Porzelliner, Arbeiterfamilie in Ilmenau, Mein Thüringen, mein Heimatland.',
    urls: [ia('jan-und-tini-im-pw-colditz'), ia('porzelliner-1977'), ia('arbeiterfamilie-in-ilmenau'), ia('herbert-roth')],
  },
];
