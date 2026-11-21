package io.github.dasbutterschnitzel.tv1977;

import android.annotation.SuppressLint;
import android.annotation.TargetApi;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.content.res.AssetManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileWriter;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import io.github.dasbutterschnitzel.tv1977.server.AssetSource;
import io.github.dasbutterschnitzel.tv1977.server.FileMediaSource;
import io.github.dasbutterschnitzel.tv1977.server.Json;
import io.github.dasbutterschnitzel.tv1977.server.MediaSource;
import io.github.dasbutterschnitzel.tv1977.server.Platform;
import io.github.dasbutterschnitzel.tv1977.server.Store;
import io.github.dasbutterschnitzel.tv1977.server.TvServer;

/**
 * Der Fernseher als Android-App: startet den eingebauten Server und zeigt die Anzeige
 * bildschirmfüllend in einer WebView. Die Anzeige selbst (Ordner public/) ist dieselbe
 * wie unter Windows und auf dem Raspberry Pi.
 */
public final class MainActivity extends Activity implements Platform {
    private static final String TAG = "TV1977";
    private static final String PREFS = "tv";
    private static final String PREF_TREE = "mediaTree";
    private static final int REQUEST_FOLDER = 1;
    private static final long HEARTBEAT_TIMEOUT_MS = 60000;
    private static final long WATCHDOG_INTERVAL_MS = 10000;
    private static final long MAX_LOG_BYTES = 2 * 1024 * 1024;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private SharedPreferences prefs;
    private FrameLayout root;
    private WebView webView;
    private TvServer server;
    private volatile MediaSource media;
    private volatile boolean mediaChosen;
    private File appMediaDir;
    private int port;
    private boolean resumed;
    private long watchSince;
    private long backPressedAt;

    // ------------------------------------------------------------ Lebenszyklus

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window window = getWindow();
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams attributes = window.getAttributes();
            attributes.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            window.setAttributes(attributes);
        }
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        setContentView(root);
        hideSystemBars();

        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        File external = getExternalFilesDir("media");
        appMediaDir = external != null ? external : new File(getFilesDir(), "media");
        if (!appMediaDir.isDirectory() && !appMediaDir.mkdirs()) Log.w(TAG, "App-Ordner lässt sich nicht anlegen: " + appMediaDir);
        media = chosenOrAppFolder();

        try {
            startServer();
        } catch (IOException | RuntimeException e) {
            Log.e(TAG, "Serverstart fehlgeschlagen", e);
            TextView message = new TextView(this);
            message.setTextColor(Color.WHITE);
            message.setGravity(Gravity.CENTER);
            message.setText(getString(R.string.server_failed, String.valueOf(e.getMessage())));
            root.addView(message, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            return;
        }
        createWebView();
        handler.postDelayed(watchdog, WATCHDOG_INTERVAL_MS);
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        watchSince = SystemClock.elapsedRealtime();
        hideSystemBars();
        if (webView != null) {
            webView.onResume();
            webView.resumeTimers();
        }
    }

    @Override
    protected void onPause() {
        resumed = false;
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        destroyWebView();
        if (server != null) server.stop();
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    /** "Zurück" schließt zuerst die Einstellungen; zweimal kurz hintereinander beendet die App. */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        long now = SystemClock.elapsedRealtime();
        if (now - backPressedAt < 2500) {
            finish();
            return;
        }
        backPressedAt = now;
        if (webView != null) webView.evaluateJavascript("window.postMessage('tv-close-settings', location.origin)", null);
        Toast.makeText(this, R.string.back_again, Toast.LENGTH_SHORT).show();
    }

    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        Window window = getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false);
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.systemBars());
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            window.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
    }

    /** Port des eingebauten Servers (für Tests). */
    int serverPort() {
        return port;
    }

    // ------------------------------------------------------------ Server

    private void startServer() throws IOException {
        String defaults = new String(readAsset(getAssets(), "defaults.jsonc"), StandardCharsets.UTF_8);
        Store store = new Store(defaults, getFilesDir(), new Store.ConfigReader() {
            @Override
            public String read() throws IOException {
                // config.json liegt – falls vorhanden – im Filmordner
                MediaSource source = media;
                return source == null ? null : source.readText("config.json");
            }
        }, this);
        Map<String, Object> settings = Json.asObject(store.baseSettings().get("server"));
        String host = Json.string(settings, "host", "127.0.0.1");
        int wanted = (int) Json.number(settings, "port", 7777);
        server = new TvServer(store, new AssetSource() {
            private final Map<String, byte[]> cache = new ConcurrentHashMap<>();

            @Override
            public byte[] read(String path) throws IOException {
                byte[] data = cache.get(path);
                if (data != null) return data;
                try {
                    data = readAsset(getAssets(), "www/" + path);
                } catch (FileNotFoundException e) {
                    return null;
                }
                cache.put(path, data);
                return data;
            }
        }, media, this);
        try {
            port = server.start(host, wanted);
        } catch (IOException busy) {
            // Port belegt (z. B. von einer hängengebliebenen früheren Instanz): freien Port nehmen
            log("warn", "Port " + wanted + " nicht verfügbar (" + busy.getMessage() + "), nehme einen freien.");
            port = server.start(host, 0);
        }
        log("info", "TV-Simulator " + version() + " läuft auf Port " + port + ", Filme: " + media.describe());
    }

    private static byte[] readAsset(AssetManager assets, String name) throws IOException {
        try (InputStream in = assets.open(name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[16 * 1024];
            int n;
            while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
            return out.toByteArray();
        }
    }

    /** Der zuletzt gewählte Ordner, solange die Freigabe noch gilt; sonst der Ordner der App. */
    private MediaSource chosenOrAppFolder() {
        String saved = prefs.getString(PREF_TREE, null);
        if (saved != null) {
            Uri tree = Uri.parse(saved);
            for (UriPermission permission : getContentResolver().getPersistedUriPermissions()) {
                if (permission.isReadPermission() && permission.getUri().equals(tree)) {
                    mediaChosen = true;
                    return new SafMediaSource(this, tree);
                }
            }
        }
        mediaChosen = false;
        return new FileMediaSource(appMediaDir);
    }

    // ------------------------------------------------------------ Anzeige

    @SuppressLint("SetJavaScriptEnabled")
    private void createWebView() {
        final WebView view = new WebView(this);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true); // die Anzeige ist ein Skriptprogramm aus der App selbst
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportZoom(false);
        settings.setTextZoom(100);
        view.setBackgroundColor(Color.BLACK);
        view.setOverScrollMode(View.OVER_SCROLL_NEVER);
        view.setVerticalScrollBarEnabled(false);
        view.setHorizontalScrollBarEnabled(false);
        view.setKeepScreenOn(true);
        view.setFocusable(true);
        view.setFocusableInTouchMode(true);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        final String origin = "http://127.0.0.1:" + port;
        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                // nur die eigene Anzeige, keine fremden Seiten
                return !request.getUrl().toString().startsWith(origin + "/");
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                log("warn", "Anzeige konnte nicht geladen werden: " + error.getDescription());
                handler.postDelayed(new Runnable() {
                    @Override
                    public void run() {
                        if (webView == v) v.loadUrl(origin + "/");
                    }
                }, 2000);
            }

            @Override
            @TargetApi(Build.VERSION_CODES.O) // wird vom System erst ab Android 8 aufgerufen
            public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail detail) {
                // Der Darstellungsprozess wurde beendet (Absturz oder Speichermangel): neu aufbauen statt die App zu beenden
                log("warn", "Darstellungsprozess beendet (" + (detail.didCrash() ? "Absturz" : "vom System") + ") – Anzeige wird neu aufgebaut.");
                handler.post(new Runnable() {
                    @Override
                    public void run() {
                        if (webView == v) recreateWebView();
                    }
                });
                return true;
            }
        });
        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) Log.e(TAG, message.message() + " (" + message.sourceId() + ":" + message.lineNumber() + ")");
                return true;
            }

            @Override
            public Bitmap getDefaultVideoPoster() {
                // sonst zeigt Android ein graues Abspielsymbol, solange ein Video lädt
                return Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
            }
        });

        webView = view;
        root.addView(view, 0, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        view.requestFocus();
        view.loadUrl(origin + "/");
        watchSince = SystemClock.elapsedRealtime();
    }

    private void destroyWebView() {
        WebView view = webView;
        webView = null;
        if (view == null) return;
        root.removeView(view);
        view.stopLoading();
        view.destroy();
    }

    private void recreateWebView() {
        destroyWebView();
        createWebView();
        if (!resumed && webView != null) webView.onPause();
    }

    /** Meldet sich die Anzeige eine Minute lang nicht mehr, wird sie neu aufgebaut. */
    private final Runnable watchdog = new Runnable() {
        @Override
        public void run() {
            handler.postDelayed(this, WATCHDOG_INTERVAL_MS);
            if (!resumed || server == null || webView == null) return;
            long now = SystemClock.elapsedRealtime();
            long lastStatus = server.lastStatusAt();
            long silentFor = lastStatus == 0 ? Long.MAX_VALUE : System.currentTimeMillis() - lastStatus;
            if (now - watchSince > HEARTBEAT_TIMEOUT_MS && silentFor > HEARTBEAT_TIMEOUT_MS) {
                log("warn", "Die Anzeige meldet sich nicht mehr – sie wird neu aufgebaut.");
                recreateWebView();
            }
        }
    };

    // ------------------------------------------------------------ Filmordner

    private void pickFolder() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        try {
            startActivityForResult(intent, REQUEST_FOLDER);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, R.string.no_picker, Toast.LENGTH_LONG).show();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_FOLDER || resultCode != RESULT_OK || data == null || data.getData() == null) return;
        Uri tree = data.getData();
        try {
            getContentResolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (SecurityException e) {
            Toast.makeText(this, R.string.folder_failed, Toast.LENGTH_LONG).show();
            return;
        }
        // frühere Freigaben zurückgeben, es wird immer nur ein Ordner benutzt
        for (UriPermission permission : getContentResolver().getPersistedUriPermissions()) {
            if (!permission.getUri().equals(tree)) {
                try {
                    getContentResolver().releasePersistableUriPermission(permission.getUri(), Intent.FLAG_GRANT_READ_URI_PERMISSION);
                } catch (SecurityException ignored) {
                    // war schon entzogen
                }
            }
        }
        prefs.edit().putString(PREF_TREE, tree.toString()).apply();
        useMedia(new SafMediaSource(this, tree), true);
    }

    private void useMedia(final MediaSource source, boolean chosen) {
        media = source;
        mediaChosen = chosen;
        log("info", "Filmordner: " + source.describe());
        // Einlesen kann bei vielen Dateien dauern – nicht auf dem Oberflächen-Thread
        new Thread(new Runnable() {
            @Override
            public void run() {
                if (server != null) server.setMedia(source);
            }
        }, "tv-media").start();
    }

    // ------------------------------------------------------------ Platform (Aufrufe vom Server)

    @Override
    public String name() {
        return "android";
    }

    @Override
    public String version() {
        return BuildConfig.VERSION_NAME;
    }

    @Override
    public Map<String, Object> mediaInfo() {
        MediaSource source = media;
        return Json.object("label", source == null ? "" : source.describe(), "chosen", mediaChosen, "appFolder", appMediaDir.getPath());
    }

    @Override
    public boolean system(final String action) {
        switch (action) {
            case "pickFolder":
            case "useAppFolder":
            case "restartBrowser":
            case "quit":
                break;
            default:
                return false;
        }
        handler.post(new Runnable() {
            @Override
            public void run() {
                if (isFinishing() || isDestroyed()) return;
                switch (action) {
                    case "pickFolder":
                        pickFolder();
                        break;
                    case "useAppFolder":
                        prefs.edit().remove(PREF_TREE).apply();
                        useMedia(new FileMediaSource(appMediaDir), false);
                        break;
                    case "restartBrowser":
                        recreateWebView();
                        break;
                    default:
                        finishAndRemoveTask();
                }
            }
        });
        return true;
    }

    @Override
    public void log(String level, String message) {
        if ("error".equals(level)) Log.e(TAG, message);
        else if ("warn".equals(level)) Log.w(TAG, message);
        else Log.i(TAG, message);
        // zusätzlich in eine Datei, damit sich Störungen im Ausstellungsbetrieb nachvollziehen lassen
        synchronized (this) {
            File file = new File(getFilesDir(), "tv.log");
            if (file.length() > MAX_LOG_BYTES && !file.renameTo(new File(getFilesDir(), "tv.log.1"))) return;
            try (FileWriter writer = new FileWriter(file, true)) {
                writer.write(new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(new Date()) + " [" + level + "] " + message + "\n");
            } catch (IOException ignored) {
                // Protokoll ist nicht lebenswichtig
            }
        }
    }
}
