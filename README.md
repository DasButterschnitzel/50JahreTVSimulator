# TV-Simulator 1977

Ausstellungs-Videoplayer für „50 Jahre Dreieich“: Ein ausrangierter Monitor in einer
Holzkiste wird zum Fernseher von 1977. Die Software spielt Filme in Endlosschleife
und rechnet das Bild so um, dass es wie auf einer alten Bildröhre aussieht.

- **Mehrere Sender, die gleichzeitig laufen.** Jeder Ordner mit Filmen ist ein Sender.
  Alle Sender „senden“ weiter, auch wenn gerade ein anderer eingestellt ist – wer
  umschaltet, landet mitten im laufenden Programm.
- **Internet-Sender:** Filme von archive.org (mit voller Röhrensimulation) sowie Videos und
  Playlists von YouTube als Programm, dazu fertige Vorschläge mit Fernsehen von 1977
  (siehe [Internet-Sender](#internet-sender)).
- **Filme auswählen:** In der Fernbedienung lassen sich einzelne Filme eines Senders an- und
  abwählen.
- **Röhrensimulation:** gewölbtes Glas mit runden Ecken, Zeilenstruktur, Lochmaske,
  unscharfe PAL-Farben, Rauschen, Geisterbild, Überstrahlen, Nachleuchten, Spiegelung.
  Beim Umschalten rauscht es und das Bild läuft kurz durch; beim Ausschalten fällt es
  zu einem Leuchtpunkt zusammen.
- **Ton wie aus dem kleinen Mono-Lautsprecher**, Rauschen beim Umschalten.
- **Bedienung** per Tastatur, USB-Drehregler oder Fernbedienung im Browser
  (Pause, Film neu starten, alle Sender von vorn, Lautstärke, Bildeinstellungen).
- **Dauerbetrieb:** Start im Vollbild, Wächter startet den Browser bei Absturz oder
  Hänger neu, defekte Dateien werden übersprungen, nach einem Neustart des Rechners
  läuft das Programm an der richtigen Stelle weiter.

Läuft unter **Windows** und auf dem **Raspberry Pi** (und jedem anderen Linux/Mac);
für Handys, Tablets und Android-Displays gibt es dieselbe Anzeige als **Android-App**
(siehe [Android-App](#android-app)).
Benötigt werden nur [Node.js](https://nodejs.org) (ab Version 18) und ein Browser
(Chrome, Edge oder Chromium). Keine Internetverbindung im Betrieb nötig.

> **Stand der Erprobung:** Entwickelt und automatisch getestet unter Linux mit Chromium.
> Auf einem echten Windows-PC, einem echten Raspberry Pi und mit dem Drehregler-Beispiel
> wurde noch nicht getestet; die Android-App auf einem Handy. Der Abruf von archive.org ist
> gegen den echten Server geprüft (Teilabrufe, Springen, Dekodieren), die Steuerung der
> YouTube-Sender gegen einen nachgebauten Player.
> Bitte vor der Ausstellung einen Probelauf über mehrere Tage auf dem Zielgerät einplanen.

## Schnellstart

### Windows

1. Node.js (LTS) von <https://nodejs.org> installieren.
2. Diesen Ordner auf den PC kopieren, Filme in `media` ablegen (siehe unten).
3. `start-windows.bat` doppelklicken. Der Fernseher erscheint im Vollbild.
4. Für den Start nach dem Einschalten des PCs: einmal `scripts\autostart-windows.bat` ausführen.

### Raspberry Pi (Raspberry Pi OS mit Desktop, Pi 4 oder 5)

```bash
sudo apt install nodejs ffmpeg
```

```bash
./start-pi.sh
```

Für den Start nach dem Hochfahren einmalig:

```bash
scripts/autostart-pi.sh
```

### Beenden

An der Anzeige **Strg+Umschalt+Q** drücken oder in der Fernbedienung „TV-Simulator beenden“.
(Alt+F4 allein reicht nicht – der Wächter startet den Browser sofort wieder.)

### Ohne eigene Filme ausprobieren

```bash
npm run demo
```

erzeugt mit ffmpeg ein paar Testfilme in `media`. Ganz ohne Filme zeigt der Fernseher ein Testbild.

## Filme und Sender

Jeder Unterordner von `media` ist ein Sender. Die Reihenfolge der Sender ergibt sich aus
den Ordnernamen, die Reihenfolge der Filme aus den Dateinamen; am Ende beginnt der Sender
wieder von vorn.

```
media/
  01-tagesschau/
    1977-08-01.mp4
    1977-12-31.mp4
  02-hessentag/
    hessentag-dreieich.mp4
  03-testbild/            leerer Ordner = Testbild
```

Der Sendername wird aus dem Ordnernamen gebildet (`02-hessentag` → „Hessentag“).
Neue oder geänderte Dateien werden nach spätestens zwei Minuten bemerkt, oder sofort über
„Filme neu einlesen“ in der Fernbedienung.

### Optionen pro Sender

Eine Datei `channel.json` im Ordner des Senders, alle Angaben freiwillig:

```json
{
  "name": "ARD – Tagesschau",
  "blackWhite": true,
  "fit": "fit",
  "volume": 1.2,
  "onSwitch": "restart"
}
```

| Angabe | Bedeutung |
| --- | --- |
| `name` | Anzeigename in der Fernbedienung |
| `type` | `"video"` (Standard), `"testcard"` = Testbild, `"noise"` = Sender ohne Signal (Rauschen), `"youtube"` = YouTube-Sender (dazu `"urls"`, siehe unten) |
| `blackWhite` | `true` = dieser Sender wird schwarz-weiß gezeigt |
| `fit` | Breitbild-Filme: `"fill"` formatfüllend beschneiden (Standard), `"fit"` ganz zeigen, `"stretch"` verzerren. Hochkant-Videos werden immer ganz gezeigt. |
| `volume` | Lautstärkeausgleich, 1 = unverändert |
| `onSwitch` | `"restart"` = der Sender beginnt bei jedem Einschalten von vorn, statt im Hintergrund weiterzulaufen |

### Videoformat

Am sichersten ist **MP4 mit H.264-Bild und AAC-Ton**. Das Skript
`scripts/video-umwandeln.sh` (Windows: Filme auf `scripts\video-umwandeln.bat` ziehen)
wandelt beliebige Filme passend um: 576 Zeilen, 25 Bilder/s, einheitliche Lautstärke und
ein Schlüsselbild pro Sekunde, damit das Umschalten schnell geht. Dafür wird
[ffmpeg](https://ffmpeg.org) benötigt.

```bash
scripts/video-umwandeln.sh /pfad/zum/film.mov
```

Höhere Auflösungen bringen nichts: Das Bild wird ohnehin auf Fernsehauflösung von damals
heruntergerechnet.

### Einzelne Filme auswählen

In der Fernbedienung unter „Filme auswählen“ steht jeder Sender mit seinen Filmen zum
Ankreuzen. Abgewählte Filme laufen nicht mit; ein Sender ohne ausgewählte Filme verschwindet
aus der Liste. Praktisch, wenn ein Ordner oder ein Album des Handys mehr enthält, als gezeigt
werden soll. Die Auswahl steht in den Einstellungen unter `hiddenFiles`.

## Internet-Sender

Ein Sender kann statt eigener Dateien Filme aus dem Internet zeigen. Anlegen in der
Fernbedienung unter „Internet-Sender“ (Name und eine Adresse pro Zeile) oder in `config.json`.
YouTube-Adressen und andere Adressen gehören in getrennte Sender.

### archive.org und direkte Videoadressen

archive.org liefert die Videodateien selbst aus. Der eingebaute Server holt sie ab und reicht
sie an die Anzeige weiter; so laufen diese Filme wie eigene Dateien durch die **volle**
Röhrensimulation, ohne Werbung. (Direkt darf der Browser fremde Videos nicht in die Simulation
holen – auch die von archive.org nicht.)

```json
"web": {
  "channels": [
    { "name": "Werbefernsehen 1977", "urls": ["https://archive.org/details/Commercials_de_1970s#1977"] }
  ]
}
```

- `https://archive.org/details/KENNUNG` nimmt alle Filme des Eintrags; hinter `#` steht ein
  Filter (nur Dateien, deren Name so beginnt).
- Eine direkte Adresse auf eine Videodatei (`….mp4`, `….webm`) geht ebenfalls, auch von
  anderen Servern. Der eingebaute Server ruft nur archive.org und die Server ab, die in einem
  Internet-Sender eingetragen sind. In der Android-App müssen die Adressen mit `https://` beginnen.
- Die Filmliste eines Eintrags wird einmal täglich neu abgefragt.

### Vorschläge: Fernsehen von 1977

Unter „Internet-Sender → Vorschläge: Fernsehen von 1977“ lassen sich fertige Sender mit einem
Klick anlegen (Liste in `public/js/presets1977.js`):

| Sender | Quelle | Inhalt |
| --- | --- | --- |
| Werbefernsehen 1977 | archive.org | rund 80 deutsche Werbespots mit Jahr 1977 im Dateinamen, etwa 37 Minuten |
| Nachrichten 1977 | YouTube | Tagesschau (26.5., 12.10., 13.10., 24.12.), Sondersendung (19.10.), ZDF heute (5.3. mit Sendeschluss, 4.9.) |
| Samstagabend 1977 | YouTube | Am laufenden Band (20.8., 17.9., Silvester), ZDF-Hitparade (1.10., 29.10., 26.11.), Musikladen (13.8.) |
| ZDF-Werbung und Ansagen 1977 | YouTube | Werbeblöcke mit Mainzelmännchen (27.10.), Programmansage (11.6.) |
| Fernsehen 1977 | archive.org | Spiel ohne Grenzen (7.9., Teil 1), ZDF-Reportage (17.4.), Schul-Lehrfilm |
| DDR-Wochenschau 1977 | YouTube | DEFA „Der Augenzeuge“ 1977/10 und 1977/40 (offizieller Kanal DEFA Filmwelt) |
| DDR-Fernsehen 1977 | archive.org | vier Filme des DDR-Fernsehens und der DEFA |

Recherchiert im November 2026. Das Jahr stammt aus Titel, Dateiname oder Beschreibung des
jeweiligen Uploads, meist mit genauem Sendedatum; Existenz und Einbettbarkeit wurden bei
archive.org und YouTube abgefragt, gesichtet wurden die Filme nicht.

> **Rechte:** Fast alle diese Aufnahmen haben private Sammler hochgeladen, nicht die Sender.
> Sie können jederzeit verschwinden, und dass sie im Netz stehen, erlaubt noch keine öffentliche
> Vorführung. Für die Ausstellung sollten die Rechte mit den Sendern geklärt werden (ARD/ZDF,
> für Dreieich und den Hessentag 1977 am ehesten das Archiv des Hessischen Rundfunks, für die
> DDR-Filme die DEFA-Stiftung) – oder die Vorschläge dienen nur zum Ausprobieren.

### YouTube

Ein Sender kann Videos oder Playlists von YouTube zeigen:

```json
"youtube": {
  "channels": [
    { "name": "Hessenschau", "urls": ["https://www.youtube.com/watch?v=…", "https://www.youtube.com/playlist?list=…"] }
  ]
}
```

Auch ein Ordner in `media` kann ein YouTube-Sender sein und steht dann an der Stelle seines
Ordnernamens: `channel.json` mit `{ "type": "youtube", "urls": ["…"] }`.

- **Steuerung wie bei eigenen Filmen:** Pause, Film neu starten, nächster/vorheriger Film,
  Springen, Lautstärke. Die Videos laufen nacheinander in Endlosschleife und im Hintergrund
  weiter. Die Länge eines Videos lernt der Player beim ersten Abspielen; bis dahin rechnet die
  Sendeuhr mit einem Schätzwert. Eine Live-Übertragung läuft einfach live.
- **Effekte:** Das Bild von YouTube lässt sich technisch nicht durch die Röhrensimulation
  schicken. Stattdessen liegen Röhrenform, Zeilen, Maske, Glas, Rauschen sowie das Rauschen beim
  Umschalten und die Ein-/Ausschaltanimation als Schicht darüber; Wölbung, Farbe und
  Schwarz-Weiß wirken über Filter des Browsers direkt auf das Bild. Ob ein Gerät diese Filter auf
  Videos anwendet, hängt von seinem Browser ab; die Statusanzeige (Taste I, in der Fernbedienung
  unter „System“) zeigt, was er angenommen hat. Solange ein YouTube-Video angehalten ist,
  verdecken Blenden YouTubes eigene Einblendungen (Titel, „Weitere Videos“). Farbunschärfe, Geisterbild, Nachleuchten und der Lautsprecherklang gibt es nur
  für eigene Dateien. Breitbild wird wie bei eigenen Filmen formatfüllend beschnitten.
- **Voraussetzungen und Grenzen:** Internetverbindung am Ausstellungsort; YouTube kann Werbung
  einblenden; Videos, deren Besitzer das Einbetten verbieten, sowie gelöschte oder private
  Videos werden übersprungen (die Fernbedienung meldet es). Automatischer Start mit Ton
  funktioniert im Kioskmodus (Startskript) und in der Android-App. Wer die volle Simulation und
  einen Betrieb ohne Internet braucht, nimmt eigene Filmdateien.
- Ruckelt ein YouTube-Sender, in der Fernbedienung unter „Bild → Umschalten und Leistung“ die
  „Wölbung auch für das YouTube-Bild“ abschalten.

## Bedienung

### Tasten

| Taste | Funktion |
| --- | --- |
| ↑ / ↓ (auch → / ←, Bild↑ / Bild↓, Mausrad) | Sender vor / zurück |
| 1 … 9, 0 | Sender direkt wählen |
| Leertaste | Pause / weiter (hält alle Sender an) |
| R | laufenden Film neu starten |
| Umschalt+R | diesen Sender von vorn |
| Pos1 | alle Sender von vorn |
| N / B | nächster / vorheriger Film |
| . / , | 30 Sekunden vor / zurück |
| + / − | Lautstärke |
| M | Ton aus / an |
| P | Fernseher aus- / einschalten |
| E | Röhreneffekte aus / an |
| I oder F1 | Statusanzeige |
| F2 | Einstellungen (Fernbedienung) einblenden |
| F5 | Anzeige neu laden |
| Strg+Umschalt+Q | TV-Simulator beenden |

Die Belegung lässt sich in `config.json` unter `"keys"` ändern.

### Fernbedienung

Unter <http://localhost:7777/admin> (oder F2 an der Anzeige) gibt es eine Bedienseite mit
allen Funktionen, Reglern für jedes Detail der Röhrensimulation, Voreinstellungen
(„Farbfernseher 1977“, „Schwarz-Weiß“, „Schlechter Empfang“, „Dezent“, „Ohne Effekte“) und
einer Zeitsteuerung (täglich ein-/ausschalten, alle Sender zu einer Uhrzeit von vorn).

Damit die Seite auch vom Handy oder Laptop im selben Netzwerk erreichbar ist, in
`config.json` `"host": "0.0.0.0"` setzen und einen `"pin"` vergeben; Adresse ist dann
`http://<Adresse des Rechners>:7777/admin`.

### Drehregler am Fernseher

Der Senderknopf muss sich nur als USB-Tastatur melden – dann ist an der Software nichts
zu ändern. Möglichkeiten:

- **Arduino Pro Micro mit Drehgeber oder Stufenschalter:** Beispiel in
  `hardware/senderknopf/senderknopf.ino`. Der Drehgeber schaltet pro Raste einen Sender
  weiter (Pfeiltasten), ein Stufenschalter wählt feste Sender (Tasten 1–9, 0). Das Beispiel
  ist noch nicht an echter Hardware erprobt.
- **Mausrad:** Die Platine einer alten USB-Maus einbauen und das Rad mit dem Knopf koppeln –
  das Mausrad schaltet ebenfalls die Sender (alternativ die Lautstärke: `"input": { "wheel": "volume" }`).
- **Fertiger USB-Drehknopf** („Lautstärkeknopf“), der sich auf Pfeiltasten umstellen lässt.

Ein zweiter Knopf für die Lautstärke geht genauso (Tasten + und −).

## Android-App

Die App zeigt dieselbe Anzeige wie am PC – Röhrensimulation, gleichzeitig laufende Sender,
Fernbedienung – und bringt ihren eigenen kleinen Server mit. Gedacht zum Ausprobieren auf dem
Handy und für Android-Displays; Schwerpunkt des Projekts bleiben PC und Raspberry Pi.

**Voraussetzungen:** Android 7 oder neuer und ein halbwegs aktuelles „Android System WebView“
(Version 86 oder neuer; wird über den Play Store aktualisiert).

**Installieren:** Die Datei `app-debug.apk` auf das Gerät kopieren und antippen; Android fragt
dabei einmal nach der Erlaubnis, Apps aus dieser Quelle zu installieren.

**Bedienen**

| Geste | Funktion |
| --- | --- |
| Wischen (links/oben = vor, rechts/unten = zurück) | Sender wechseln |
| Lange drücken | Einstellungen und Fernbedienung einblenden |
| Zurück | Einstellungen schließen; zweimal kurz hintereinander beendet die App |

Eine per USB angeschlossene Tastatur oder ein Drehregler funktioniert wie am PC. Für
Besucher-Displays lässt sich das lange Drücken abschalten (`"input": { "touchMenu": false }`).

**Filme:** Beim ersten Start fragt die App, woher die Filme kommen sollen; später geht es über
lange drücken → „Filme“. Es gibt drei Wege, die sich kombinieren lassen:

- **Alben vom Gerät** – Kamera, Downloads, WhatsApp usw., also alles, was auch Google Fotos
  unter „Auf dem Gerät“ zeigt. Android fragt dafür einmal nach dem Zugriff auf Videos; danach
  wird jedes angekreuzte Album ein Sender. Ab Android 14 lässt sich der Zugriff auch auf
  einzelne Videos beschränken.
- **Einzelne Videos** – öffnet die Auswahl des Systems, in der auch Videos aus Google Fotos
  (auch nur in der Cloud gespeicherte) erscheinen. Dafür ist keine Berechtigung nötig. Die
  gewählten Videos bilden den Sender „Meine Auswahl“; weitere Auswahlen werden angehängt.
- **Ordner mit Sendern** – ein Ordner auf dem Gerät, der SD-Karte oder einem USB-Stick mit
  derselben Struktur wie oben (Unterordner = Sender). Eine `config.json` wird, falls vorhanden,
  aus diesem Ordner gelesen.

Zusätzlich liest die App immer ihren eigenen Ordner (Pfad steht in den Einstellungen).
Soll nicht ein ganzes Album oder ein ganzer Ordner laufen, lassen sich die Filme unter
„Filme auswählen“ einzeln an- und abwählen.
Hochkant gefilmte Videos werden ganz gezeigt statt beschnitten. YouTube-Sender funktionieren
in der App wie am PC.

**Fernbedienung von einem anderen Gerät:** in dieser `config.json` `"server": { "host": "0.0.0.0", "pin": "…" }`
eintragen, App neu starten, dann `http://<Adresse des Geräts>:7777/admin` aufrufen.

**Dauerbetrieb auf Displays:** Der Bildschirm bleibt an, solange die App läuft, und die Anzeige
wird neu aufgebaut, falls sie abstürzt oder hängt. Den Start nach dem Einschalten übernimmt
der Kioskmodus bzw. die Autostart-Einstellung des Displays – Android erlaubt Apps nicht, sich
selbst nach dem Hochfahren in den Vordergrund zu holen.

**Selbst bauen** (JDK 17 oder neuer; das Android-SDK lädt bei Bedarf `android/install-sdk.sh`):

```bash
cd android
```

```bash
./gradlew assembleDebug
```

Die APK liegt danach in `android/app/build/outputs/apk/debug/`. Sie ist mit dem Testschlüssel
des bauenden Rechners signiert: Wer eine auf einem anderen Rechner gebaute Fassung darüber
installieren will, muss die App vorher deinstallieren. Für eine dauerhafte Verteilung einen
eigenen Signaturschlüssel einrichten.

## Einbau in die Kiste

In der Fernbedienung unter „Einbau in das Gehäuse“ wird das Bild verschoben, skaliert,
gedehnt und gedreht, bis es genau in den Ausschnitt passt (auch hochkant eingebaute
Monitore: Drehung 90°). „Bild vergrößern (Overscan)“ lässt wie früher einen Rand hinter
der Blende verschwinden. Wölbung und runde Ecken stehen unter „Bild → Bildröhre“.

Tipp: Die Blende der Kiste sollte den geraden Rand des Monitors verdecken; die gewölbte
Bildkante zeichnet die Software.

## Einstellungen

`config.json` enthält die wichtigsten Werte und darf Kommentare enthalten. Alle weiteren
Einstellungen samt Standardwerten und Erklärung stehen in `server/defaults.jsonc`.
Was in der Fernbedienung verstellt wird, landet in `data/state.json` und hat Vorrang;
„Alle Einstellungen zurücksetzen“ hebt das wieder auf. Ein Tippfehler in `config.json`
legt nichts lahm – die Datei wird dann ignoriert und die Fernbedienung zeigt eine Warnung.

## Dauerbetrieb – Checkliste

- **Rechner startet von selbst:** im BIOS „nach Stromausfall einschalten“ aktivieren,
  automatische Anmeldung einrichten, Autostart-Skript ausführen (siehe oben). Dann genügt
  eine Zeitschaltuhr oder der Hauptschalter der Ausstellung.
- **Energiesparen aus:** Bildschirm und Rechner dürfen nie in den Ruhezustand gehen
  (Windows: Energieoptionen; Raspberry Pi: `sudo raspi-config` → Display → Screen Blanking aus).
- **Windows:** Benachrichtigungen abschalten, Nutzungszeit für Updates festlegen.
- **Programm morgens von vorn:** in der Fernbedienung unter „Zeitsteuerung“ eine Uhrzeit bei
  „Alle Sender von vorn“ eintragen, falls gewünscht.
- Die Anzeige lädt sich täglich um 04:30 Uhr vorsorglich neu; das Programm läuft danach
  nahtlos weiter.
- Fehler und Neustarts stehen in `data/tv.log`.

## Wenn etwas nicht stimmt

| Beobachtung | Abhilfe |
| --- | --- |
| Tafel „Bildstörung“ | Der Film lässt sich nicht abspielen. Datei mit `scripts/video-umwandeln` umwandeln. Die Fernbedienung nennt die Datei. |
| Kein Ton, Hinweis „Ton ist vom Browser gesperrt“ | Über das Startskript starten (Kioskmodus) – beim direkten Aufruf im Browser erst eine Taste drücken. |
| Bild ruckelt (Raspberry Pi) | Fernbedienung → Bild → „Umschalten und Leistung“: Auflösung der Darstellung verringern oder Bilder pro Sekunde auf 25 begrenzen; Monitor auf 1280×720 stellen. |
| Streifenmuster (Moiré) im Bild | „Anzahl Zeilen“ oder „Größe der Maske“ ändern, oder Zeilenstruktur/Maske schwächer stellen. |
| „Kein Browser gefunden“ | Chrome, Edge oder Chromium installieren oder den Pfad in `config.json` unter `"kiosk": { "browserPath": "…" }` eintragen. |
| Meldung „NOTBETRIEB“ in der Statusanzeige | Der Rechner bietet keine Grafikbeschleunigung (WebGL); die Filme laufen dann ohne Röhreneffekte. |

## Technik

- `server.js`, `server/` – kleiner Webserver ohne Abhängigkeiten: liefert Anzeige und Filme
  aus, speichert Einstellungen, startet und überwacht den Browser (`--kiosk`).
- `public/` – die Anzeige (WebGL): `shaders.js` Röhrensimulation, `broadcast.js` Sendeuhr,
  `player.js` Wiedergabe und Fehlerbehandlung, `director.js` Animationen, `audio.js` Ton,
  `online.js` Internet-Sender (archive.org), `youtube.js` und `overlay.js` YouTube-Sender und
  ihre Effektschicht, `presets1977.js` Vorschläge; `admin.*` Fernbedienung.
- `android/` – die Android-App: eine WebView mit derselben Anzeige und ein eingebauter Server
  in Java (`…/server/`), der sich nach außen wie `server.js` verhält. Die Anzeige wird beim
  Bauen aus `public/` in die App gepackt, die Standardwerte aus `server/defaults.jsonc`.
- Tests: `npm test` (Sendeuhr, Server, Android-Server im Vergleich) und `npm run test:e2e`
  (kompletter Durchlauf im Browser; benötigt ffmpeg und das npm-Paket `playwright`). Mit
  `TV_E2E_SERVER=java npm run test:e2e` läuft derselbe Durchlauf gegen den Server der
  Android-App. `cd android && ./gradlew lintDebug testDebugUnitTest` prüft die App selbst.
