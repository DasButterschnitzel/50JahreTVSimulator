@echo off
rem TV-Simulator 1977 - Start unter Windows (Doppelklick).
rem Beenden: an der Anzeige Strg+Umschalt+Q druecken oder dieses Fenster schliessen.
setlocal
cd /d "%~dp0"
title TV-Simulator 1977

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js wurde nicht gefunden.
  echo Bitte Node.js ^(LTS^) von https://nodejs.org installieren und dieses Skript erneut starten.
  echo.
  pause
  exit /b 1
)

:loop
node server.js --kiosk %*
if %errorlevel%==0 goto end
if %errorlevel%==2 (
  echo.
  echo Der TV-Simulator laeuft bereits oder der Port ist belegt.
  pause
  goto end
)
echo.
echo Der TV-Simulator wurde unerwartet beendet. Neustart in 5 Sekunden ...
timeout /t 5 /nobreak >nul
goto loop

:end
endlocal
