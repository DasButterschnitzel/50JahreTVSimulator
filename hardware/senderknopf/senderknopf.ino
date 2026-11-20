// Senderknopf für den TV-Simulator 1977
//
// Ein Arduino Pro Micro / Leonardo (ATmega32U4) meldet sich am USB als Tastatur.
// Der TV-Simulator braucht dafür keine Treiber und keine Änderung.
//
// Zwei Bauarten sind möglich (unten mit BAUART auswählen):
//
//   BAUART 1 – Drehgeber (Encoder, z. B. KY-040 oder ALPS EC11) mit Rastung:
//              jede Raste schaltet einen Sender vor oder zurück (Pfeiltasten).
//              Der eingebaute Taster schaltet den Fernseher ein und aus (Taste P).
//
//   BAUART 2 – Stufenschalter mit festen Stellungen (z. B. 1x12):
//              jede Stellung ist ein Sender (Tasten 1 bis 9 und 0). Zwischen zwei
//              Stellungen ist kurz kein Kontakt – wie beim echten Kanalwähler.
//
// Benötigte Bibliothek: "Keyboard" (in der Arduino-IDE enthalten).
//
// Hinweis: Dieses Beispiel wurde ohne die Hardware geschrieben und ist ungetestet.
// Vor dem Einbau mit einem Texteditor ausprobieren: Drehen muss Zeichen bzw.
// Cursorbewegungen erzeugen.

#include <Keyboard.h>

#define BAUART 1

// ---------------------------------------------------------------- Bauart 1: Drehgeber
// Anschluss: CLK -> Pin 2, DT -> Pin 3, SW -> Pin 4, + -> VCC, GND -> GND
const uint8_t PIN_CLK = 2;
const uint8_t PIN_DT = 3;
const uint8_t PIN_SW = 4;
const int8_t SCHRITTE_PRO_RASTE = 4; // die meisten Drehgeber liefern 4 Flanken pro Raste, manche 2

// ---------------------------------------------------------------- Bauart 2: Stufenschalter
// Der gemeinsame Kontakt des Schalters liegt an GND, jede Stellung an einem eigenen Pin.
const uint8_t STUFEN_PINS[] = {2, 3, 4, 5, 6, 7, 8, 9, 10, 16};
const char STUFEN_TASTEN[] = {'1', '2', '3', '4', '5', '6', '7', '8', '9', '0'};
const uint8_t STUFEN = sizeof(STUFEN_PINS);

void tippen(uint8_t taste) {
  Keyboard.press(taste);
  delay(12);
  Keyboard.release(taste);
}

#if BAUART == 1

// Übergangstabelle des Drehgebers: unterdrückt Prellen ohne zusätzliche Bauteile
const int8_t TABELLE[16] = {0, -1, 1, 0, 1, 0, 0, -1, -1, 0, 0, 1, 0, 1, -1, 0};
uint8_t zustand = 0;
int8_t zaehler = 0;
bool tasterAlt = HIGH;
unsigned long tasterZeit = 0;

void setup() {
  pinMode(PIN_CLK, INPUT_PULLUP);
  pinMode(PIN_DT, INPUT_PULLUP);
  pinMode(PIN_SW, INPUT_PULLUP);
  zustand = (digitalRead(PIN_CLK) << 1) | digitalRead(PIN_DT);
  Keyboard.begin();
}

void loop() {
  zustand = ((zustand << 2) | (digitalRead(PIN_CLK) << 1) | digitalRead(PIN_DT)) & 0x0F;
  zaehler += TABELLE[zustand];
  if (zaehler >= SCHRITTE_PRO_RASTE) {
    zaehler = 0;
    tippen(KEY_UP_ARROW); // Sender vor
  } else if (zaehler <= -SCHRITTE_PRO_RASTE) {
    zaehler = 0;
    tippen(KEY_DOWN_ARROW); // Sender zurück
  }

  bool taster = digitalRead(PIN_SW);
  if (taster != tasterAlt && millis() - tasterZeit > 50) {
    tasterZeit = millis();
    tasterAlt = taster;
    if (taster == LOW) tippen('p'); // ein/aus
  }
  delay(1);
}

#else

int8_t stellungAlt = -1;
int8_t kandidat = -1;
unsigned long kandidatZeit = 0;

void setup() {
  for (uint8_t i = 0; i < STUFEN; i++) pinMode(STUFEN_PINS[i], INPUT_PULLUP);
  Keyboard.begin();
}

void loop() {
  int8_t stellung = -1;
  for (uint8_t i = 0; i < STUFEN; i++) {
    if (digitalRead(STUFEN_PINS[i]) == LOW) stellung = i;
  }
  if (stellung != kandidat) {
    kandidat = stellung;
    kandidatZeit = millis();
  }
  // Stellung muss 30 ms stabil anliegen, bevor sie gilt
  if (kandidat >= 0 && kandidat != stellungAlt && millis() - kandidatZeit > 30) {
    stellungAlt = kandidat;
    tippen(STUFEN_TASTEN[kandidat]);
  }
  delay(2);
}

#endif
