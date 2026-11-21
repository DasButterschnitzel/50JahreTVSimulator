# TV-Simulator 1977

Ausstellungs-Videoplayer für „50 Jahre Dreieich“: Ein ausrangierter Monitor in einer
Holzkiste wird zum Fernseher von 1977. Die Software spielt Filme in Endlosschleife
und rechnet das Bild so um, dass es wie auf einer alten Bildröhre aussieht.

- **Mehrere Sender, die gleichzeitig laufen.** Jeder Ordner mit Filmen ist ein Sender.
  Alle Sender „senden“ weiter, auch wenn gerade ein anderer eingestellt ist – wer
  umschaltet, landet mitten im laufenden Programm.
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
> Auf einem echten Windows-PC, einem echten Raspberry Pi, einem echten Android-Gerät und
> mit dem Drehregler-Beispiel wurde noch nicht getestet – bitte vor der Ausstellung einen
> Probelauf über mehrere Tage auf dem Zielgerät einplanen.

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
| `type` | `"video"` (Standard), `"testcard"` = Testbild, `"noise"` = Sender ohne Signal (Rauschen) |
| `blackWhite` | `true` = dieser Sender wird schwarz-weiß gezeigt |
| `fit` | Breitbild-Filme: `"fill"` formatfüllend beschneiden (Standard), `"fit"` ganz zeigen, `"stretch"` verzerren |
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

**Filme:** Lange drücken → „Filmordner wählen“ und einen Ordner auf dem Gerät, der SD-Karte
oder einem USB-Stick freigeben. Darin gilt dieselbe Ordnerstruktur wie oben (Unterordner =
Sender). Alternativ die Filme in den Ordner der App kopieren; die Einstellungen zeigen den
genauen Pfad. Eine `config.json` wird, falls vorhanden, aus dem Filmordner gelesen.

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
  `player.js` Wiedergabe und Fehlerbehandlung, `director.js` Animationen, `audio.js` Ton;
  `admin.*` Fernbedienung.
- `android/` – die Android-App: eine WebView mit derselben Anzeige und ein eingebauter Server
  in Java (`…/server/`), der sich nach außen wie `server.js` verhält. Die Anzeige wird beim
  Bauen aus `public/` in die App gepackt, die Standardwerte aus `server/defaults.jsonc`.
- Tests: `npm test` (Sendeuhr, Server, Android-Server im Vergleich) und `npm run test:e2e`
  (kompletter Durchlauf im Browser; benötigt ffmpeg und das npm-Paket `playwright`). Mit
  `TV_E2E_SERVER=java npm run test:e2e` läuft derselbe Durchlauf gegen den Server der
  Android-App. `cd android && ./gradlew lintDebug testDebugUnitTest` prüft die App selbst.
