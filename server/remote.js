// Abruf von Filmen aus dem Internet über den eigenen Server.
//
// Fremde Server (auch archive.org) erlauben dem Browser meist nicht, ihre Videos als Bildquelle
// für die Röhrensimulation zu benutzen. Deshalb holt der Server die Datei selbst ab und reicht
// sie – samt Teilabrufen zum Springen im Film – an die Anzeige weiter.
import { Readable } from 'node:stream';

const MAX_REDIRECTS = 5;
const CONNECT_TIMEOUT_MS = 30000;
const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];

/** Hosts, zu denen der Server Filme abrufen darf: archive.org und die Server der eingetragenen Internet-Sender. */
export function allowedRemoteHosts(settings) {
  const hosts = new Set();
  const list = Array.isArray(settings?.web?.channels) ? settings.web.channels : [];
  for (const channel of list) {
    for (const entry of Array.isArray(channel?.urls) ? channel.urls : []) {
      if (typeof entry !== 'string') continue;
      try {
        const url = new URL(/^[a-z]+:\/\//i.test(entry) ? entry : `https://${entry}`);
        if (url.protocol === 'https:' || url.protocol === 'http:') hosts.add(url.host.toLowerCase());
      } catch {
        // keine Adresse
      }
    }
  }
  return hosts;
}

export function isRemoteAllowed(url, hosts) {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.username || url.password) return false;
  const name = url.hostname.toLowerCase();
  if (name === 'archive.org' || name.endsWith('.archive.org')) return true;
  return hosts.has(url.host.toLowerCase());
}

/** Reicht die Datei hinter target an die Anzeige weiter. */
export async function proxyRemote(req, res, target, settings) {
  const hosts = allowedRemoteHosts(settings);
  let url;
  try {
    url = new URL(target);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const headers = { 'User-Agent': 'TV-Simulator-1977', Accept: '*/*' };
  if (req.headers.range) headers.Range = req.headers.range;
  if (req.headers['if-range']) headers['If-Range'] = req.headers['if-range'];

  try {
    let upstream;
    for (let hop = 0; ; hop++) {
      // jede Station einzeln prüfen – auch Weiterleitungen dürfen nur zu erlaubten Servern führen
      if (!isRemoteAllowed(url, hosts)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Dieser Server ist nicht als Internet-Sender eingetragen.');
        return;
      }
      const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
      try {
        upstream = await fetch(url, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers, redirect: 'manual', signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      const location = upstream.headers.get('location');
      if (upstream.status >= 300 && upstream.status < 400 && location) {
        await upstream.body?.cancel().catch(() => {});
        if (hop >= MAX_REDIRECTS) throw new Error('zu viele Weiterleitungen');
        url = new URL(location, url);
        continue;
      }
      break;
    }
    const out = { 'Cache-Control': 'no-store' };
    for (const name of PASS_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) out[name] = value;
    }
    res.writeHead(upstream.status, out);
    if (req.method === 'HEAD' || !upstream.body) {
      res.end();
      return;
    }
    const body = Readable.fromWeb(upstream.body);
    body.on('error', () => res.destroy());
    body.pipe(res);
  } catch (err) {
    if (res.headersSent) res.destroy();
    else res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`Abruf fehlgeschlagen: ${err.name === 'AbortError' ? 'keine Antwort' : err.message}`);
  }
}
