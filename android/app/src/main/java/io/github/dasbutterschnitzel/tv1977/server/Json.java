package io.github.dasbutterschnitzel.tv1977.server;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Kleiner JSON-Leser und -Schreiber ohne Abhängigkeiten.
 *
 * Liest wie der Node-Server auch Dateien mit Kommentaren und überzähligen Kommas,
 * damit config.json und channel.json von Hand bearbeitet werden können.
 * Objekte werden zu LinkedHashMap, Listen zu ArrayList, Zahlen zu Long oder Double.
 */
public final class Json {
    private static final int MAX_DEPTH = 64;

    private Json() {
    }

    // ------------------------------------------------------------ Lesen

    public static Object parse(String text) {
        Parser p = new Parser(text);
        p.skipSpace();
        Object value = p.value(0);
        p.skipSpace();
        if (p.pos < p.s.length()) throw p.error("Unerwartetes Zeichen");
        return value;
    }

    private static final class Parser {
        final String s;
        int pos;

        Parser(String text) {
            // Windows-Editoren stellen Textdateien oft eine unsichtbare Markierung (BOM) voran
            s = !text.isEmpty() && text.charAt(0) == (char) 0xFEFF ? text.substring(1) : text;
        }

        IllegalArgumentException error(String message) {
            return new IllegalArgumentException(message + " an Stelle " + pos);
        }

        void skipSpace() {
            while (pos < s.length()) {
                char c = s.charAt(pos);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                    pos++;
                } else if (c == '/' && pos + 1 < s.length() && s.charAt(pos + 1) == '/') {
                    while (pos < s.length() && s.charAt(pos) != '\n') pos++;
                } else if (c == '/' && pos + 1 < s.length() && s.charAt(pos + 1) == '*') {
                    int end = s.indexOf("*/", pos + 2);
                    pos = end < 0 ? s.length() : end + 2;
                } else {
                    break;
                }
            }
        }

        Object value(int depth) {
            if (depth > MAX_DEPTH) throw error("Zu tief verschachtelt");
            if (pos >= s.length()) throw error("Unerwartetes Ende");
            char c = s.charAt(pos);
            if (c == '{') return object(depth);
            if (c == '[') return array(depth);
            if (c == '"') return string();
            if (s.startsWith("true", pos)) {
                pos += 4;
                return Boolean.TRUE;
            }
            if (s.startsWith("false", pos)) {
                pos += 5;
                return Boolean.FALSE;
            }
            if (s.startsWith("null", pos)) {
                pos += 4;
                return null;
            }
            return number();
        }

        Map<String, Object> object(int depth) {
            Map<String, Object> map = new LinkedHashMap<>();
            pos++;
            for (;;) {
                skipSpace();
                if (pos >= s.length()) throw error("Objekt nicht geschlossen");
                if (s.charAt(pos) == '}') {
                    pos++;
                    return map;
                }
                if (s.charAt(pos) != '"') throw error("Name in Anführungszeichen erwartet");
                String key = string();
                skipSpace();
                if (pos >= s.length() || s.charAt(pos) != ':') throw error("Doppelpunkt erwartet");
                pos++;
                skipSpace();
                map.put(key, value(depth + 1));
                skipSpace();
                if (pos < s.length() && s.charAt(pos) == ',') {
                    pos++;
                } else if (pos >= s.length() || s.charAt(pos) != '}') {
                    throw error("Komma oder } erwartet");
                }
            }
        }

        List<Object> array(int depth) {
            List<Object> list = new ArrayList<>();
            pos++;
            for (;;) {
                skipSpace();
                if (pos >= s.length()) throw error("Liste nicht geschlossen");
                if (s.charAt(pos) == ']') {
                    pos++;
                    return list;
                }
                list.add(value(depth + 1));
                skipSpace();
                if (pos < s.length() && s.charAt(pos) == ',') {
                    pos++;
                } else if (pos >= s.length() || s.charAt(pos) != ']') {
                    throw error("Komma oder ] erwartet");
                }
            }
        }

        String string() {
            StringBuilder sb = new StringBuilder();
            pos++;
            while (pos < s.length()) {
                char c = s.charAt(pos++);
                if (c == '"') return sb.toString();
                if (c != '\\') {
                    sb.append(c);
                    continue;
                }
                if (pos >= s.length()) break;
                char e = s.charAt(pos++);
                switch (e) {
                    case 'n':
                        sb.append('\n');
                        break;
                    case 't':
                        sb.append('\t');
                        break;
                    case 'r':
                        sb.append('\r');
                        break;
                    case 'b':
                        sb.append('\b');
                        break;
                    case 'f':
                        sb.append('\f');
                        break;
                    case 'u':
                        if (pos + 4 > s.length()) throw error("Unvollständiges \\u");
                        try {
                            sb.append((char) Integer.parseInt(s.substring(pos, pos + 4), 16));
                        } catch (NumberFormatException ex) {
                            throw error("Ungültiges \\u");
                        }
                        pos += 4;
                        break;
                    default:
                        sb.append(e);
                }
            }
            throw error("Text nicht geschlossen");
        }

        Object number() {
            int start = pos;
            boolean floating = false;
            while (pos < s.length()) {
                char c = s.charAt(pos);
                if (c == '.' || c == 'e' || c == 'E') floating = true;
                else if (!(c >= '0' && c <= '9') && c != '-' && c != '+') break;
                pos++;
            }
            String text = s.substring(start, pos);
            if (text.isEmpty()) throw error("Unerwartetes Zeichen");
            try {
                if (!floating) return Long.parseLong(text);
            } catch (NumberFormatException ignored) {
                // zu groß für Long: als Double lesen
            }
            try {
                return Double.parseDouble(text);
            } catch (NumberFormatException ex) {
                throw error("Ungültige Zahl");
            }
        }
    }

    // ------------------------------------------------------------ Schreiben

    public static String stringify(Object value) {
        StringBuilder sb = new StringBuilder();
        write(sb, value);
        return sb.toString();
    }

    private static void write(StringBuilder sb, Object value) {
        if (value == null) {
            sb.append("null");
        } else if (value instanceof String) {
            quote(sb, (String) value);
        } else if (value instanceof Boolean) {
            sb.append(value.toString());
        } else if (value instanceof Double || value instanceof Float) {
            double d = ((Number) value).doubleValue();
            if (Double.isNaN(d) || Double.isInfinite(d)) sb.append("null");
            else if (d == Math.rint(d) && Math.abs(d) < 1e15) sb.append((long) d);
            else sb.append(d);
        } else if (value instanceof Number) {
            sb.append(value.toString());
        } else if (value instanceof Map) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : ((Map<?, ?>) value).entrySet()) {
                if (!first) sb.append(',');
                first = false;
                quote(sb, String.valueOf(e.getKey()));
                sb.append(':');
                write(sb, e.getValue());
            }
            sb.append('}');
        } else if (value instanceof Iterable) {
            sb.append('[');
            boolean first = true;
            for (Object item : (Iterable<?>) value) {
                if (!first) sb.append(',');
                first = false;
                write(sb, item);
            }
            sb.append(']');
        } else {
            quote(sb, value.toString());
        }
    }

    private static void quote(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':
                    sb.append("\\\"");
                    break;
                case '\\':
                    sb.append("\\\\");
                    break;
                case '\n':
                    sb.append("\\n");
                    break;
                case '\r':
                    sb.append("\\r");
                    break;
                case '\t':
                    sb.append("\\t");
                    break;
                default:
                    if (c < 0x20 || c == 0x2028 || c == 0x2029) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        sb.append('"');
    }

    // ------------------------------------------------------------ Hilfen

    @SuppressWarnings("unchecked")
    public static Map<String, Object> asObject(Object value) {
        return value instanceof Map ? (Map<String, Object>) value : null;
    }

    public static Map<String, Object> object(Object... keysAndValues) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i + 1 < keysAndValues.length; i += 2) map.put((String) keysAndValues[i], keysAndValues[i + 1]);
        return map;
    }

    public static Object deepCopy(Object value) {
        if (value instanceof Map) {
            Map<String, Object> copy = new LinkedHashMap<>();
            for (Map.Entry<?, ?> e : ((Map<?, ?>) value).entrySet()) copy.put(String.valueOf(e.getKey()), deepCopy(e.getValue()));
            return copy;
        }
        if (value instanceof List) {
            List<Object> copy = new ArrayList<>();
            for (Object item : (List<?>) value) copy.add(deepCopy(item));
            return copy;
        }
        return value;
    }

    /** Tiefes Zusammenführen; Listen und einfache Werte werden ersetzt. Liefert eine neue Map. */
    @SafeVarargs
    public static Map<String, Object> deepMerge(Map<String, Object> base, Map<String, Object>... overrides) {
        Map<String, Object> out = base == null ? new LinkedHashMap<String, Object>() : asObject(deepCopy(base));
        for (Map<String, Object> over : overrides) {
            if (over == null) continue;
            for (Map.Entry<String, Object> e : over.entrySet()) {
                Object value = e.getValue();
                Map<String, Object> valueMap = asObject(value);
                if (valueMap != null) {
                    out.put(e.getKey(), deepMerge(asObject(out.get(e.getKey())), valueMap));
                } else {
                    out.put(e.getKey(), deepCopy(value));
                }
            }
        }
        return out;
    }

    public static String string(Map<String, Object> map, String key, String fallback) {
        Object v = map == null ? null : map.get(key);
        return v instanceof String ? (String) v : fallback;
    }

    public static long number(Map<String, Object> map, String key, long fallback) {
        Object v = map == null ? null : map.get(key);
        return v instanceof Number ? ((Number) v).longValue() : fallback;
    }
}
