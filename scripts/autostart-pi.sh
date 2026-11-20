#!/bin/sh
# Richtet den Autostart unter Raspberry Pi OS (Desktop) ein.
# Entfernen:  rm ~/.config/autostart/tv-simulator.desktop
#             und die Zeile mit start-pi.sh aus ~/.config/labwc/autostart loeschen
APPDIR="$(cd "$(dirname "$0")/.." && pwd)"
chmod +x "$APPDIR/start-pi.sh"

mkdir -p "$HOME/.config/autostart"
cat > "$HOME/.config/autostart/tv-simulator.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=TV-Simulator 1977
Exec="$APPDIR/start-pi.sh"
X-GNOME-Autostart-enabled=true
DESKTOP

# Neuere Raspberry-Pi-OS-Versionen (labwc) haben eine eigene Autostart-Datei.
# Ein doppelter Start schadet nicht: Die zweite Instanz beendet sich von selbst.
if command -v labwc >/dev/null 2>&1; then
  mkdir -p "$HOME/.config/labwc"
  touch "$HOME/.config/labwc/autostart"
  if ! grep -qF "$APPDIR/start-pi.sh" "$HOME/.config/labwc/autostart"; then
    echo "\"$APPDIR/start-pi.sh\" &" >> "$HOME/.config/labwc/autostart"
  fi
fi

echo "Autostart eingerichtet. Der TV-Simulator startet ab jetzt nach dem Anmelden am Desktop."
