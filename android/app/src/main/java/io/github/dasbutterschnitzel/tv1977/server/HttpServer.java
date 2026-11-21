package io.github.dasbutterschnitzel.tv1977.server;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Sehr kleiner HTTP-Server: eine Anfrage pro Verbindung, keine Abhängigkeiten.
 * Reicht für die Anzeige im selben Gerät und eine Handvoll Fernbedienungen.
 */
public final class HttpServer {
    private static final int MAX_HEADER_BYTES = 32 * 1024;
    private static final int MAX_BODY_BYTES = 1024 * 1024;

    public interface Handler {
        void handle(Request request, Response response) throws IOException;
    }

    public static final class Request {
        public String method;
        public String path;
        public String query = "";
        public final Map<String, String> headers = new LinkedHashMap<>();
        public byte[] body = new byte[0];
        public InetAddress remote;

        public boolean isLoopback() {
            return remote != null && remote.isLoopbackAddress();
        }

        public String header(String name) {
            return headers.get(name.toLowerCase(Locale.ROOT));
        }

        public String queryParam(String name) {
            for (String part : query.split("&")) {
                int eq = part.indexOf('=');
                String key = eq < 0 ? part : part.substring(0, eq);
                if (key.equals(name)) return eq < 0 ? "" : percentDecode(part.substring(eq + 1).replace('+', ' '));
            }
            return null;
        }

        public String bodyText() {
            return new String(body, StandardCharsets.UTF_8);
        }
    }

    public static final class Response {
        private final Socket socket;
        private final OutputStream out;
        private final boolean head;
        private boolean headersSent;
        private boolean detached;

        Response(Socket socket, OutputStream out, boolean head) {
            this.socket = socket;
            this.out = out;
            this.head = head;
        }

        public boolean headersSent() {
            return headersSent;
        }

        /** Kopfzeilen senden; danach kann über body() gestreamt werden. */
        public void head(int status, Map<String, String> headers) throws IOException {
            StringBuilder sb = new StringBuilder();
            sb.append("HTTP/1.1 ").append(status).append(' ').append(reason(status)).append("\r\n");
            if (headers != null) {
                for (Map.Entry<String, String> e : headers.entrySet()) {
                    sb.append(e.getKey()).append(": ").append(e.getValue().replace('\r', ' ').replace('\n', ' ')).append("\r\n");
                }
            }
            sb.append("Connection: close\r\n\r\n");
            out.write(sb.toString().getBytes(StandardCharsets.ISO_8859_1));
            out.flush();
            headersSent = true;
        }

        public void send(int status, String contentType, byte[] body) throws IOException {
            Map<String, String> headers = new LinkedHashMap<>();
            headers.put("Content-Type", contentType);
            headers.put("Content-Length", String.valueOf(body.length));
            headers.put("Cache-Control", "no-store");
            head(status, headers);
            if (!head) out.write(body);
            out.flush();
        }

        public void empty(int status) throws IOException {
            Map<String, String> headers = new LinkedHashMap<>();
            headers.put("Content-Length", "0");
            head(status, headers);
        }

        public boolean isHeadRequest() {
            return head;
        }

        public OutputStream body() {
            return out;
        }

        /** Verbindung offen halten (Ereignisstrom); der Aufrufer schließt sie später selbst. */
        public Socket detach() {
            detached = true;
            return socket;
        }
    }

    private final Handler handler;
    private final ThreadPoolExecutor workers;
    private ServerSocket serverSocket;
    private volatile boolean running;

    public HttpServer(Handler handler) {
        this.handler = handler;
        final AtomicInteger counter = new AtomicInteger();
        ThreadFactory factory = new ThreadFactory() {
            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "tv-http-" + counter.incrementAndGet());
                t.setDaemon(true);
                return t;
            }
        };
        workers = new ThreadPoolExecutor(4, 64, 30, TimeUnit.SECONDS, new SynchronousQueue<Runnable>(), factory);
    }

    /** Startet den Server; port 0 = freien Port wählen. Liefert den tatsächlichen Port. */
    public synchronized int start(String host, int port) throws IOException {
        serverSocket = new ServerSocket(port, 64, InetAddress.getByName(host));
        running = true;
        Thread acceptor = new Thread(new Runnable() {
            @Override
            public void run() {
                acceptLoop();
            }
        }, "tv-http-accept");
        acceptor.setDaemon(true);
        acceptor.start();
        return serverSocket.getLocalPort();
    }

    public synchronized void stop() {
        running = false;
        try {
            if (serverSocket != null) serverSocket.close();
        } catch (IOException ignored) {
            // wird ohnehin beendet
        }
        workers.shutdownNow();
    }

    private void acceptLoop() {
        while (running) {
            final Socket socket;
            try {
                socket = serverSocket.accept();
            } catch (IOException e) {
                if (!running) return;
                continue;
            }
            try {
                workers.execute(new Runnable() {
                    @Override
                    public void run() {
                        serve(socket);
                    }
                });
            } catch (RuntimeException overloaded) {
                closeQuietly(socket);
            }
        }
    }

    private void serve(Socket socket) {
        boolean keepOpen = false;
        try {
            socket.setSoTimeout(30000);
            socket.setTcpNoDelay(true);
            InputStream in = new BufferedInputStream(socket.getInputStream(), 8192);
            OutputStream out = socket.getOutputStream();
            Request request = readRequest(in);
            if (request == null) return;
            request.remote = socket.getInetAddress();
            Response response = new Response(socket, out, "HEAD".equals(request.method));
            try {
                handler.handle(request, response);
            } catch (HttpError e) {
                if (!response.headersSent) response.send(e.status, "application/json; charset=utf-8", Json.stringify(Json.object("error", e.getMessage())).getBytes(StandardCharsets.UTF_8));
            } catch (RuntimeException e) {
                if (!response.headersSent) response.send(500, "application/json; charset=utf-8", Json.stringify(Json.object("error", String.valueOf(e.getMessage()))).getBytes(StandardCharsets.UTF_8));
            }
            keepOpen = response.detached;
            if (keepOpen) socket.setSoTimeout(0);
            out.flush();
        } catch (IOException ignored) {
            // Gegenstelle hat aufgelegt (z. B. beim Springen im Film) – normal
        } finally {
            if (!keepOpen) closeQuietly(socket);
        }
    }

    public static final class HttpError extends RuntimeException {
        private static final long serialVersionUID = 1L;
        public final int status;

        public HttpError(int status, String message) {
            super(message);
            this.status = status;
        }
    }

    private Request readRequest(InputStream in) throws IOException {
        ByteArrayOutputStream headerBytes = new ByteArrayOutputStream();
        int state = 0;
        while (state < 4) {
            int b = in.read();
            if (b < 0) return null;
            headerBytes.write(b);
            if (headerBytes.size() > MAX_HEADER_BYTES) return null;
            if (b == '\r' && (state == 0 || state == 2)) state++;
            else if (b == '\n' && (state == 1 || state == 3)) state++;
            else state = 0;
        }
        String[] lines = new String(headerBytes.toByteArray(), StandardCharsets.ISO_8859_1).split("\r\n");
        String[] first = lines[0].split(" ");
        if (first.length < 2) return null;
        Request request = new Request();
        request.method = first[0].toUpperCase(Locale.ROOT);
        String target = first[1];
        int q = target.indexOf('?');
        request.path = q < 0 ? target : target.substring(0, q);
        request.query = q < 0 ? "" : target.substring(q + 1);
        for (int i = 1; i < lines.length; i++) {
            int colon = lines[i].indexOf(':');
            if (colon > 0) request.headers.put(lines[i].substring(0, colon).trim().toLowerCase(Locale.ROOT), lines[i].substring(colon + 1).trim());
        }
        String lengthHeader = request.headers.get("content-length");
        if (lengthHeader != null) {
            int length;
            try {
                length = Integer.parseInt(lengthHeader);
            } catch (NumberFormatException e) {
                return null;
            }
            if (length < 0 || length > MAX_BODY_BYTES) return null;
            byte[] body = new byte[length];
            int read = 0;
            while (read < length) {
                int n = in.read(body, read, length - read);
                if (n < 0) return null;
                read += n;
            }
            request.body = body;
        }
        return request;
    }

    /** Wandelt %-Kodierung zurück; liefert null bei ungültiger Kodierung. */
    public static String percentDecode(String s) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '%') {
                if (i + 2 >= s.length()) return null;
                int hi = Character.digit(s.charAt(i + 1), 16);
                int lo = Character.digit(s.charAt(i + 2), 16);
                if (hi < 0 || lo < 0) return null;
                out.write(hi * 16 + lo);
                i += 2;
            } else {
                byte[] bytes = String.valueOf(c).getBytes(StandardCharsets.UTF_8);
                out.write(bytes, 0, bytes.length);
            }
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    static String reason(int status) {
        switch (status) {
            case 200:
                return "OK";
            case 206:
                return "Partial Content";
            case 304:
                return "Not Modified";
            case 400:
                return "Bad Request";
            case 401:
                return "Unauthorized";
            case 403:
                return "Forbidden";
            case 404:
                return "Not Found";
            case 405:
                return "Method Not Allowed";
            case 409:
                return "Conflict";
            case 413:
                return "Payload Too Large";
            case 416:
                return "Range Not Satisfiable";
            default:
                return "Error";
        }
    }

    static void closeQuietly(Socket socket) {
        try {
            socket.close();
        } catch (IOException ignored) {
            // egal
        }
    }
}
