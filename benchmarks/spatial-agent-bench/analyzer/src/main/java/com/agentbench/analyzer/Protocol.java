package com.agentbench.analyzer;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class Protocol {
    static final int MAX_JSON_DEPTH = 16;
    private static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;
    static final Comparator<String> CODE_POINT_ORDER = Protocol::compareCodePoints;

    private Protocol() {}

    static Object readFrame(InputStream input, int maximumBytes) throws IOException {
        byte[] header = input.readNBytes(8);
        if (header.length != 8) throw new IllegalArgumentException("partial frame header");
        long declared = ByteBuffer.wrap(header).getLong();
        if (declared < 0 || declared > maximumBytes) throw new IllegalArgumentException("frame length exceeds bound");
        byte[] json = input.readNBytes((int) declared);
        if (json.length != declared) throw new IllegalArgumentException("partial frame payload");
        if (input.read() != -1) throw new IllegalArgumentException("trailing frame bytes");
        return parseCanonical(json);
    }

    static void writeFrame(OutputStream output, Object value, int maximumBytes) throws IOException {
        byte[] json = canonicalBytes(value);
        if (json.length > maximumBytes) throw new IllegalArgumentException("response frame exceeds bound");
        output.write(ByteBuffer.allocate(8).putLong(json.length).array());
        output.write(json);
        output.flush();
    }

    static Object parseCanonical(byte[] bytes) {
        final String source;
        try {
            source = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException error) {
            throw new IllegalArgumentException("JSON is not valid UTF-8", error);
        }
        Parser parser = new Parser(source);
        Object value = parser.parseValue(0);
        if (!parser.atEnd()) throw new IllegalArgumentException("trailing JSON text");
        if (!source.equals(canonicalJson(value))) throw new IllegalArgumentException("JSON is not canonical");
        return value;
    }

    static byte[] canonicalBytes(Object value) {
        return canonicalJson(value).getBytes(StandardCharsets.UTF_8);
    }

    static String canonicalJson(Object value) {
        StringBuilder output = new StringBuilder();
        appendCanonical(output, value, 0);
        return output.toString();
    }

    static String sha256(byte[] bytes) {
        try {
            return java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    static int compareUtf8(String left, String right) {
        byte[] a = left.getBytes(StandardCharsets.UTF_8);
        byte[] b = right.getBytes(StandardCharsets.UTF_8);
        for (int index = 0; index < Math.min(a.length, b.length); index++) {
            int order = Integer.compare(Byte.toUnsignedInt(a[index]), Byte.toUnsignedInt(b[index]));
            if (order != 0) return order;
        }
        return Integer.compare(a.length, b.length);
    }

    private static int compareCodePoints(String left, String right) {
        int a = 0;
        int b = 0;
        while (a < left.length() && b < right.length()) {
            int leftPoint = left.codePointAt(a);
            int rightPoint = right.codePointAt(b);
            if (leftPoint != rightPoint) return Integer.compare(leftPoint, rightPoint);
            a += Character.charCount(leftPoint);
            b += Character.charCount(rightPoint);
        }
        return Integer.compare(left.length() - a, right.length() - b);
    }

    private static void appendCanonical(StringBuilder output, Object value, int depth) {
        if (depth > MAX_JSON_DEPTH) throw new IllegalArgumentException("JSON depth exceeds bound");
        if (value == null) output.append("null");
        else if (value instanceof Boolean bool) output.append(bool ? "true" : "false");
        else if (value instanceof Byte || value instanceof Short || value instanceof Integer || value instanceof Long) {
            long number = ((Number) value).longValue();
            if (number < -MAX_SAFE_INTEGER || number > MAX_SAFE_INTEGER) throw new IllegalArgumentException("integer exceeds safe range");
            output.append(number);
        } else if (value instanceof String string) appendString(output, string);
        else if (value instanceof List<?> list) {
            output.append('[');
            for (int index = 0; index < list.size(); index++) {
                if (index > 0) output.append(',');
                appendCanonical(output, list.get(index), depth + 1);
            }
            output.append(']');
        } else if (value instanceof Map<?, ?> map) {
            List<String> keys = new ArrayList<>();
            for (Object key : map.keySet()) {
                if (!(key instanceof String string)) throw new IllegalArgumentException("object key is not a string");
                keys.add(string);
            }
            keys.sort(CODE_POINT_ORDER);
            output.append('{');
            for (int index = 0; index < keys.size(); index++) {
                if (index > 0) output.append(',');
                String key = keys.get(index);
                appendString(output, key);
                output.append(':');
                appendCanonical(output, map.get(key), depth + 1);
            }
            output.append('}');
        } else throw new IllegalArgumentException("unsupported canonical JSON value");
    }

    private static void appendString(StringBuilder output, String value) {
        output.append('"');
        for (int index = 0; index < value.length();) {
            int point = value.codePointAt(index);
            if (Character.isSurrogate(value.charAt(index)) && Character.charCount(point) == 1) {
                throw new IllegalArgumentException("string contains a lone surrogate");
            }
            index += Character.charCount(point);
            switch (point) {
                case '"' -> output.append("\\\"");
                case '\\' -> output.append("\\\\");
                case '\b' -> output.append("\\b");
                case '\f' -> output.append("\\f");
                case '\n' -> output.append("\\n");
                case '\r' -> output.append("\\r");
                case '\t' -> output.append("\\t");
                default -> {
                    if (point < 0x20) output.append(String.format("\\u%04x", point));
                    else output.appendCodePoint(point);
                }
            }
        }
        output.append('"');
    }

    private static final class Parser {
        private final String source;
        private int index;

        Parser(String source) { this.source = source; }
        boolean atEnd() { return index == source.length(); }

        Object parseValue(int depth) {
            if (depth > MAX_JSON_DEPTH || atEnd()) throw new IllegalArgumentException("invalid JSON value");
            return switch (source.charAt(index)) {
                case 'n' -> literal("null", null);
                case 't' -> literal("true", true);
                case 'f' -> literal("false", false);
                case '"' -> parseString();
                case '[' -> parseArray(depth);
                case '{' -> parseObject(depth);
                default -> parseInteger();
            };
        }

        private Object literal(String text, Object value) {
            if (!source.startsWith(text, index)) throw new IllegalArgumentException("invalid JSON literal");
            index += text.length();
            return value;
        }

        private List<Object> parseArray(int depth) {
            index++;
            List<Object> values = new ArrayList<>();
            if (take(']')) return values;
            while (true) {
                values.add(parseValue(depth + 1));
                if (take(']')) return values;
                require(',');
            }
        }

        private Map<String, Object> parseObject(int depth) {
            index++;
            Map<String, Object> values = new LinkedHashMap<>();
            String previous = null;
            if (take('}')) return values;
            while (true) {
                if (atEnd() || source.charAt(index) != '"') throw new IllegalArgumentException("object key is not a string");
                String key = parseString();
                if (previous != null && CODE_POINT_ORDER.compare(previous, key) >= 0) {
                    throw new IllegalArgumentException("duplicate or out-of-order object key");
                }
                previous = key;
                require(':');
                values.put(key, parseValue(depth + 1));
                if (take('}')) return values;
                require(',');
            }
        }

        private Long parseInteger() {
            int start = index;
            boolean negative = take('-');
            if (atEnd() || !Character.isDigit(source.charAt(index))) throw new IllegalArgumentException("invalid integer");
            if (source.charAt(index) == '0') {
                index++;
                if (negative || (!atEnd() && Character.isDigit(source.charAt(index)))) throw new IllegalArgumentException("non-canonical integer");
            } else {
                while (!atEnd() && Character.isDigit(source.charAt(index))) index++;
            }
            try {
                long value = Long.parseLong(source.substring(start, index));
                if (value < -MAX_SAFE_INTEGER || value > MAX_SAFE_INTEGER) throw new IllegalArgumentException("integer exceeds safe range");
                return value;
            } catch (NumberFormatException error) {
                throw new IllegalArgumentException("invalid integer", error);
            }
        }

        private String parseString() {
            require('"');
            StringBuilder value = new StringBuilder();
            while (!atEnd()) {
                char character = source.charAt(index++);
                if (character == '"') return checkedString(value.toString());
                if (character < 0x20) throw new IllegalArgumentException("unescaped string control character");
                if (character != '\\') value.append(character);
                else {
                    if (atEnd()) throw new IllegalArgumentException("partial string escape");
                    char escaped = source.charAt(index++);
                    switch (escaped) {
                        case '"', '\\', '/' -> value.append(escaped);
                        case 'b' -> value.append('\b');
                        case 'f' -> value.append('\f');
                        case 'n' -> value.append('\n');
                        case 'r' -> value.append('\r');
                        case 't' -> value.append('\t');
                        case 'u' -> value.append((char) parseHex4());
                        default -> throw new IllegalArgumentException("invalid string escape");
                    }
                }
            }
            throw new IllegalArgumentException("unterminated string");
        }

        private String checkedString(String value) {
            for (int offset = 0; offset < value.length(); offset++) {
                char character = value.charAt(offset);
                if (Character.isHighSurrogate(character)) {
                    if (++offset >= value.length() || !Character.isLowSurrogate(value.charAt(offset))) throw new IllegalArgumentException("lone surrogate");
                } else if (Character.isLowSurrogate(character)) throw new IllegalArgumentException("lone surrogate");
            }
            return value;
        }

        private int parseHex4() {
            if (index + 4 > source.length()) throw new IllegalArgumentException("partial unicode escape");
            int value = 0;
            for (int count = 0; count < 4; count++) {
                int digit = Character.digit(source.charAt(index++), 16);
                if (digit < 0) throw new IllegalArgumentException("invalid unicode escape");
                value = value * 16 + digit;
            }
            return value;
        }

        private boolean take(char expected) {
            if (!atEnd() && source.charAt(index) == expected) { index++; return true; }
            return false;
        }

        private void require(char expected) {
            if (!take(expected)) throw new IllegalArgumentException("expected '" + expected + "'");
        }
    }
}
