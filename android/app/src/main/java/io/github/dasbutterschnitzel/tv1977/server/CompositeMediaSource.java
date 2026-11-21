package io.github.dasbutterschnitzel.tv1977.server;

import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Ergänzt einen Filmordner um zusätzliche Sender, die keine echten Ordner sind:
 * Alben aus der Mediathek des Geräts oder eine Auswahl einzelner Videos.
 * Für den Senderscan sieht jedes Album wie ein Unterordner aus.
 */
public final class CompositeMediaSource implements MediaSource {

    /** Ein Album: eine flache Liste von Videos unter einem Namen. */
    public interface Album {
        String name();

        List<Entry> list() throws IOException;

        Media open(String fileName) throws IOException;
    }

    private final MediaSource base;
    private final Map<String, Album> albums = new LinkedHashMap<>();

    public CompositeMediaSource(MediaSource base, List<Album> list) {
        this.base = base;
        for (Album album : list) {
            // Namen müssen als Ordnername taugen und eindeutig sein
            String name = album.name().replace('/', '-').replace('\\', '-').trim();
            if (name.isEmpty() || name.startsWith(".") || name.startsWith("_")) name = "Album " + name;
            String unique = name;
            for (int n = 2; albums.containsKey(unique); n++) unique = name + " (" + n + ")";
            albums.put(unique, album);
        }
    }

    /** Dateiname, den der Senderscan als Video erkennt (hängt notfalls ".mp4" an). */
    public static String playableName(String name) {
        String clean = name == null ? "" : name.replace('/', '-').replace('\\', '-').trim();
        if (clean.isEmpty() || clean.startsWith(".")) clean = "Video" + clean;
        int dot = clean.lastIndexOf('.');
        String extension = dot < 0 ? "" : clean.substring(dot).toLowerCase(Locale.ROOT);
        return MediaScanner.VIDEO_EXTENSIONS.contains(extension) ? clean : clean + ".mp4";
    }

    /** Macht einen Namen innerhalb der schon vergebenen eindeutig: "Film.mp4" -> "Film (2).mp4". */
    public static String uniqueName(String name, java.util.Set<String> taken) {
        String candidate = name;
        int dot = name.lastIndexOf('.');
        for (int n = 2; !taken.add(candidate); n++) {
            candidate = dot < 0 ? name + " (" + n + ")" : name.substring(0, dot) + " (" + n + ")" + name.substring(dot);
        }
        return candidate;
    }

    @Override
    public List<Entry> list(String folder) throws IOException {
        if (!folder.isEmpty()) {
            Album album = albums.get(folder);
            if (album != null) return album.list();
            return base == null ? new ArrayList<Entry>() : base.list(folder);
        }
        List<Entry> entries = new ArrayList<>();
        if (base != null) {
            try {
                for (Entry e : base.list("")) {
                    if (!(e.directory && albums.containsKey(e.name))) entries.add(e);
                }
            } catch (IOException e) {
                // Ordner gerade nicht erreichbar (z. B. USB-Stick abgezogen): die Alben bleiben trotzdem
            }
        }
        for (String name : albums.keySet()) entries.add(new Entry(name, true, 0, 0));
        return entries;
    }

    @Override
    public String readText(String path) throws IOException {
        int slash = path.indexOf('/');
        if (slash > 0 && albums.containsKey(path.substring(0, slash))) return null;
        return base == null ? null : base.readText(path);
    }

    @Override
    public Media open(String path) throws IOException {
        int slash = path.indexOf('/');
        if (slash > 0) {
            Album album = albums.get(path.substring(0, slash));
            if (album != null) return album.open(path.substring(slash + 1));
        }
        return base == null ? null : base.open(path);
    }

    @Override
    public String describe() {
        StringBuilder sb = new StringBuilder();
        for (String name : albums.keySet()) sb.append(sb.length() == 0 ? "" : ", ").append(name);
        return base == null ? sb.toString() : sb + " + " + base.describe();
    }
}
