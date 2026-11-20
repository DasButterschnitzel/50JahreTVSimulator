#!/bin/sh
# Wandelt Filme in ein Format um, das ueberall fluessig laeuft:
# MP4 (H.264/AAC), 576 Zeilen, 25 Bilder/s, einheitliche Lautstaerke,
# ein Schluesselbild pro Sekunde (schnelles Umschalten).
#
#   scripts/video-umwandeln.sh film1.mov film2.avi ...
#
# Die Ergebnisse liegen neben den Originalen und enden auf "-tv.mp4".
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg fehlt. Installation:  sudo apt install ffmpeg"
  exit 1
fi
if [ "$#" -eq 0 ]; then
  echo "Aufruf: $0 film1 [film2 ...]"
  exit 1
fi
for input in "$@"; do
  output="${input%.*}-tv.mp4"
  echo "Wandle um: $input -> $output"
  ffmpeg -hide_banner -loglevel warning -stats -y -i "$input" \
    -map 0:v:0 -map 0:a:0? \
    -vf "yadif=deint=interlaced,scale=-2:576,fps=25,format=yuv420p" \
    -c:v libx264 -preset medium -crf 20 -profile:v high -level 4.0 -g 25 \
    -af "loudnorm=I=-18:TP=-2:LRA=11" -c:a aac -b:a 128k -ar 48000 -ac 2 \
    -movflags +faststart "$output" || echo "FEHLER bei $input"
done
