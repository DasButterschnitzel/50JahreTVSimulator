package io.github.dasbutterschnitzel.tv1977.server;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;

/**
 * Der TV-Simulator-Server für die Android-App. Verhält sich nach außen wie server.js:
 * liefert Anzeige und Filme aus, speichert Einstellungen und verteilt Befehle der Fernbedienung.
 */
public final class TvServer implements HttpServer.Handler {
    private static final String JSON = "application/json; charset=utf-8";
    private static final Map<String, String> MIME = new HashMap<>();

    static {
        MIME.put(".html", "text/html; charset=utf-8");
        MIME.put(".js", "text/javascript; charset=utf-8");
        MIME.put(".mjs", "text/javascript; charset=utf-8");
        MIME.put(".css", "text/css; charset=utf-8");
        MIME.put(".json", "application/json; charset=utf-8");
        MIME.put(".svg", "image/svg+xml");
        MIME.put(".png", "image/png");
        MIME.put(".jpg", "image/jpeg");
        MIME.put(".ico", "image/x-icon");
        MIME.put(".mp4", "video/mp4");
        MIME.put(".m4v", "video/mp4");
        MIME.put(".mov", "video/mp4");
        MIME.put(".webm", "video/webm");
        MIME.put(".mkv", "video/webm");
        MIME.put(".ogv", "video/ogg");
        MIME.put(".3gp", "video/mp4");
    }

    private static final class Client {
        final Socket socket;
        final OutputStream out;
        final String role;

        Client(Socket socket, OutputStream out, String role) {
            this.socket = socket;
            this.out = out;
            this.role = role;
        }
    }

    private final Store store;
    private final AssetSource assets;
    private final Platform platform;
    private final HttpServer http = new HttpServer(this);
    private final List<Client> clients = new CopyOnWriteArrayList<>();
    private final long startedAt = System.currentTimeMillis();
    private final ScheduledExecutorService timer;
    private volatile MediaSource media;
    private volatile Object lastStatus;
    private volatile long lastStatusAt;
    private int port;

    public TvServer(Store store, AssetSource assets, MediaSource media, Platform platform) {
        this.store = store;
        this.assets = assets;
        this.media = media;
        this.platform = platform;
        timer = Executors.newSingleThreadScheduledExecutor(new ThreadFactory() {
            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "tv-timer");
                t.setDaemon(true);
                return t;
            }
        });
    }

    public Store store() {
        return store;
    }

    public int port() {
        return port;
    }

    /** Zeitpunkt des letzten Lebenszeichens der Anzeige (0 = noch keines). */
    public long lastStatusAt() {
        return lastStatusAt;
    }

    public int start(String host, int wantedPort) throws IOException {
        port = http.start(host, wantedPort);
        timer.scheduleWithFixedDelay(new Runnable() {
            @Override
            public void run() {
                store.saveIfDirty();
            }
        }, 400, 400, TimeUnit.MILLISECONDS);
        timer.scheduleWithFixedDelay(new Runnable() {
            @Override
            public void run() {
                sendRaw(": ping\n\n", null);
            }
        }, 15, 15, TimeUnit.SECONDS);
        return port;
    }

    public void stop() {
        timer.shutdownNow();
        store.saveIfDirty();
        for (Client c : clients) HttpServer.closeQuietly(c.socket);
        clients.clear();
        http.stop();
    }

    /** Anderen Filmordner benutzen und die Anzeige neu einlesen lassen. */
    public void setMedia(MediaSource source) {
        media = source;
        store.loadConfig();
        broadcast(Json.object("type", "settings", "settings", store.settings()), null);
        sendCommand("rescan");
    }

    public void sendCommand(String cmd) {
        broadcast(Json.object("type", "command", "cmd", cmd, "args", new LinkedHashMap<String, Object>()), "display");
    }

    // ------------------------------------------------------------ Ereignisstrom

    private void broadcast(Map<String, Object> message, String role) {
        sendRaw("data: " + Json.stringify(message) + "\n\n", role);
    }

    private void sendRaw(String text, String role) {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        for (Client c : clients) {
            if (role != null && !role.equals(c.role)) continue;
            try {
                synchronized (c) {
                    c.out.write(bytes);
                    c.out.flush();
                }
            } catch (IOException e) {
                clients.remove(c);
                HttpServer.closeQuietly(c.socket);
            }
        }
    }

    // ------------------------------------------------------------ Anfragen

    @Override
    public void handle(HttpServer.Request req, HttpServer.Response res) throws IOException {
        if (req.path.startsWith("/api/")) {
            api(req, res);
            return;
        }
        if (!req.method.equals("GET") && !req.method.equals("HEAD")) {
            res.empty(405);
            return;
        }
        if (req.path.startsWith("/media/")) {
            serveMedia(req, res, req.path.substring("/media/".length()));
            return;
        }
        String rel = req.path.substring(1);
        if (rel.isEmpty()) rel = "index.html";
        else if (rel.equals("admin") || rel.equals("fernbedienung")) rel = "admin.html";
        serveAsset(res, rel);
    }

    private boolean authorized(HttpServer.Request req) {
        if (req.isLoopback()) return true;
        String pin = Json.string(Json.asObject(store.baseSettings().get("server")), "pin", "");
        if (pin.isEmpty()) return true;
        String given = req.header("x-tv-pin");
        if (given == null || given.isEmpty()) given = req.queryParam("pin");
        return pin.equals(given);
    }

    private void json(HttpServer.Response res, int status, Object body) throws IOException {
        res.send(status, JSON, Json.stringify(body).getBytes(StandardCharsets.UTF_8));
    }

    private Map<String, Object> configPayload() {
        MediaScanner.Result scan = MediaScanner.addOnlineChannels(MediaScanner.scan(media), store.settings());
        List<Object> warnings = store.warnings();
        warnings.addAll(scan.warnings);
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("version", platform.version());
        payload.put("platform", platform.name());
        payload.put("media", platform.mediaInfo());
        payload.put("settings", store.settings());
        payload.put("state", store.state());
        payload.put("channels", scan.channels);
        payload.put("warnings", warnings);
        payload.put("serverTime", System.currentTimeMillis());
        return payload;
    }

    private void api(HttpServer.Request req, HttpServer.Response res) throws IOException {
        if (!authorized(req)) {
            json(res, 401, Json.object("error", "PIN erforderlich"));
            return;
        }
        String route = req.path;

        if (req.method.equals("GET")) {
            switch (route) {
                case "/api/config":
                    json(res, 200, configPayload());
                    return;
                case "/api/channels":
                    json(res, 200, MediaScanner.addOnlineChannels(MediaScanner.scan(media), store.settings()).toJson());
                    return;
                case "/api/status": {
                    long at = lastStatusAt;
                    Map<String, Object> server = Json.object("version", platform.version(), "uptime", (System.currentTimeMillis() - startedAt) / 1000, "kiosk", true, "browserRestarts", 0);
                    json(res, 200, Json.object("status", lastStatus, "age", at == 0 ? null : (Object) (System.currentTimeMillis() - at), "server", server));
                    return;
                }
                case "/api/events": {
                    Map<String, String> headers = new LinkedHashMap<>();
                    headers.put("Content-Type", "text/event-stream; charset=utf-8");
                    headers.put("Cache-Control", "no-store");
                    res.head(200, headers);
                    String role = req.queryParam("role");
                    Client client = new Client(res.detach(), res.body(), role == null ? "admin" : role);
                    StringBuilder hello = new StringBuilder("retry: 2000\n\n");
                    Object status = lastStatus;
                    if (status != null && "admin".equals(client.role)) {
                        hello.append("data: ").append(Json.stringify(Json.object("type", "status", "status", status))).append("\n\n");
                    }
                    synchronized (client) {
                        client.out.write(hello.toString().getBytes(StandardCharsets.UTF_8));
                        client.out.flush();
                    }
                    clients.add(client);
                    return;
                }
                default:
                    json(res, 404, Json.object("error", "Unbekannter Pfad"));
                    return;
            }
        }

        if (!req.method.equals("POST")) {
            json(res, 405, Json.object("error", "Methode nicht erlaubt"));
            return;
        }
        Map<String, Object> body;
        try {
            body = req.body.length == 0 ? new LinkedHashMap<String, Object>() : Json.asObject(Json.parse(req.bodyText()));
        } catch (RuntimeException e) {
            body = null;
        }
        if (body == null) {
            json(res, 400, Json.object("error", "Ungültiges JSON"));
            return;
        }

        switch (route) {
            case "/api/command": {
                if (!(body.get("cmd") instanceof String)) {
                    json(res, 400, Json.object("error", "cmd fehlt"));
                    return;
                }
                Map<String, Object> args = Json.asObject(body.get("args"));
                broadcast(Json.object("type", "command", "cmd", body.get("cmd"), "args", args == null ? new LinkedHashMap<String, Object>() : args), "display");
                json(res, 200, Json.object("ok", true));
                return;
            }
            case "/api/settings": {
                Object reset = body.get("reset");
                if (reset instanceof String) store.resetSettings((String) reset);
                else if (Boolean.TRUE.equals(reset)) store.resetSettings(null);
                store.patchSettings(Json.asObject(body.get("patch")));
                Map<String, Object> settings = store.settings();
                broadcast(Json.object("type", "settings", "settings", settings), null);
                json(res, 200, Json.object("ok", true, "settings", settings));
                return;
            }
            case "/api/state":
                store.patchState(body);
                json(res, 200, Json.object("ok", true));
                return;
            case "/api/status":
                lastStatus = body;
                lastStatusAt = System.currentTimeMillis();
                broadcast(Json.object("type", "status", "status", body), "admin");
                json(res, 200, Json.object("ok", true));
                return;
            case "/api/log": {
                String level = "error".equals(body.get("level")) ? "error" : "warn".equals(body.get("level")) ? "warn" : "info";
                String message = String.valueOf(body.get("message"));
                platform.log(level, "[Anzeige] " + (message.length() > 2000 ? message.substring(0, 2000) : message));
                json(res, 200, Json.object("ok", true));
                return;
            }
            case "/api/system": {
                String action = Json.string(body, "action", "");
                if (action.equals("reloadConfig")) {
                    store.loadConfig();
                    broadcast(Json.object("type", "settings", "settings", store.settings()), null);
                    sendCommand("rescan");
                    json(res, 200, Json.object("ok", true, "warnings", store.warnings()));
                    return;
                }
                if (platform.system(action)) {
                    json(res, 200, Json.object("ok", true));
                } else {
                    json(res, 400, Json.object("error", "Diese Aktion gibt es hier nicht."));
                }
                return;
            }
            default:
                json(res, 404, Json.object("error", "Unbekannter Pfad"));
        }
    }

    // ------------------------------------------------------------ Dateien

    private static String mime(String name) {
        int dot = name.lastIndexOf('.');
        String type = dot < 0 ? null : MIME.get(name.substring(dot).toLowerCase(Locale.ROOT));
        return type == null ? "application/octet-stream" : type;
    }

    private void notFound(HttpServer.Response res) throws IOException {
        res.send(404, "text/plain; charset=utf-8", "Nicht gefunden".getBytes(StandardCharsets.UTF_8));
    }

    private void serveAsset(HttpServer.Response res, String rel) throws IOException {
        String decoded = HttpServer.percentDecode(rel);
        if (decoded == null || decoded.indexOf('\0') >= 0 || decoded.contains("..") || decoded.contains("\\") || decoded.startsWith("/")) {
            res.empty(400);
            return;
        }
        byte[] data = assets.read(decoded);
        if (data == null) {
            notFound(res);
            return;
        }
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Content-Type", mime(decoded));
        headers.put("Content-Length", String.valueOf(data.length));
        headers.put("Cache-Control", "no-cache");
        res.head(200, headers);
        if (!res.isHeadRequest()) res.body().write(data);
    }

    private static String httpDate(long millis) {
        SimpleDateFormat format = new SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss 'GMT'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("GMT"));
        return format.format(new Date(millis));
    }

    /** Liefert einen Film aus; mit Teilabrufen (Range), damit im Film gesprungen werden kann. */
    private void serveMedia(HttpServer.Request req, HttpServer.Response res, String rel) throws IOException {
        String decoded = HttpServer.percentDecode(rel);
        if (decoded == null || decoded.indexOf('\0') >= 0) {
            res.empty(400);
            return;
        }
        for (String part : decoded.split("/", -1)) {
            if (part.equals("..") || part.contains("\\")) {
                res.empty(403);
                return;
            }
        }
        MediaSource source = media;
        MediaSource.Media file = source == null ? null : source.open(decoded);
        if (file == null) {
            notFound(res);
            return;
        }
        long size = file.length();
        String etag = "\"" + Long.toHexString(size) + "-" + Long.toHexString(file.lastModified()) + "\"";
        String modified = httpDate(file.lastModified());
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Content-Type", mime(decoded));
        headers.put("Accept-Ranges", "bytes");
        headers.put("Cache-Control", "no-cache");
        headers.put("ETag", etag);
        headers.put("Last-Modified", modified);

        String range = req.header("range");
        // Wurde die Datei inzwischen ersetzt, darf kein Teilstück der alten Fassung ergänzt werden.
        String ifRange = req.header("if-range");
        if (range != null && ifRange != null && !ifRange.equals(etag) && !ifRange.equals(modified)) range = null;
        if (range == null && etag.equals(req.header("if-none-match"))) {
            res.head(304, headers);
            return;
        }

        long start = 0;
        long end = size - 1;
        int status = 200;
        if (range != null) {
            java.util.regex.Matcher m = java.util.regex.Pattern.compile("^bytes=(\\d*)-(\\d*)$").matcher(range.trim());
            boolean valid = m.matches() && !(m.group(1).isEmpty() && m.group(2).isEmpty());
            try {
                if (valid) {
                    if (m.group(1).isEmpty()) {
                        start = Math.max(0, size - Long.parseLong(m.group(2)));
                    } else {
                        start = Long.parseLong(m.group(1));
                        if (!m.group(2).isEmpty()) end = Math.min(Long.parseLong(m.group(2)), size - 1);
                    }
                }
            } catch (NumberFormatException e) {
                valid = false;
            }
            if (!valid || start > end || start >= size) {
                Map<String, String> h = new LinkedHashMap<>();
                h.put("Content-Range", "bytes */" + size);
                h.put("Content-Length", "0");
                res.head(416, h);
                return;
            }
            status = 206;
            headers.put("Content-Range", "bytes " + start + "-" + end + "/" + size);
        }
        long length = end - start + 1;
        headers.put("Content-Length", String.valueOf(Math.max(0, length)));
        res.head(status, headers);
        if (res.isHeadRequest() || size == 0) return;

        try (InputStream in = file.stream(start)) {
            OutputStream out = res.body();
            byte[] buffer = new byte[64 * 1024];
            long left = length;
            while (left > 0) {
                int n = in.read(buffer, 0, (int) Math.min(buffer.length, left));
                if (n < 0) break;
                out.write(buffer, 0, n);
                left -= n;
            }
        }
    }

    // ------------------------------------------------------------ Hilfen für die Plattformen

    /** Dateien der Anzeige aus einem Ordner (Testlauf am PC). */
    public static AssetSource directoryAssets(final File dir) {
        return new AssetSource() {
            @Override
            public byte[] read(String path) throws IOException {
                MediaSource.Media file = new FileMediaSource(dir).open(path);
                if (file == null) return null;
                try (InputStream in = file.stream(0)) {
                    java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
                    byte[] buffer = new byte[8192];
                    int n;
                    while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
                    return out.toByteArray();
                }
            }
        };
    }

    public static List<Object> list(Object... items) {
        List<Object> list = new ArrayList<>();
        for (Object item : items) list.add(item);
        return list;
    }
}
