package io.github.dasbutterschnitzel.tv1977.server;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/** Filmordner im normalen Dateisystem. */
public final class FileMediaSource implements MediaSource {
    private final File root;

    public FileMediaSource(File root) {
        this.root = root;
    }

    /** Löst einen Pfad unterhalb des Ordners auf; alles außerhalb wird abgewiesen. */
    private File resolve(String path) throws IOException {
        if (path.indexOf('\0') >= 0) return null;
        File base = root.getCanonicalFile();
        File file = new File(base, path).getCanonicalFile();
        String basePath = base.getPath();
        if (!file.getPath().equals(basePath) && !file.getPath().startsWith(basePath + File.separator)) return null;
        return file;
    }

    @Override
    public List<Entry> list(String folder) throws IOException {
        List<Entry> entries = new ArrayList<>();
        File dir = resolve(folder);
        File[] files = dir == null ? null : dir.listFiles();
        if (files == null) return entries;
        for (File f : files) entries.add(new Entry(f.getName(), f.isDirectory(), f.length(), f.lastModified()));
        return entries;
    }

    @Override
    public String readText(String path) throws IOException {
        File file = resolve(path);
        if (file == null || !file.isFile() || file.length() > 1024 * 1024) return null;
        try (InputStream in = new FileInputStream(file)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int n;
            while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    @Override
    public Media open(String path) throws IOException {
        final File file = resolve(path);
        if (file == null || !file.isFile()) return null;
        final long length = file.length();
        final long modified = file.lastModified();
        return new Media() {
            @Override
            public long length() {
                return length;
            }

            @Override
            public long lastModified() {
                return modified;
            }

            @Override
            public InputStream stream(long start) throws IOException {
                FileInputStream in = new FileInputStream(file);
                try {
                    if (start > 0) in.getChannel().position(start);
                } catch (IOException e) {
                    in.close();
                    throw e;
                }
                return in;
            }
        };
    }

    @Override
    public String describe() {
        return root.getPath();
    }
}
