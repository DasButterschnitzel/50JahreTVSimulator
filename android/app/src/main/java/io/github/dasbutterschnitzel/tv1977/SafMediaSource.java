package io.github.dasbutterschnitzel.tv1977;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import io.github.dasbutterschnitzel.tv1977.server.MediaSource;

/**
 * Filmordner, den der Benutzer über Androids Ordnerauswahl freigegeben hat
 * (interner Speicher, SD-Karte oder USB-Stick).
 */
final class SafMediaSource implements MediaSource {
    private static final String[] COLUMNS = {Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED};

    private final Context context;
    private final ContentResolver resolver;
    private final Uri tree;
    private final String rootId;
    /** Pfad ("ordner/film.mp4") -> Kennung des Dokuments; wird beim Auflisten gefüllt. */
    private final Map<String, String> ids = new ConcurrentHashMap<>();

    SafMediaSource(Context context, Uri tree) {
        this.context = context.getApplicationContext();
        this.resolver = this.context.getContentResolver();
        this.tree = tree;
        this.rootId = DocumentsContract.getTreeDocumentId(tree);
    }

    private String idOf(String path) throws IOException {
        if (path.isEmpty()) return rootId;
        String id = ids.get(path);
        if (id != null) return id;
        // noch nicht bekannt: den übergeordneten Ordner auflisten
        int slash = path.lastIndexOf('/');
        String parent = slash < 0 ? "" : path.substring(0, slash);
        if (!parent.isEmpty() && parent.contains("/")) return null; // tiefer als Sender/Film gibt es nicht
        list(parent);
        return ids.get(path);
    }

    @Override
    public List<Entry> list(String folder) throws IOException {
        List<Entry> entries = new ArrayList<>();
        String parentId = folder.isEmpty() ? rootId : idOf(folder);
        if (parentId == null) return entries;
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId);
        try (Cursor cursor = resolver.query(children, COLUMNS, null, null, null)) {
            if (cursor == null) throw new IOException("Ordner nicht lesbar");
            while (cursor.moveToNext()) {
                String id = cursor.getString(0);
                String name = cursor.getString(1);
                if (id == null || name == null) continue;
                boolean directory = Document.MIME_TYPE_DIR.equals(cursor.getString(2));
                long size = cursor.isNull(3) ? 0 : cursor.getLong(3);
                long modified = cursor.isNull(4) ? 0 : cursor.getLong(4);
                ids.put(folder.isEmpty() ? name : folder + "/" + name, id);
                entries.add(new Entry(name, directory, size, modified));
            }
        } catch (SecurityException | IllegalArgumentException | UnsupportedOperationException e) {
            throw new IOException("Kein Zugriff auf den Ordner: " + e.getMessage());
        }
        return entries;
    }

    @Override
    public String readText(String path) throws IOException {
        String id = idOf(path);
        if (id == null) return null;
        Uri uri = DocumentsContract.buildDocumentUriUsingTree(tree, id);
        try (InputStream in = resolver.openInputStream(uri)) {
            if (in == null) return null;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int n;
            while ((n = in.read(buffer)) > 0) {
                out.write(buffer, 0, n);
                if (out.size() > 1024 * 1024) throw new IOException("Datei zu groß");
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } catch (SecurityException | IllegalArgumentException e) {
            throw new IOException(e.getMessage());
        }
    }

    @Override
    public Media open(String path) throws IOException {
        String id = idOf(path);
        if (id == null) return null;
        final Uri uri = DocumentsContract.buildDocumentUriUsingTree(tree, id);
        long size = -1;
        long modified = 0;
        try (Cursor cursor = resolver.query(uri, COLUMNS, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                if (Document.MIME_TYPE_DIR.equals(cursor.getString(2))) return null;
                size = cursor.isNull(3) ? -1 : cursor.getLong(3);
                modified = cursor.isNull(4) ? 0 : cursor.getLong(4);
            }
        } catch (SecurityException | IllegalArgumentException | UnsupportedOperationException e) {
            ids.remove(path);
            return null;
        }
        if (size < 0) {
            // Datei wurde gelöscht oder der Anbieter kennt die Größe nicht
            ids.remove(path);
            return null;
        }
        return new UriMedia(resolver, uri, size, modified);
    }

    @Override
    public String describe() {
        // Kennungen sehen aus wie "primary:Movies/Fernseher" oder "1A2B-3C4D:Filme"
        int colon = rootId.indexOf(':');
        if (colon < 0) return rootId;
        String volume = rootId.substring(0, colon);
        String path = rootId.substring(colon + 1);
        String storage = context.getString("primary".equals(volume) ? R.string.storage_internal : R.string.storage_card);
        return path.isEmpty() ? storage : storage + "/" + path;
    }
}
