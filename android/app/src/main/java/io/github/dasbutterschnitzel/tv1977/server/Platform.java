package io.github.dasbutterschnitzel.tv1977.server;

import java.util.Map;

/** Was der Server vom umgebenden Programm braucht (Android-App oder Testlauf am PC). */
public interface Platform {
    /** "android" oder "desktop"; die Fernbedienung blendet danach Funktionen ein. */
    String name();

    String version();

    /** Angaben zum Filmordner für die Fernbedienung, darf null sein. */
    Map<String, Object> mediaInfo();

    /** Systemaktion ausführen ("pickFolder", "restartBrowser", "quit"); false = nicht unterstützt. */
    boolean system(String action);

    void log(String level, String message);
}
