package io.github.dasbutterschnitzel.tv1977.server;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Einstellungen und Laufzeitzustand – gleiche Regeln wie server/config.js:
 * Standardwerte  <-  config.json  <-  Änderungen aus der Fernbedienung (state.json).
 */
public final class Store {
    /** Liefert den Text von config.json oder null, wenn es keine gibt. */
    public interface ConfigReader {
        String read() throws IOException;
    }

    private final Map<String, Object> defaults;
    private final File stateFile;
    private final ConfigReader configReader;
    private final Platform platform;
    private Map<String, Object> fileConfig = new LinkedHashMap<>();
    private Map<String, Object> stateSettings = new LinkedHashMap<>();
    private Object broadcast = new LinkedHashMap<String, Object>();
    private String channel;
    private boolean power = true;
    private String configWarning;
    private boolean dirty;

    public Store(String defaultsText, File dataDir, ConfigReader configReader, Platform platform) {
        this.defaults = Json.asObject(Json.parse(defaultsText));
        this.stateFile = new File(dataDir, "state.json");
        this.configReader = configReader;
        this.platform = platform;
        dataDir.mkdirs();
        loadConfig();
        loadState();
    }

    public synchronized void loadConfig() {
        configWarning = null;
        fileConfig = new LinkedHashMap<>();
        try {
            String text = configReader == null ? null : configReader.read();
            if (text == null) return;
            Map<String, Object> parsed = Json.asObject(Json.parse(text));
            if (parsed == null) throw new IllegalArgumentException("Die Datei muss ein JSON-Objekt enthalten.");
            fileConfig = parsed;
        } catch (IOException | RuntimeException e) {
            // Ein Tippfehler in der Konfiguration darf die Ausstellung nicht lahmlegen.
            configWarning = "config.json ist fehlerhaft und wird ignoriert: " + e.getMessage();
            platform.log("warn", configWarning);
        }
    }

    private void loadState() {
        if (!stateFile.isFile()) return;
        try (InputStream in = new FileInputStream(stateFile)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int n;
            while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
            Map<String, Object> parsed = Json.asObject(Json.parse(new String(out.toByteArray(), StandardCharsets.UTF_8)));
            if (parsed == null) return;
            Map<String, Object> settings = Json.asObject(parsed.get("settings"));
            if (settings != null) stateSettings = settings;
            if (parsed.get("broadcast") instanceof Map) broadcast = parsed.get("broadcast");
            if (parsed.get("channel") instanceof String) channel = (String) parsed.get("channel");
            power = !Boolean.FALSE.equals(parsed.get("power"));
        } catch (IOException | RuntimeException e) {
            platform.log("warn", "state.json nicht lesbar, starte mit leerem Zustand: " + e.getMessage());
        }
    }

    public synchronized List<Object> warnings() {
        List<Object> list = new ArrayList<>();
        if (configWarning != null) list.add(configWarning);
        return list;
    }

    /** Einstellungen ohne die Änderungen aus der Fernbedienung. */
    @SuppressWarnings("unchecked")
    public synchronized Map<String, Object> baseSettings() {
        return Json.deepMerge(defaults, fileConfig);
    }

    @SuppressWarnings("unchecked")
    public synchronized Map<String, Object> settings() {
        return Json.deepMerge(defaults, fileConfig, stateSettings);
    }

    @SuppressWarnings("unchecked")
    public synchronized void patchSettings(Map<String, Object> patch) {
        if (patch == null) return;
        Map<String, Object> clean = new LinkedHashMap<>(patch);
        clean.remove("server"); // Serverdaten lassen sich nur in config.json ändern
        clean.remove("kiosk");
        clean.remove("mediaDir");
        stateSettings = Json.deepMerge(stateSettings, clean);
        dirty = true;
    }

    public synchronized void resetSettings(String section) {
        if (section != null) stateSettings.remove(section);
        else stateSettings = new LinkedHashMap<>();
        dirty = true;
    }

    public synchronized void patchState(Map<String, Object> patch) {
        if (patch == null) return;
        if (patch.get("broadcast") instanceof Map) broadcast = patch.get("broadcast");
        if (patch.get("channel") instanceof String) channel = (String) patch.get("channel");
        if (patch.get("power") instanceof Boolean) power = (Boolean) patch.get("power");
        dirty = true;
    }

    public synchronized Map<String, Object> state() {
        return Json.object("broadcast", Json.deepCopy(broadcast), "channel", channel, "power", power);
    }

    /** Schreibt den Zustand, falls er sich geändert hat (wird regelmäßig aufgerufen). */
    public void saveIfDirty() {
        String text;
        synchronized (this) {
            if (!dirty) return;
            dirty = false;
            text = Json.stringify(Json.object("settings", stateSettings, "broadcast", broadcast, "channel", channel, "power", power));
        }
        File tmp = new File(stateFile.getPath() + ".tmp");
        try {
            try (OutputStream out = new FileOutputStream(tmp)) {
                out.write(text.getBytes(StandardCharsets.UTF_8));
            }
            if (!tmp.renameTo(stateFile)) {
                stateFile.delete();
                if (!tmp.renameTo(stateFile)) throw new IOException("Umbenennen fehlgeschlagen");
            }
        } catch (IOException e) {
            platform.log("warn", "Zustand konnte nicht gespeichert werden: " + e.getMessage());
        }
    }
}
