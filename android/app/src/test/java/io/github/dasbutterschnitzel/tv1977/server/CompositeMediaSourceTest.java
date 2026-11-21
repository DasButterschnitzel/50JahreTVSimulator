package io.github.dasbutterschnitzel.tv1977.server;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Map;

/** Alben (Mediathek, Auswahl) erscheinen dem Senderscan wie zusätzliche Ordner. */
public class CompositeMediaSourceTest {

    private static CompositeMediaSource.Album album(final String name, final String... files) {
        return new CompositeMediaSource.Album() {
            @Override
            public String name() {
                return name;
            }

            @Override
            public List<MediaSource.Entry> list() {
                List<MediaSource.Entry> entries = new ArrayList<>();
                for (String file : files) entries.add(new MediaSource.Entry(file, false, 5, 1000, 12.5));
                return entries;
            }

            @Override
            public MediaSource.Media open(final String fileName) {
                if (!Arrays.asList(files).contains(fileName)) return null;
                return new MediaSource.Media() {
                    @Override
                    public long length() {
                        return 5;
                    }

                    @Override
                    public long lastModified() {
                        return 1000;
                    }

                    @Override
                    public InputStream stream(long start) {
                        return new ByteArrayInputStream((name + ":" + fileName).getBytes(StandardCharsets.UTF_8));
                    }
                };
            }
        };
    }

    private static List<String> names(List<Object> channels) {
        List<String> names = new ArrayList<>();
        for (Object c : channels) names.add(Json.asObject(c).get("id") + "=" + Json.asObject(c).get("type"));
        return names;
    }

    @Test
    public void albumsBecomeChannelsNextToFolders() throws IOException {
        File root = Files.createTempDirectory("tv77").toFile();
        File folder = new File(root, "01-tagesschau");
        assertTrue(folder.mkdirs());
        try (FileOutputStream out = new FileOutputStream(new File(folder, "a.mp4"))) {
            out.write(1);
        }
        try (FileOutputStream out = new FileOutputStream(new File(root, "config.json"))) {
            out.write("{}".getBytes(StandardCharsets.UTF_8));
        }
        CompositeMediaSource source = new CompositeMediaSource(new FileMediaSource(root),
                Arrays.asList(album("Camera", "VID_2.mp4", "VID_10.mp4"), album("Camera", "x.mp4"), album("WhatsApp/Video", "w.mp4"), album(".versteckt", "v.mp4")));

        MediaScanner.Result scan = MediaScanner.scan(source);
        assertEquals(Arrays.asList("01-tagesschau=video", "Album .versteckt=video", "Camera=video", "Camera (2)=video", "WhatsApp-Video=video"), names(scan.channels));
        assertTrue(scan.warnings.isEmpty());

        Map<String, Object> camera = Json.asObject(scan.channels.get(2));
        List<?> files = (List<?>) camera.get("files");
        assertEquals(2, files.size());
        Map<String, Object> first = Json.asObject(files.get(0));
        assertEquals("VID_2.mp4", first.get("name"));
        assertEquals("/media/Camera/VID_2.mp4", first.get("url"));
        assertEquals(12.5, ((Number) first.get("duration")).doubleValue(), 1e-9);

        // Dateien: aus dem Album, aus dem echten Ordner, und nichts Erfundenes
        assertEquals(5, source.open("Camera/VID_10.mp4").length());
        assertEquals(1, source.open("01-tagesschau/a.mp4").length());
        assertNull(source.open("Camera/gibtesnicht.mp4"));
        assertNull(source.open("Camera (2)/VID_2.mp4"));
        assertNull(source.open("Camera/../config.json"));
        assertEquals("{}", source.readText("config.json"));
        assertNull(source.readText("Camera/channel.json"));
    }

    @Test
    public void worksWithoutBaseFolderAndSurvivesUnreadableOne() throws IOException {
        CompositeMediaSource onlyAlbums = new CompositeMediaSource(null, Arrays.asList(album("Meine Auswahl", "001 film.mp4")));
        assertEquals(Arrays.asList("Meine Auswahl=video"), names(MediaScanner.scan(onlyAlbums).channels));
        assertNull(onlyAlbums.open("anderes/film.mp4"));
        assertNull(onlyAlbums.readText("config.json"));

        MediaSource broken = new MediaSource() {
            @Override
            public List<Entry> list(String folder) throws IOException {
                throw new IOException("USB-Stick abgezogen");
            }

            @Override
            public String readText(String path) {
                return null;
            }

            @Override
            public Media open(String path) {
                return null;
            }

            @Override
            public String describe() {
                return "kaputt";
            }
        };
        CompositeMediaSource withBroken = new CompositeMediaSource(broken, Arrays.asList(album("Camera", "a.mp4")));
        assertEquals(Arrays.asList("Camera=video"), names(MediaScanner.scan(withBroken).channels));
    }

    @Test
    public void namesAreMadePlayableAndUnique() {
        assertEquals("VID_1.mp4", CompositeMediaSource.playableName("VID_1.mp4"));
        assertEquals("clip.MOV", CompositeMediaSource.playableName("clip.MOV"));
        assertEquals("alt.3gp", CompositeMediaSource.playableName("alt.3gp"));
        assertEquals("ohne endung.mp4", CompositeMediaSource.playableName("ohne endung"));
        assertEquals("bild.jpg.mp4", CompositeMediaSource.playableName("bild.jpg"));
        assertEquals("a-b.mp4", CompositeMediaSource.playableName("a/b.mp4"));
        assertEquals("Video.mp4", CompositeMediaSource.playableName(null));
        assertEquals("Video.versteckt.mp4", CompositeMediaSource.playableName(".versteckt"));

        HashSet<String> taken = new HashSet<>();
        assertEquals("film.mp4", CompositeMediaSource.uniqueName("film.mp4", taken));
        assertEquals("film (2).mp4", CompositeMediaSource.uniqueName("film.mp4", taken));
        assertEquals("film (3).mp4", CompositeMediaSource.uniqueName("film.mp4", taken));
        assertEquals("ohne", CompositeMediaSource.uniqueName("ohne", taken));
        assertEquals("ohne (2)", CompositeMediaSource.uniqueName("ohne", taken));
    }
}
