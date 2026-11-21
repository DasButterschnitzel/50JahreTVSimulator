package io.github.dasbutterschnitzel.tv1977.server;

import java.io.IOException;

/** Liefert die Dateien der Anzeige (HTML, Skripte). */
public interface AssetSource {
    /** Inhalt der Datei oder null, wenn es sie nicht gibt. Pfad wie "js/main.js". */
    byte[] read(String path) throws IOException;
}
