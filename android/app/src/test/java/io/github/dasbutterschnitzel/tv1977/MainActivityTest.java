package io.github.dasbutterschnitzel.tv1977;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

import io.github.dasbutterschnitzel.tv1977.server.Json;

/**
 * Fährt die App in einer simulierten Android-Umgebung hoch und prüft, dass der eingebaute
 * Server läuft und die eingepackte Anzeige ausliefert. Ersetzt keinen Test auf einem echten
 * Gerät (WebView, Grafik und Videowiedergabe sind hier nur Attrappen).
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class MainActivityTest {

    private static String body(HttpURLConnection connection) throws IOException {
        try (InputStream in = connection.getResponseCode() < 400 ? connection.getInputStream() : connection.getErrorStream()) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int n;
            while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private static HttpURLConnection open(int port, String path) throws IOException {
        return (HttpURLConnection) new URL("http://127.0.0.1:" + port + path).openConnection(java.net.Proxy.NO_PROXY);
    }

    private static Map<String, Object> config(int port) throws IOException {
        return Json.asObject(Json.parse(body(open(port, "/api/config"))));
    }

    @Test
    public void appStartsServerAndServesTheDisplay() throws Exception {
        ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class).setup();
        MainActivity activity = controller.get();
        int port = activity.serverPort();
        assertTrue("Server läuft", port > 0);

        // Anzeige und Skripte kommen aus der App
        HttpURLConnection index = open(port, "/");
        assertEquals(200, index.getResponseCode());
        assertTrue(body(index).contains("js/main.js"));
        HttpURLConnection script = open(port, "/js/shaders.js");
        assertEquals(200, script.getResponseCode());
        assertTrue(script.getContentType().contains("javascript"));
        assertEquals(200, open(port, "/admin").getResponseCode());
        assertEquals(404, open(port, "/js/gibtesnicht.js").getResponseCode());

        // Einstellungen: Standardwerte aus der mitgelieferten Datei
        Map<String, Object> config = config(port);
        assertEquals("android", config.get("platform"));
        assertEquals(BuildConfig.VERSION_NAME, config.get("version"));
        Map<String, Object> effects = Json.asObject(Json.asObject(config.get("settings")).get("effects"));
        assertEquals(0.5, ((Number) effects.get("curvature")).doubleValue(), 1e-9);
        Map<String, Object> media = Json.asObject(config.get("media"));
        assertEquals(Boolean.FALSE, media.get("chosen"));
        String appFolder = (String) media.get("appFolder");
        assertNotNull(appFolder);

        // ohne Filme: ein Testbild
        List<?> channels = (List<?>) config.get("channels");
        assertEquals(1, channels.size());
        assertEquals("testcard", Json.asObject(channels.get(0)).get("type"));

        // Filme im App-Ordner werden gefunden und in Teilstücken ausgeliefert
        File sender = new File(appFolder, "01-hessentag");
        assertTrue(sender.mkdirs());
        try (OutputStream out = new FileOutputStream(new File(sender, "film 1.mp4"))) {
            out.write("0123456789".getBytes(StandardCharsets.UTF_8));
        }
        channels = (List<?>) config(port).get("channels");
        Map<String, Object> channel = Json.asObject(channels.get(0));
        assertEquals("Hessentag", channel.get("name"));
        assertEquals("video", channel.get("type"));
        String url = (String) Json.asObject(((List<?>) channel.get("files")).get(0)).get("url");
        assertEquals("/media/01-hessentag/film%201.mp4", url);
        HttpURLConnection part = open(port, url);
        part.setRequestProperty("Range", "bytes=2-5");
        assertEquals(206, part.getResponseCode());
        assertEquals("2345", body(part));

        // unbekannte Systemaktion wird abgelehnt, bekannte angenommen
        HttpURLConnection bad = open(port, "/api/system");
        bad.setRequestMethod("POST");
        bad.setDoOutput(true);
        bad.getOutputStream().write("{\"action\":\"gibtesnicht\"}".getBytes(StandardCharsets.UTF_8));
        assertEquals(400, bad.getResponseCode());
        HttpURLConnection good = open(port, "/api/system");
        good.setRequestMethod("POST");
        good.setDoOutput(true);
        good.getOutputStream().write("{\"action\":\"useAppFolder\"}".getBytes(StandardCharsets.UTF_8));
        assertEquals(200, good.getResponseCode());

        // Lebenszyklus: in den Hintergrund, zurück, beenden – ohne Absturz; danach ist der Server aus
        controller.pause().stop().restart().start().resume();
        org.robolectric.shadows.ShadowLooper.idleMainLooper();
        assertEquals(200, open(port, "/api/status").getResponseCode());
        controller.pause().stop().destroy();
        try {
            open(port, "/api/status").getResponseCode();
            throw new AssertionError("Server läuft nach dem Beenden noch");
        } catch (IOException expected) {
            // Verbindung abgelehnt
        }
    }
}
