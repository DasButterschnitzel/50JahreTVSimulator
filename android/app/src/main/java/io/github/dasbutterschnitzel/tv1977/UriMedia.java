package io.github.dasbutterschnitzel.tv1977;

import android.content.ContentResolver;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;

import io.github.dasbutterschnitzel.tv1977.server.MediaSource;

/** Ein Video hinter einer Android-Inhaltsadresse (Mediathek, Ordnerfreigabe, Auswahl), lesbar ab beliebiger Stelle. */
final class UriMedia implements MediaSource.Media {
    private final ContentResolver resolver;
    private final Uri uri;
    private final long length;
    private final long lastModified;

    UriMedia(ContentResolver resolver, Uri uri, long length, long lastModified) {
        this.resolver = resolver;
        this.uri = uri;
        this.length = length;
        this.lastModified = lastModified;
    }

    @Override
    public long length() {
        return length;
    }

    @Override
    public long lastModified() {
        return lastModified;
    }

    @Override
    public InputStream stream(long start) throws IOException {
        ParcelFileDescriptor descriptor;
        try {
            descriptor = resolver.openFileDescriptor(uri, "r");
        } catch (SecurityException | IllegalArgumentException | IllegalStateException | FileNotFoundException e) {
            throw new IOException("Video nicht lesbar: " + e.getMessage());
        }
        if (descriptor == null) throw new IOException("Video nicht lesbar");
        FileInputStream in = new ParcelFileDescriptor.AutoCloseInputStream(descriptor);
        try {
            if (start > 0) {
                try {
                    in.getChannel().position(start);
                } catch (IOException notSeekable) {
                    // z. B. manche USB- oder Cloud-Anbieter: bis zur Stelle vorlesen
                    long left = start;
                    byte[] skip = new byte[64 * 1024];
                    while (left > 0) {
                        int n = in.read(skip, 0, (int) Math.min(skip.length, left));
                        if (n < 0) break;
                        left -= n;
                    }
                }
            }
        } catch (IOException e) {
            in.close();
            throw e;
        }
        return in;
    }
}
