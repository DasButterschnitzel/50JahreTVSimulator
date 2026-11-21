package io.github.dasbutterschnitzel.tv1977.server;

import java.io.IOException;
import java.io.InputStream;
import java.util.List;

/** Zugriff auf den Filmordner – unabhängig davon, ob er im Dateisystem oder hinter Androids Ordnerauswahl liegt. */
public interface MediaSource {

    final class Entry {
        public final String name;
        public final boolean directory;
        public final long size;
        public final long lastModified;

        public Entry(String name, boolean directory, long size, long lastModified) {
            this.name = name;
            this.directory = directory;
            this.size = size;
            this.lastModified = lastModified;
        }
    }

    interface Media {
        long length();

        long lastModified();

        /** Liefert die Datei ab der Stelle start (für Teilabrufe beim Springen im Film). */
        InputStream stream(long start) throws IOException;
    }

    /** Inhalt des Hauptordners ("") oder eines Senderordners. */
    List<Entry> list(String folder) throws IOException;

    /** Kleine Textdatei lesen, null wenn sie fehlt. Pfad wie "ordner/channel.json". */
    String readText(String path) throws IOException;

    /** Datei zum Ausliefern öffnen, null wenn sie fehlt. Pfad wie "ordner/film.mp4". */
    Media open(String path) throws IOException;

    /** Für Menschen lesbare Beschreibung des Ortes. */
    String describe();
}
