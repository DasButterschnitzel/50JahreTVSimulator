package io.github.dasbutterschnitzel.tv1977.server;

import java.io.File;
import java.io.IOException;
import java.util.Map;

/**
 * Startet den Server der Android-App auf einem normalen Rechner.
 * Damit lässt sich prüfen, dass er sich genauso verhält wie server.js
 * (der Browser-Test test/e2e.mjs läuft dann gegen diesen Server).
 *
 *   java ... DesktopMain --public <ordner> --defaults <datei> --media <ordner> --data <ordner> [--port 0]
 */
public final class DesktopMain {
    public static void main(String[] args) throws Exception {
        String publicDir = "public";
        String defaults = "server/defaults.jsonc";
        String mediaDir = "media";
        String dataDir = "data";
        int port = 0;
        for (int i = 0; i + 1 < args.length; i += 2) {
            switch (args[i]) {
                case "--public":
                    publicDir = args[i + 1];
                    break;
                case "--defaults":
                    defaults = args[i + 1];
                    break;
                case "--media":
                    mediaDir = args[i + 1];
                    break;
                case "--data":
                    dataDir = args[i + 1];
                    break;
                case "--port":
                    port = Integer.parseInt(args[i + 1]);
                    break;
                default:
                    throw new IllegalArgumentException("Unbekannte Option " + args[i]);
            }
        }

        final File media = new File(mediaDir);
        final FileMediaSource source = new FileMediaSource(media);
        Platform platform = new Platform() {
            @Override
            public String name() {
                return "desktop";
            }

            @Override
            public String version() {
                return "test";
            }

            @Override
            public Map<String, Object> mediaInfo() {
                return Json.object("label", media.getPath());
            }

            @Override
            public boolean system(String action) {
                if (action.equals("quit")) {
                    new Thread(new Runnable() {
                        @Override
                        public void run() {
                            System.exit(0);
                        }
                    }).start();
                    return true;
                }
                return false;
            }

            @Override
            public void log(String level, String message) {
                System.out.println("[" + level + "] " + message);
            }
        };
        String defaultsText = new FileMediaSource(new File(defaults).getAbsoluteFile().getParentFile()).readText(new File(defaults).getName());
        Store store = new Store(defaultsText, new File(dataDir), new Store.ConfigReader() {
            @Override
            public String read() throws IOException {
                return source.readText("config.json");
            }
        }, platform);
        TvServer server = new TvServer(store, TvServer.directoryAssets(new File(publicDir)), source, platform);
        int actual = server.start("127.0.0.1", port);
        System.out.println("PORT=" + actual);
        System.out.flush();
        Thread.currentThread().join();
    }
}
