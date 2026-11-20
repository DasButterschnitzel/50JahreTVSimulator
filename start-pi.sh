#!/bin/sh
# TV-Simulator 1977 - Start unter Raspberry Pi OS / Linux.
# Beenden: an der Anzeige Strg+Umschalt+Q druecken.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js fehlt. Installation:  sudo apt install nodejs"
  exit 1
fi

# Bildschirmschoner und Abschalten des Monitors verhindern (nur X11)
if [ -n "$DISPLAY" ] && command -v xset >/dev/null 2>&1; then
  xset s off
  xset -dpms
  xset s noblank
fi

while true; do
  node server.js --kiosk "$@"
  code=$?
  [ "$code" -eq 0 ] && break
  if [ "$code" -eq 2 ]; then
    echo "Der TV-Simulator laeuft bereits oder der Port ist belegt."
    exit 2
  fi
  echo "Der TV-Simulator wurde unerwartet beendet. Neustart in 5 Sekunden ..."
  sleep 5
done
