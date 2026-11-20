import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

/** Sucht einen Chromium-basierten Browser (Chrome, Chromium oder Edge). */
export function findBrowser(configuredPath) {
  if (configuredPath) return fs.existsSync(configuredPath) ? configuredPath : null;

  if (process.platform === 'win32') {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
    const relative = ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe', 'Chromium\\Application\\chrome.exe'];
    for (const rel of relative) {
      for (const root of roots) {
        const candidate = path.join(root, rel);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
    return null;
  }

  if (process.platform === 'darwin') {
    const apps = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
    return apps.find((p) => fs.existsSync(p)) ?? null;
  }

  const names = ['chromium-browser', 'chromium', 'google-chrome-stable', 'google-chrome', 'microsoft-edge'];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Startet den Browser im Vollbild und überwacht ihn: Stürzt er ab oder
 * meldet sich die Anzeige nicht mehr, wird er neu gestartet.
 */
export class Kiosk {
  constructor({ url, profileDir, settings, log = console }) {
    this.url = url;
    this.profileDir = profileDir;
    this.settings = settings;
    this.log = log;
    this.child = null;
    this.stopping = false;
    this.startedAt = 0;
    this.lastHeartbeat = 0;
    this.restarts = 0;
    this.quickExits = 0;
    this.timer = null;
    this.respawnTimer = null;
  }

  buildArgs(exe) {
    const args = [
      '--kiosk',
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-infobars',
      '--noerrdialogs',
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
      '--disable-features=Translate,TranslateUI,MediaRouter,GlobalMediaControls',
      '--disable-pinch',
      '--overscroll-history-navigation=0',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--check-for-update-interval=31536000',
      '--disable-component-update',
    ];
    if (process.platform === 'linux') {
      args.push('--password-store=basic', '--ignore-gpu-blocklist');
      if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
    }
    if (/msedge/i.test(path.basename(exe))) args.push('--edge-kiosk-type=fullscreen');
    const extra = Array.isArray(this.settings.extraArgs) ? this.settings.extraArgs : [];
    const envExtra = (process.env.TV_BROWSER_ARGS || '').split(' ').filter(Boolean);
    args.push(...extra, ...envExtra, this.url);
    return args;
  }

  /** Verhindert die Meldung "Chrome wurde nicht richtig beendet". */
  markCleanExit() {
    const prefs = path.join(this.profileDir, 'Default', 'Preferences');
    try {
      if (!fs.existsSync(prefs)) return;
      const text = fs.readFileSync(prefs, 'utf8');
      const fixed = text.replace(/"exit_type":"[^"]*"/, '"exit_type":"Normal"').replace(/"exited_cleanly":false/, '"exited_cleanly":true');
      if (fixed !== text) fs.writeFileSync(prefs, fixed);
    } catch {
      // nicht kritisch
    }
  }

  /**
   * Beendet einen Browser, der von einem früheren Lauf übrig ist (z. B. nach einem
   * Absturz des Servers). Sonst würde Chrome nur ein weiteres Fenster im alten Prozess öffnen.
   */
  killLeftovers() {
    try {
      if (process.platform === 'win32') {
        const dir = this.profileDir.replace(/'/g, "''");
        const script =
          `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('--user-data-dir=${dir}') } | ` +
          'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
        spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', timeout: 20000, windowsHide: true });
        return;
      }
      const lock = path.join(this.profileDir, 'SingletonLock');
      const pid = Number(/-(\d+)$/.exec(fs.readlinkSync(lock))?.[1]);
      if (!pid || pid === process.pid) return;
      if (process.platform === 'linux') {
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (!cmdline.includes(this.profileDir)) return;
      }
      this.log.warn(`Beende übrig gebliebenen Browser (Prozess ${pid}).`);
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    } catch {
      // kein alter Browser vorhanden
    }
  }

  start() {
    this.stopping = false;
    const exe = findBrowser(this.settings.browserPath);
    if (!exe) {
      this.log.error(
        'Kein Browser gefunden. Bitte Google Chrome, Chromium oder Microsoft Edge installieren ' +
          'oder den Pfad in config.json unter "kiosk.browserPath" eintragen.'
      );
      this.respawnTimer = setTimeout(() => this.start(), 30000);
      return;
    }
    fs.mkdirSync(this.profileDir, { recursive: true });
    this.killLeftovers();
    this.markCleanExit();
    const args = this.buildArgs(exe);
    this.log.info(`Starte Browser: ${exe}`);
    this.startedAt = Date.now();
    this.lastHeartbeat = 0;
    let child;
    try {
      // eigene Prozessgruppe, damit bei einem Hänger alle Browserprozesse beendet werden können
      child = spawn(exe, args, { stdio: 'ignore', detached: process.platform !== 'win32' });
    } catch (err) {
      this.log.error(`Browser konnte nicht gestartet werden: ${err.message}`);
      this.respawnTimer = setTimeout(() => this.start(), 10000);
      return;
    }
    this.child = child;
    child.on('error', (err) => this.log.error(`Browserfehler: ${err.message}`));
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      if (this.stopping) return;
      const lifetime = Date.now() - this.startedAt;
      this.quickExits = lifetime < 15000 ? this.quickExits + 1 : 0;
      const delay = Math.min(60000, 2000 * 2 ** Math.min(this.quickExits, 5));
      this.restarts++;
      this.log.warn(`Browser beendet (Code ${code}). Neustart in ${Math.round(delay / 1000)} s.`);
      this.respawnTimer = setTimeout(() => this.start(), delay);
    });
    if (!this.timer) {
      this.timer = setInterval(() => this.check(), 5000);
      this.timer.unref?.();
    }
  }

  heartbeat() {
    this.lastHeartbeat = Date.now();
  }

  check() {
    if (!this.child || this.stopping) return;
    const timeout = Math.max(20, Number(this.settings.heartbeatTimeout) || 60) * 1000;
    const reference = Math.max(this.lastHeartbeat, this.startedAt + 30000);
    if (Date.now() - reference > timeout) {
      this.log.warn('Die Anzeige meldet sich nicht mehr. Browser wird neu gestartet.');
      this.kill();
    }
  }

  kill() {
    const child = this.child;
    if (!child) return;
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => child.kill());
    } else {
      const signal = (name) => {
        try {
          process.kill(-child.pid, name);
        } catch {
          child.kill(name);
        }
      };
      signal('SIGTERM');
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) signal('SIGKILL');
      }, 4000);
      timer.unref?.();
    }
  }

  restart() {
    if (this.child) this.kill();
    else this.start();
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.respawnTimer);
    clearInterval(this.timer);
    this.timer = null;
    this.kill();
  }
}
