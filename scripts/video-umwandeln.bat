@echo off
rem Wandelt Filme in ein Format um, das ueberall fluessig laeuft:
rem MP4 (H.264/AAC), 576 Zeilen, 25 Bilder/s, einheitliche Lautstaerke.
rem Benutzung: Filmdateien auf diese Datei ziehen. Die Ergebnisse liegen
rem neben den Originalen und enden auf "-tv.mp4". Benoetigt ffmpeg (https://ffmpeg.org).
setlocal
where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo ffmpeg wurde nicht gefunden. Bitte von https://ffmpeg.org installieren.
  pause
  exit /b 1
)
if "%~1"=="" (
  echo Bitte Filmdateien auf diese Datei ziehen.
  pause
  exit /b 1
)
:next
if "%~1"=="" goto done
echo Wandle um: %~nx1
ffmpeg -hide_banner -loglevel warning -stats -y -i "%~1" -map 0:v:0 -map 0:a:0? -vf "yadif=deint=interlaced,scale=-2:576,fps=25,format=yuv420p" -c:v libx264 -preset medium -crf 20 -profile:v high -level 4.0 -g 25 -af "loudnorm=I=-18:TP=-2:LRA=11" -c:a aac -b:a 128k -ar 48000 -ac 2 -movflags +faststart "%~dpn1-tv.mp4"
if errorlevel 1 echo FEHLER bei %~nx1
shift
goto next
:done
echo Fertig.
pause
endlocal
