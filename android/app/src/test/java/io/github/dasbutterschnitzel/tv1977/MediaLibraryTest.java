package io.github.dasbutterschnitzel.tv1977;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.Manifest;
import android.app.AlertDialog;
import android.app.Application;
import android.content.ContentProvider;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.DialogInterface;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowAlertDialog;
import org.robolectric.shadows.ShadowLooper;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import io.github.dasbutterschnitzel.tv1977.server.Json;

/**
 * Mediathek des Geräts als Sender: Rechteabfrage, Albenauswahl und Auslieferung der Videos,
 * geprüft gegen eine nachgebaute Mediathek in der simulierten Android-Umgebung.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class MediaLibraryTest {

    /** Nachbau der Android-Mediathek mit drei Videos in zwei Alben. */
    public static class FakeMediaStore extends ContentProvider {
        static final List<Object[]> ROWS = new ArrayList<>();

        @Override
        public boolean onCreate() {
            return true;
        }

        @Override
        public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
            MatrixCursor cursor = new MatrixCursor(projection);
            long single = uri.getLastPathSegment().matches("\\d+") ? ContentUris.parseId(uri) : -1;
            for (Object[] row : ROWS) {
                if (single >= 0 && !row[0].equals(single)) continue;
                if (selection != null && selection.contains("bucket_id") && !row[5].equals(args[0])) continue;
                Object[] values = new Object[projection.length];
                for (int i = 0; i < projection.length; i++) {
                    switch (projection[i]) {
                        case "_id":
                            values[i] = row[0];
                            break;
                        case "_display_name":
                            values[i] = row[1];
                            break;
                        case "_size":
                            values[i] = row[2];
                            break;
                        case "date_modified":
                            values[i] = row[3];
                            break;
                        case "duration":
                            values[i] = row[4];
                            break;
                        case "bucket_id":
                            values[i] = row[5];
                            break;
                        case "bucket_display_name":
                            values[i] = row[6];
                            break;
                        default:
                            values[i] = null;
                    }
                }
                cursor.addRow(values);
            }
            return cursor;
        }

        @Override
        public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
            long id = ContentUris.parseId(uri);
            for (Object[] row : ROWS) {
                if (row[0].equals(id)) return ParcelFileDescriptor.open((File) row[7], ParcelFileDescriptor.MODE_READ_ONLY);
            }
            throw new FileNotFoundException(uri.toString());
        }

        @Override
        public String getType(Uri uri) {
            return "video/mp4";
        }

        @Override
        public Uri insert(Uri uri, ContentValues values) {
            return null;
        }

        @Override
        public int delete(Uri uri, String selection, String[] args) {
            return 0;
        }

        @Override
        public int update(Uri uri, ContentValues values, String selection, String[] args) {
            return 0;
        }
    }

    private Application app;

    private static File video(String content) throws IOException {
        File file = File.createTempFile("video", ".bin");
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(content.getBytes(StandardCharsets.UTF_8));
        }
        return file;
    }

    @Before
    public void setUp() throws IOException {
        app = RuntimeEnvironment.getApplication();
        FakeMediaStore.ROWS.clear();
        // _id, Name, Größe, geändert (s), Länge (ms), Album-Kennung, Album-Name, Datei
        FakeMediaStore.ROWS.add(new Object[]{11L, "VID_20240102.mp4", 10L, 1700000000L, 61500L, "b-cam", "Camera", video("0123456789")});
        FakeMediaStore.ROWS.add(new Object[]{12L, "Urlaub", 4L, 1700000100L, 8000L, "b-cam", "Camera", video("abcd")});
        FakeMediaStore.ROWS.add(new Object[]{13L, "wird-noch-kopiert.mp4", 0L, 1700000200L, 0L, "b-cam", "Camera", video("")});
        FakeMediaStore.ROWS.add(new Object[]{21L, "lustig.mp4", 3L, 1700000300L, 3000L, "b-wa", "WhatsApp Video", video("xyz")});
        Robolectric.buildContentProvider(FakeMediaStore.class).create(MediaStore.AUTHORITY);
    }

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

    private static void post(int port, String action) throws IOException {
        HttpURLConnection connection = open(port, "/api/system");
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.getOutputStream().write(("{\"action\":\"" + action + "\"}").getBytes(StandardCharsets.UTF_8));
        assertEquals(200, connection.getResponseCode());
    }

    /** Wartet, bis Hintergrundarbeit und Oberfläche fertig sind und die Bedingung gilt. */
    private interface Condition {
        boolean holds() throws Exception;
    }

    private static void await(String what, Condition condition) throws Exception {
        for (int i = 0; i < 100; i++) {
            ShadowLooper.idleMainLooper();
            if (condition.holds()) return;
            Thread.sleep(50);
        }
        throw new AssertionError("Zeitüberschreitung: " + what);
    }

    private static List<String> channelNames(int port) throws IOException {
        List<String> names = new ArrayList<>();
        for (Object c : (List<?>) config(port).get("channels")) names.add(Json.asObject(c).get("name") + "=" + Json.asObject(c).get("type"));
        return names;
    }

    @Test
    public void albumsAreListedWithCounts() {
        shadowOf(app).grantPermissions(Manifest.permission.READ_MEDIA_VIDEO);
        List<MediaLibrary.AlbumInfo> albums = MediaLibrary.albums(app);
        assertEquals(2, albums.size());
        assertEquals("Camera", albums.get(0).name);
        assertEquals(3, albums.get(0).count);
        assertEquals("WhatsApp Video", albums.get(1).name);
        assertEquals(1, albums.get(1).count);
        assertTrue(MediaLibrary.hasFullAccess(app));
        assertFalse(MediaLibrary.hasPartialAccess(app));
    }

    @Test
    public void partialAccessCountsAsAccess() {
        assertFalse(MediaLibrary.hasAccess(app));
        shadowOf(app).grantPermissions(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED);
        assertTrue(MediaLibrary.hasPartialAccess(app));
        assertTrue(MediaLibrary.hasAccess(app));
        assertFalse(MediaLibrary.hasFullAccess(app));
    }

    @Test
    public void firstStartAsksForSourcesThenPermissionThenAlbums() throws Exception {
        ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class).setup();
        final MainActivity activity = controller.get();
        final int port = activity.serverPort();
        assertEquals(java.util.Collections.singletonList("Testbild=testcard"), channelNames(port));
        assertEquals("none", Json.asObject(config(port).get("media")).get("libraryAccess"));

        // erster Start: Die App fragt von sich aus, woher die Filme kommen sollen
        ShadowLooper.idleMainLooper(2, TimeUnit.SECONDS);
        AlertDialog sources = ShadowAlertDialog.getLatestAlertDialog();
        assertNotNull("Auswahl der Quellen erscheint", sources);
        assertEquals(activity.getString(R.string.sources_title), shadowOf(sources).getTitle().toString());

        // "Alben vom Gerät": ohne Berechtigung fragt Android erst nach dem Zugriff auf Videos
        shadowOf(sources).clickOnItem(0);
        org.robolectric.shadows.ShadowActivity.PermissionsRequest request = shadowOf(activity).getLastRequestedPermission();
        assertNotNull("Berechtigung wird erfragt", request);
        assertEquals(Manifest.permission.READ_MEDIA_VIDEO, request.requestedPermissions[0]);

        // Ablehnen: Erklärung mit der Möglichkeit, stattdessen einzelne Videos zu wählen
        activity.onRequestPermissionsResult(request.requestCode, request.requestedPermissions, new int[]{PackageManager.PERMISSION_DENIED, PackageManager.PERMISSION_DENIED});
        ShadowLooper.idleMainLooper();
        AlertDialog denied = ShadowAlertDialog.getLatestAlertDialog();
        assertEquals(activity.getString(R.string.permission_title), shadowOf(denied).getTitle().toString());
        assertEquals(activity.getString(R.string.source_videos), denied.getButton(DialogInterface.BUTTON_NEUTRAL).getText().toString());
        denied.dismiss();

        // Erlauben (über die Bedienseite erneut angestoßen): Liste der Alben erscheint
        post(port, "pickAlbums");
        ShadowLooper.idleMainLooper();
        shadowOf(app).grantPermissions(Manifest.permission.READ_MEDIA_VIDEO);
        activity.onRequestPermissionsResult(request.requestCode, request.requestedPermissions, new int[]{PackageManager.PERMISSION_GRANTED, PackageManager.PERMISSION_DENIED});
        await("Albenliste", new Condition() {
            @Override
            public boolean holds() {
                AlertDialog d = ShadowAlertDialog.getLatestAlertDialog();
                return d != null && d.isShowing() && activity.getString(R.string.albums_title).contentEquals(shadowOf(d).getTitle());
            }
        });
        AlertDialog albums = ShadowAlertDialog.getLatestAlertDialog();
        CharSequence[] items = shadowOf(albums).getItems();
        assertEquals("Camera (3 Videos)", items[0].toString());
        assertEquals("WhatsApp Video (1 Video)", items[1].toString());

        // "Camera" ankreuzen und bestätigen: das Album wird ein Sender
        shadowOf(albums).clickOnItem(0);
        albums.getButton(DialogInterface.BUTTON_POSITIVE).performClick();
        await("Sender Camera", new Condition() {
            @Override
            public boolean holds() throws Exception {
                return channelNames(port).contains("Camera=video");
            }
        });
        assertEquals(java.util.Collections.singletonList("Camera=video"), channelNames(port));
        Map<String, Object> media = Json.asObject(config(port).get("media"));
        assertEquals("Alben: Camera", media.get("label"));
        assertEquals("full", media.get("libraryAccess"));
        assertEquals(Boolean.TRUE, media.get("chosen"));
        controller.pause().stop().destroy();
    }

    @Test
    public void chosenAlbumIsServedWithDurationsAndRanges() throws Exception {
        shadowOf(app).grantPermissions(Manifest.permission.READ_MEDIA_VIDEO);
        app.getSharedPreferences("tv", 0).edit().putBoolean("welcomed", true)
                .putString("albums", "[{\"id\":\"b-cam\",\"name\":\"Camera\"},{\"id\":\"b-wa\",\"name\":\"WhatsApp Video\"}]").commit();
        ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class).setup();
        final int port = controller.get().serverPort();

        // kein ungefragter Dialog, wenn schon etwas eingerichtet ist
        ShadowLooper.idleMainLooper(2, TimeUnit.SECONDS);
        assertNull(ShadowAlertDialog.getLatestAlertDialog());

        List<?> channels = (List<?>) config(port).get("channels");
        assertEquals(2, channels.size());
        Map<String, Object> camera = Json.asObject(channels.get(0));
        assertEquals("Camera", camera.get("name"));
        List<?> files = (List<?>) camera.get("files");
        assertEquals("das Video, das noch kopiert wird (Größe 0), fehlt", 2, files.size());
        Map<String, Object> first = Json.asObject(files.get(0));
        Map<String, Object> second = Json.asObject(files.get(1));
        assertEquals("Urlaub.mp4", first.get("name"));
        assertEquals(8.0, ((Number) first.get("duration")).doubleValue(), 1e-9);
        assertEquals("VID_20240102.mp4", second.get("name"));
        assertEquals(61.5, ((Number) second.get("duration")).doubleValue(), 1e-9);
        assertEquals(1700000000000L, ((Number) second.get("mtime")).longValue());

        HttpURLConnection part = open(port, (String) second.get("url"));
        part.setRequestProperty("Range", "bytes=2-5");
        assertEquals(206, part.getResponseCode());
        assertEquals("2345", body(part));
        assertEquals("abcd", body(open(port, (String) first.get("url"))));
        assertEquals(404, open(port, "/media/Camera/gibtesnicht.mp4").getResponseCode());
        assertEquals(404, open(port, "/media/Camera/wird-noch-kopiert.mp4").getResponseCode());

        // Zurücksetzen entfernt die Alben wieder
        post(port, "resetMedia");
        await("Zurücksetzen", new Condition() {
            @Override
            public boolean holds() throws Exception {
                return channelNames(port).equals(java.util.Collections.singletonList("Testbild=testcard"));
            }
        });
        controller.pause().stop().destroy();
    }

    @Test
    public void albumsStayHiddenWithoutPermission() throws Exception {
        app.getSharedPreferences("tv", 0).edit().putBoolean("welcomed", true).putString("albums", "[{\"id\":\"b-cam\",\"name\":\"Camera\"}]").commit();
        ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class).setup();
        int port = controller.get().serverPort();
        assertEquals(java.util.Collections.singletonList("Testbild=testcard"), channelNames(port));
        assertEquals("Alben: Camera (Zugriff auf Videos fehlt)", Json.asObject(config(port).get("media")).get("label"));
        controller.pause().stop().destroy();
    }
}
