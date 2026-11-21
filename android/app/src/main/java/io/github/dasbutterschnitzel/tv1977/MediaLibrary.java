package io.github.dasbutterschnitzel.tv1977;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.provider.OpenableColumns;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

import io.github.dasbutterschnitzel.tv1977.server.CompositeMediaSource;
import io.github.dasbutterschnitzel.tv1977.server.MediaSource;

/**
 * Zugriff auf die Videos des Geräts: Alben der Mediathek (Kamera, Downloads, WhatsApp …,
 * also das, was auch Google Fotos unter „Auf dem Gerät“ zeigt) und einzeln ausgewählte Videos.
 */
final class MediaLibrary {

    /** Ein Album der Mediathek mit der Zahl seiner Videos. */
    static final class AlbumInfo {
        final String id;
        final String name;
        int count;

        AlbumInfo(String id, String name) {
            this.id = id;
            this.name = name;
        }
    }

    private MediaLibrary() {
    }

    /** Die Berechtigung(en), die auf dieser Android-Version für Videos nötig sind. */
    static String[] permissions() {
        if (Build.VERSION.SDK_INT >= 34) return new String[]{Manifest.permission.READ_MEDIA_VIDEO, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED};
        if (Build.VERSION.SDK_INT >= 33) return new String[]{Manifest.permission.READ_MEDIA_VIDEO};
        return new String[]{Manifest.permission.READ_EXTERNAL_STORAGE};
    }

    private static boolean granted(Context context, String permission) {
        return context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    /** Alle Videos des Geräts sind lesbar. */
    static boolean hasFullAccess(Context context) {
        return granted(context, Build.VERSION.SDK_INT >= 33 ? Manifest.permission.READ_MEDIA_VIDEO : Manifest.permission.READ_EXTERNAL_STORAGE);
    }

    /** Ab Android 14 kann der Benutzer nur einzelne Videos freigeben. */
    static boolean hasPartialAccess(Context context) {
        return Build.VERSION.SDK_INT >= 34 && !hasFullAccess(context) && granted(context, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED);
    }

    static boolean hasAccess(Context context) {
        return hasFullAccess(context) || hasPartialAccess(context);
    }

    private static Uri videos() {
        return MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
    }

    /** Alle Alben mit Videos, die größten zuerst. */
    static List<AlbumInfo> albums(Context context) {
        Map<String, AlbumInfo> byId = new LinkedHashMap<>();
        String[] columns = {MediaStore.Video.Media.BUCKET_ID, MediaStore.Video.Media.BUCKET_DISPLAY_NAME};
        try (Cursor cursor = context.getContentResolver().query(videos(), columns, null, null, null)) {
            while (cursor != null && cursor.moveToNext()) {
                String id = cursor.getString(0);
                if (id == null) continue;
                AlbumInfo info = byId.get(id);
                if (info == null) {
                    String name = cursor.getString(1);
                    info = new AlbumInfo(id, name == null || name.trim().isEmpty() ? context.getString(R.string.album_unnamed) : name.trim());
                    byId.put(id, info);
                }
                info.count++;
            }
        } catch (SecurityException | IllegalArgumentException | IllegalStateException e) {
            // keine Berechtigung oder Mediathek nicht verfügbar: leere Liste
        }
        List<AlbumInfo> list = new ArrayList<>(byId.values());
        Collections.sort(list, new Comparator<AlbumInfo>() {
            @Override
            public int compare(AlbumInfo a, AlbumInfo b) {
                return a.count != b.count ? b.count - a.count : a.name.compareToIgnoreCase(b.name);
            }
        });
        return list;
    }

    /** Ein Album der Mediathek als Sender. */
    static CompositeMediaSource.Album bucketAlbum(Context context, final String bucketId, final String name) {
        final ContentResolver resolver = context.getApplicationContext().getContentResolver();
        return new CompositeMediaSource.Album() {
            private final Map<String, MediaSource.Media> files = new ConcurrentHashMap<>();

            @Override
            public String name() {
                return name;
            }

            @Override
            public List<MediaSource.Entry> list() throws IOException {
                List<MediaSource.Entry> entries = new ArrayList<>();
                Map<String, MediaSource.Media> found = new LinkedHashMap<>();
                Set<String> taken = new HashSet<>();
                String[] columns = {MediaStore.Video.Media._ID, MediaStore.Video.Media.DISPLAY_NAME, MediaStore.Video.Media.SIZE, MediaStore.Video.Media.DATE_MODIFIED, MediaStore.Video.Media.DURATION};
                try (Cursor cursor = resolver.query(videos(), columns, MediaStore.Video.Media.BUCKET_ID + " = ?", new String[]{bucketId}, MediaStore.Video.Media.DISPLAY_NAME)) {
                    if (cursor == null) throw new IOException("Mediathek nicht lesbar");
                    while (cursor.moveToNext()) {
                        long size = cursor.isNull(2) ? 0 : cursor.getLong(2);
                        if (size <= 0) continue; // wird gerade aufgenommen oder kopiert
                        String fileName = CompositeMediaSource.uniqueName(CompositeMediaSource.playableName(cursor.getString(1)), taken);
                        long modified = cursor.isNull(3) ? 0 : cursor.getLong(3) * 1000;
                        double duration = cursor.isNull(4) ? 0 : cursor.getLong(4) / 1000.0;
                        Uri uri = ContentUris.withAppendedId(videos(), cursor.getLong(0));
                        found.put(fileName, new UriMedia(resolver, uri, size, modified));
                        entries.add(new MediaSource.Entry(fileName, false, size, modified, duration));
                    }
                } catch (SecurityException | IllegalArgumentException | IllegalStateException e) {
                    throw new IOException("Kein Zugriff auf die Mediathek: " + e.getMessage());
                }
                files.clear();
                files.putAll(found);
                return entries;
            }

            @Override
            public MediaSource.Media open(String fileName) throws IOException {
                MediaSource.Media media = files.get(fileName);
                if (media == null) {
                    list();
                    media = files.get(fileName);
                }
                return media;
            }
        };
    }

    /** Einzeln ausgewählte Videos (Fotoauswahl des Systems, auch aus Google Fotos) als Sender. */
    static CompositeMediaSource.Album pickedAlbum(Context context, final String name, final List<Uri> uris) {
        final ContentResolver resolver = context.getApplicationContext().getContentResolver();
        return new CompositeMediaSource.Album() {
            private final Map<String, MediaSource.Media> files = new ConcurrentHashMap<>();

            @Override
            public String name() {
                return name;
            }

            @Override
            public List<MediaSource.Entry> list() {
                List<MediaSource.Entry> entries = new ArrayList<>();
                Map<String, MediaSource.Media> found = new LinkedHashMap<>();
                Set<String> taken = new HashSet<>();
                int number = 0;
                for (Uri uri : uris) {
                    number++;
                    String displayName = null;
                    long size = -1;
                    try (Cursor cursor = resolver.query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
                        if (cursor != null && cursor.moveToFirst()) {
                            displayName = cursor.getString(0);
                            size = cursor.isNull(1) ? -1 : cursor.getLong(1);
                        }
                    } catch (SecurityException | IllegalArgumentException | IllegalStateException | UnsupportedOperationException e) {
                        continue; // Freigabe abgelaufen oder Video gelöscht
                    }
                    if (size <= 0) continue;
                    // Reihenfolge der Auswahl beibehalten
                    String base = CompositeMediaSource.playableName(displayName == null ? "Video" : displayName);
                    String fileName = CompositeMediaSource.uniqueName(String.format(java.util.Locale.ROOT, "%03d %s", number, base), taken);
                    found.put(fileName, new UriMedia(resolver, uri, size, 0));
                    entries.add(new MediaSource.Entry(fileName, false, size, 0));
                }
                files.clear();
                files.putAll(found);
                return entries;
            }

            @Override
            public MediaSource.Media open(String fileName) {
                MediaSource.Media media = files.get(fileName);
                if (media == null) {
                    list();
                    media = files.get(fileName);
                }
                return media;
            }
        };
    }
}
