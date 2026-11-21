package io.github.dasbutterschnitzel.tv1977.server;

import java.io.IOException;
import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Liest den Filmordner ein – gleiche Regeln wie server/media.js:
 * Jeder Unterordner ist ein Sender, sortiert nach Ordnernamen; die Filme darin nach Dateinamen.
 */
public final class MediaScanner {
    public static final Set<String> VIDEO_EXTENSIONS = new HashSet<>(Arrays.asList(".mp4", ".m4v", ".webm", ".mov", ".mkv", ".ogv"));
    private static final Set<String> CHANNEL_TYPES = new HashSet<>(Arrays.asList("video", "testcard", "noise"));

    public static final class Result {
        public final List<Object> channels = new ArrayList<>();
        public final List<Object> warnings = new ArrayList<>();

        public Map<String, Object> toJson() {
            return Json.object("channels", channels, "warnings", warnings);
        }
    }

    private MediaScanner() {
    }

    /** Vergleich wie ein Mensch sortieren würde: "film2" vor "film10", Groß-/Kleinschreibung egal. */
    public static final Comparator<String> NATURAL = new Comparator<String>() {
        @Override
        public int compare(String a, String b) {
            int i = 0;
            int j = 0;
            while (i < a.length() && j < b.length()) {
                char ca = a.charAt(i);
                char cb = b.charAt(j);
                if (Character.isDigit(ca) && Character.isDigit(cb)) {
                    int si = i;
                    int sj = j;
                    while (i < a.length() && Character.isDigit(a.charAt(i))) i++;
                    while (j < b.length() && Character.isDigit(b.charAt(j))) j++;
                    String na = a.substring(si, i).replaceFirst("^0+(?=.)", "");
                    String nb = b.substring(sj, j).replaceFirst("^0+(?=.)", "");
                    if (na.length() != nb.length()) return na.length() - nb.length();
                    int cmp = na.compareTo(nb);
                    if (cmp != 0) return cmp;
                } else {
                    char la = Character.toLowerCase(ca);
                    char lb = Character.toLowerCase(cb);
                    if (la != lb) return la - lb;
                    i++;
                    j++;
                }
            }
            return (a.length() - i) - (b.length() - j);
        }
    };

    /** "01-hessentag_dreieich" -> "Hessentag Dreieich" */
    public static String prettifyName(String folder) {
        String cleaned = folder.replaceFirst("^[\\d\\s._-]+", "").replaceAll("[_-]+", " ").trim();
        String base = cleaned.isEmpty() ? folder : cleaned;
        StringBuilder sb = new StringBuilder();
        boolean startOfWord = true;
        for (int i = 0; i < base.length(); i++) {
            char c = base.charAt(i);
            sb.append(startOfWord && Character.isLetter(c) ? Character.toUpperCase(c) : c);
            startOfWord = Character.isWhitespace(c);
        }
        return sb.toString();
    }

    public static String encode(String name) {
        try {
            return URLEncoder.encode(name, "UTF-8").replace("+", "%20");
        } catch (UnsupportedEncodingException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String extension(String name) {
        int dot = name.lastIndexOf('.');
        return dot < 0 ? "" : name.substring(dot).toLowerCase(Locale.ROOT);
    }

    private static List<Object> videos(List<MediaSource.Entry> entries, String urlPrefix) {
        List<MediaSource.Entry> files = new ArrayList<>();
        for (MediaSource.Entry e : entries) {
            if (e.directory || e.name.startsWith(".") || e.size <= 0) continue;
            if (VIDEO_EXTENSIONS.contains(extension(e.name))) files.add(e);
        }
        Collections.sort(files, new Comparator<MediaSource.Entry>() {
            @Override
            public int compare(MediaSource.Entry a, MediaSource.Entry b) {
                return NATURAL.compare(a.name, b.name);
            }
        });
        List<Object> out = new ArrayList<>();
        for (MediaSource.Entry e : files) {
            out.add(Json.object("name", e.name, "url", urlPrefix + encode(e.name), "size", e.size, "mtime", e.lastModified));
        }
        return out;
    }

    private static Map<String, Object> channel(String id, String folder, String name, String type, Map<String, Object> options, List<Object> files) {
        return Json.object("id", id, "folder", folder, "name", name, "type", type, "options", options, "files", files);
    }

    public static Result scan(MediaSource source) {
        Result result = new Result();
        List<MediaSource.Entry> root;
        try {
            root = source == null ? null : source.list("");
        } catch (IOException | RuntimeException e) {
            root = null;
        }
        if (root == null) {
            result.warnings.add("Filmordner nicht lesbar: " + (source == null ? "keiner gewählt" : source.describe()));
            root = new ArrayList<>();
        }

        List<Object> rootFiles = videos(root, "/media/");
        if (!rootFiles.isEmpty()) {
            result.channels.add(channel("_root", "", "Programm", "video", new LinkedHashMap<String, Object>(), rootFiles));
        }

        List<String> folders = new ArrayList<>();
        for (MediaSource.Entry e : root) {
            if (e.directory && !e.name.startsWith(".") && !e.name.startsWith("_")) folders.add(e.name);
        }
        Collections.sort(folders, NATURAL);

        for (String folder : folders) {
            List<MediaSource.Entry> entries;
            try {
                entries = source.list(folder);
            } catch (IOException | RuntimeException e) {
                entries = new ArrayList<>();
            }
            Map<String, Object> options = new LinkedHashMap<>();
            boolean hasOptions = false;
            for (MediaSource.Entry e : entries) {
                if (!e.directory && e.name.equals("channel.json")) hasOptions = true;
            }
            if (hasOptions) {
                try {
                    Map<String, Object> parsed = Json.asObject(Json.parse(source.readText(folder + "/channel.json")));
                    if (parsed != null) options = parsed;
                } catch (IOException | RuntimeException e) {
                    result.warnings.add(folder + "/channel.json ist fehlerhaft und wird ignoriert: " + e.getMessage());
                }
            }
            List<Object> files = videos(entries, "/media/" + encode(folder) + "/");
            String wanted = Json.string(options, "type", "");
            String type = CHANNEL_TYPES.contains(wanted) ? wanted : files.isEmpty() ? "testcard" : "video";
            if (type.equals("video") && files.isEmpty()) type = "testcard";
            String name = Json.string(options, "name", "").trim();
            if (name.isEmpty()) name = prettifyName(folder);
            result.channels.add(channel(folder, folder, name, type, options, type.equals("video") ? files : new ArrayList<Object>()));
        }

        if (result.channels.isEmpty()) {
            result.channels.add(channel("_testbild", "", "Testbild", "testcard", new LinkedHashMap<String, Object>(), new ArrayList<Object>()));
        }
        return result;
    }
}
