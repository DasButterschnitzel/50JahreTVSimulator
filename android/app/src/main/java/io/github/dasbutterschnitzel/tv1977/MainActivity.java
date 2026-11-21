package io.github.dasbutterschnitzel.tv1977;

import android.annotation.SuppressLint;
import android.annotation.TargetApi;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.DialogInterface;
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
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
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
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import io.github.dasbutterschnitzel.tv1977.server.AssetSource;
import io.github.dasbutterschnitzel.tv1977.server.CompositeMediaSource;
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
    private static final String PREF_ALBUMS = "albums";
    private static final String PREF_PICKS = "picks";
    private static final String PREF_WELCOMED = "welcomed";
    private static final int REQUEST_FOLDER = 1;
    private static final int REQUEST_VIDEOS = 2;
    private static final int REQUEST_PERMISSION = 3;
    private static final int MAX_PICKS = 200;
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
        media = buildMedia();

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

        // Beim allerersten Start fragen, woher die Filme kommen sollen
        if (!prefs.getBoolean(PREF_WELCOMED, false) && !mediaChosen) {
            handler.postDelayed(new Runnable() {
                @Override
                public void run() {
                    prefs.edit().putBoolean(PREF_WELCOMED, true).apply();
                    showSourcesDialog();
                }
            }, 1200);
        }
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

    /**
     * Stellt die Filmquelle aus den gespeicherten Angaben zusammen: gewählter Ordner (sonst der
     * Ordner der App), dazu Alben der Mediathek und einzeln ausgewählte Videos als weitere Sender.
     */
    private MediaSource buildMedia() {
        MediaSource base = new FileMediaSource(appMediaDir);
        boolean chosen = false;
        Uri tree = savedTree();
        if (tree != null) {
            base = new SafMediaSource(this, tree);
            chosen = true;
        }
        List<CompositeMediaSource.Album> albums = new ArrayList<>();
        if (MediaLibrary.hasAccess(this)) {
            for (String[] album : savedAlbums()) albums.add(MediaLibrary.bucketAlbum(this, album[0], album[1]));
        }
        List<Uri> picks = savedPicks();
        if (!picks.isEmpty()) albums.add(MediaLibrary.pickedAlbum(this, getString(R.string.picked_album), picks));
        mediaChosen = chosen || !albums.isEmpty();
        return albums.isEmpty() ? base : new CompositeMediaSource(base, albums);
    }

    /** Der freigegebene Ordner, solange die Freigabe noch gilt. */
    private Uri savedTree() {
        String saved = prefs.getString(PREF_TREE, null);
        if (saved == null) return null;
        Uri tree = Uri.parse(saved);
        for (UriPermission permission : getContentResolver().getPersistedUriPermissions()) {
            if (permission.isReadPermission() && permission.getUri().equals(tree)) return tree;
        }
        return null;
    }

    /** Gewählte Alben als Paare aus Kennung und Name. */
    private List<String[]> savedAlbums() {
        List<String[]> list = new ArrayList<>();
        try {
            Object parsed = Json.parse(prefs.getString(PREF_ALBUMS, "[]"));
            if (parsed instanceof List) {
                for (Object item : (List<?>) parsed) {
                    Map<String, Object> album = Json.asObject(item);
                    if (album != null && album.get("id") instanceof String) list.add(new String[]{(String) album.get("id"), Json.string(album, "name", "Album")});
                }
            }
        } catch (RuntimeException ignored) {
            // beschädigter Eintrag: keine Alben
        }
        return list;
    }

    private List<Uri> savedPicks() {
        List<Uri> list = new ArrayList<>();
        try {
            Object parsed = Json.parse(prefs.getString(PREF_PICKS, "[]"));
            if (parsed instanceof List) {
                for (Object item : (List<?>) parsed) {
                    if (item instanceof String) list.add(Uri.parse((String) item));
                }
            }
        } catch (RuntimeException ignored) {
            // beschädigter Eintrag: keine Auswahl
        }
        return list;
    }

    /** Nach einer Änderung der Quellen: neu zusammenstellen und die Anzeige einlesen lassen. */
    private void applyMedia() {
        final MediaSource source = buildMedia();
        media = source;
        log("info", "Filme: " + source.describe());
        // Einlesen kann bei vielen Dateien dauern – nicht auf dem Oberflächen-Thread
        new Thread(new Runnable() {
            @Override
            public void run() {
                if (server != null) server.setMedia(source);
            }
        }, "tv-media").start();
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
        // der eingebettete YouTube-Player (YouTube-Sender) braucht Cookies in seinem eigenen Rahmen
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, true);

        final String origin = "http://127.0.0.1:" + port;
        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                // Das Hauptfenster zeigt nur die eigene Anzeige; eingebettete Rahmen (YouTube-Player) dürfen laden
                if (!request.isForMainFrame()) return false;
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

    // ------------------------------------------------------------ Filmquellen

    /** Auswahl, woher die Filme kommen sollen. */
    private void showSourcesDialog() {
        if (isFinishing() || isDestroyed()) return;
        CharSequence[] items = {getString(R.string.source_albums), getString(R.string.source_videos), getString(R.string.source_folder), getString(R.string.source_reset)};
        new AlertDialog.Builder(this).setTitle(R.string.sources_title).setItems(items, new DialogInterface.OnClickListener() {
            @Override
            public void onClick(DialogInterface dialog, int which) {
                if (which == 0) chooseAlbums();
                else if (which == 1) pickVideos();
                else if (which == 2) pickFolder();
                else resetMedia();
            }
        }).setNegativeButton(R.string.close, null).show();
    }

    /** Alben der Mediathek: erst die Berechtigung erfragen, dann die Liste zeigen. */
    private void chooseAlbums() {
        if (MediaLibrary.hasAccess(this)) showAlbumsDialog();
        else requestPermissions(MediaLibrary.permissions(), REQUEST_PERMISSION);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_PERMISSION) return;
        if (MediaLibrary.hasAccess(this)) {
            applyMedia(); // schon gewählte Alben werden jetzt lesbar
            showAlbumsDialog();
            return;
        }
        // Abgelehnt. Fragt Android nicht mehr nach, hilft nur noch der Weg über die App-Einstellungen.
        boolean canAskAgain = permissions.length > 0 && shouldShowRequestPermissionRationale(permissions[0]);
        AlertDialog.Builder dialog = new AlertDialog.Builder(this).setTitle(R.string.permission_title).setMessage(R.string.permission_denied).setNegativeButton(R.string.close, null);
        if (canAskAgain) {
            dialog.setPositiveButton(R.string.permission_retry, new DialogInterface.OnClickListener() {
                @Override
                public void onClick(DialogInterface d, int which) {
                    requestPermissions(MediaLibrary.permissions(), REQUEST_PERMISSION);
                }
            });
        } else {
            dialog.setPositiveButton(R.string.permission_settings, new DialogInterface.OnClickListener() {
                @Override
                public void onClick(DialogInterface d, int which) {
                    try {
                        startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", getPackageName(), null)));
                    } catch (ActivityNotFoundException e) {
                        Toast.makeText(MainActivity.this, R.string.folder_failed, Toast.LENGTH_LONG).show();
                    }
                }
            });
        }
        dialog.setNeutralButton(R.string.source_videos, new DialogInterface.OnClickListener() {
            @Override
            public void onClick(DialogInterface d, int which) {
                pickVideos();
            }
        });
        dialog.show();
    }

    private void showAlbumsDialog() {
        // Die Mediathek kann groß sein: im Hintergrund lesen, dann den Dialog zeigen
        new Thread(new Runnable() {
            @Override
            public void run() {
                final List<MediaLibrary.AlbumInfo> albums = MediaLibrary.albums(MainActivity.this);
                handler.post(new Runnable() {
                    @Override
                    public void run() {
                        showAlbumsDialog(albums);
                    }
                });
            }
        }, "tv-albums").start();
    }

    private void showAlbumsDialog(final List<MediaLibrary.AlbumInfo> albums) {
        if (isFinishing() || isDestroyed()) return;
        final boolean partial = MediaLibrary.hasPartialAccess(this);
        AlertDialog.Builder dialog = new AlertDialog.Builder(this).setTitle(R.string.albums_title).setNegativeButton(R.string.close, null);
        if (partial) {
            // Android 14+: Der Benutzer hat nur einzelne Videos freigegeben; die Auswahl lässt sich erweitern
            dialog.setNeutralButton(R.string.permission_more, new DialogInterface.OnClickListener() {
                @Override
                public void onClick(DialogInterface d, int which) {
                    requestPermissions(MediaLibrary.permissions(), REQUEST_PERMISSION);
                }
            });
        }
        if (albums.isEmpty()) {
            dialog.setMessage(partial ? R.string.albums_empty_partial : R.string.albums_empty).show();
            return;
        }
        List<String[]> saved = savedAlbums();
        CharSequence[] labels = new CharSequence[albums.size()];
        final boolean[] checked = new boolean[albums.size()];
        for (int i = 0; i < albums.size(); i++) {
            MediaLibrary.AlbumInfo album = albums.get(i);
            labels[i] = getResources().getQuantityString(R.plurals.album_label, album.count, album.name, album.count);
            for (String[] s : saved) {
                if (s[0].equals(album.id)) checked[i] = true;
            }
        }
        dialog.setMultiChoiceItems(labels, checked, new DialogInterface.OnMultiChoiceClickListener() {
            @Override
            public void onClick(DialogInterface d, int which, boolean isChecked) {
                checked[which] = isChecked;
            }
        }).setPositiveButton(android.R.string.ok, new DialogInterface.OnClickListener() {
            @Override
            public void onClick(DialogInterface d, int which) {
                List<Object> chosen = new ArrayList<>();
                for (int i = 0; i < albums.size(); i++) {
                    if (checked[i]) chosen.add(Json.object("id", albums.get(i).id, "name", albums.get(i).name));
                }
                prefs.edit().putString(PREF_ALBUMS, Json.stringify(chosen)).apply();
                applyMedia();
            }
        }).show();
    }

    /** Einzelne Videos über die Fotoauswahl des Systems – dort erscheinen auch Videos aus Google Fotos. */
    private void pickVideos() {
        List<Intent> candidates = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 33) {
            Intent picker = new Intent(MediaStore.ACTION_PICK_IMAGES);
            picker.setType("video/*");
            picker.putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, Math.min(100, MediaStore.getPickImagesMaxLimit()));
            candidates.add(picker);
        }
        Intent documents = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        documents.addCategory(Intent.CATEGORY_OPENABLE);
        documents.setType("video/*");
        documents.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        documents.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        candidates.add(documents);
        for (Intent intent : candidates) {
            try {
                startActivityForResult(intent, REQUEST_VIDEOS);
                return;
            } catch (ActivityNotFoundException e) {
                // nächste Möglichkeit versuchen
            }
        }
        Toast.makeText(this, R.string.no_picker, Toast.LENGTH_LONG).show();
    }

    private void pickFolder() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        try {
            startActivityForResult(intent, REQUEST_FOLDER);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, R.string.no_picker, Toast.LENGTH_LONG).show();
        }
    }

    /** Dauerhafte Lesefreigabe sichern, damit die Auswahl einen Neustart übersteht. */
    private boolean keepPermission(Uri uri) {
        try {
            getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            return true;
        } catch (SecurityException e) {
            return false;
        }
    }

    private void releasePermission(Uri uri) {
        try {
            getContentResolver().releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (SecurityException ignored) {
            // war schon entzogen
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (resultCode != RESULT_OK || data == null) return;

        if (requestCode == REQUEST_FOLDER && data.getData() != null) {
            Uri tree = data.getData();
            if (!keepPermission(tree)) {
                Toast.makeText(this, R.string.folder_failed, Toast.LENGTH_LONG).show();
                return;
            }
            String previous = prefs.getString(PREF_TREE, null);
            if (previous != null && !previous.equals(tree.toString())) releasePermission(Uri.parse(previous));
            prefs.edit().putString(PREF_TREE, tree.toString()).apply();
            applyMedia();
        } else if (requestCode == REQUEST_VIDEOS) {
            List<Uri> picked = new ArrayList<>();
            if (data.getClipData() != null) {
                for (int i = 0; i < data.getClipData().getItemCount(); i++) picked.add(data.getClipData().getItemAt(i).getUri());
            } else if (data.getData() != null) {
                picked.add(data.getData());
            }
            // neue Videos hinten an die bisherige Auswahl anhängen
            List<Uri> all = savedPicks();
            int lost = 0;
            for (Uri uri : picked) {
                if (uri == null || all.contains(uri)) continue;
                if (!keepPermission(uri)) lost++;
                all.add(uri);
            }
            while (all.size() > MAX_PICKS) releasePermission(all.remove(0));
            List<Object> stored = new ArrayList<>();
            for (Uri uri : all) stored.add(uri.toString());
            prefs.edit().putString(PREF_PICKS, Json.stringify(stored)).apply();
            if (lost > 0) Toast.makeText(this, R.string.picks_temporary, Toast.LENGTH_LONG).show();
            applyMedia();
        }
    }

    /** Alle Quellen vergessen; es bleibt der Ordner der App. */
    private void resetMedia() {
        for (UriPermission permission : getContentResolver().getPersistedUriPermissions()) releasePermission(permission.getUri());
        prefs.edit().remove(PREF_TREE).remove(PREF_ALBUMS).remove(PREF_PICKS).apply();
        applyMedia();
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
        List<Object> lines = new ArrayList<>();
        List<String[]> albums = savedAlbums();
        boolean access = MediaLibrary.hasAccess(this);
        if (!albums.isEmpty()) {
            StringBuilder names = new StringBuilder();
            for (String[] album : albums) names.append(names.length() == 0 ? "" : ", ").append(album[1]);
            lines.add(getString(access ? R.string.info_albums : R.string.info_albums_blocked, names.toString()));
        }
        int picks = savedPicks().size();
        if (picks > 0) lines.add(getResources().getQuantityString(R.plurals.info_picks, picks, picks));
        Uri tree = savedTree();
        if (tree != null) lines.add(getString(R.string.info_folder, new SafMediaSource(this, tree).describe()));
        if (lines.isEmpty()) lines.add(getString(R.string.info_none));
        StringBuilder label = new StringBuilder();
        for (Object line : lines) label.append(label.length() == 0 ? "" : "\n").append(line);
        return Json.object("label", label.toString(), "chosen", mediaChosen, "appFolder", appMediaDir.getPath(), "libraryAccess", MediaLibrary.hasFullAccess(this) ? "full" : MediaLibrary.hasPartialAccess(this) ? "partial" : "none");
    }

    @Override
    public boolean system(final String action) {
        switch (action) {
            case "manageMedia":
            case "pickAlbums":
            case "pickVideos":
            case "pickFolder":
            case "resetMedia":
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
                    case "manageMedia":
                        showSourcesDialog();
                        break;
                    case "pickAlbums":
                        chooseAlbums();
                        break;
                    case "pickVideos":
                        pickVideos();
                        break;
                    case "pickFolder":
                        pickFolder();
                        break;
                    case "resetMedia":
                    case "useAppFolder":
                        resetMedia();
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
