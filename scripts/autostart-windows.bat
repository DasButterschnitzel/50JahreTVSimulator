@echo off
rem Legt eine Verknuepfung im Autostart-Ordner an, damit der TV-Simulator
rem nach dem Anmelden von selbst startet. Zum Entfernen: Win+R, "shell:startup",
rem dort die Verknuepfung "TV-Simulator 1977" loeschen.
setlocal
pushd "%~dp0.."
set "APPDIR=%CD%"
popd
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\TV-Simulator 1977.lnk'); $s.TargetPath=$env:APPDIR+'\start-windows.bat'; $s.WorkingDirectory=$env:APPDIR; $s.WindowStyle=7; $s.Save()"
if errorlevel 1 (
  echo Die Verknuepfung konnte nicht angelegt werden.
) else (
  echo Autostart eingerichtet. Der TV-Simulator startet ab jetzt nach dem Anmelden.
)
pause
endlocal
