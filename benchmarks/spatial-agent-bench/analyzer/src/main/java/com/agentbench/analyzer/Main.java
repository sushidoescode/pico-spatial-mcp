package com.agentbench.analyzer;

import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

public final class Main {
    static final int PROTOCOL_VERSION = 1;
    static final int SUBSET_VERSION = 1;
    static final int MAX_KOTLIN_FILES = 512;
    static final int MAX_KOTLIN_FILE_BYTES = 1_048_576;
    static final int MAX_KOTLIN_TOTAL_BYTES = 8_388_608;
    static final int MAX_REQUEST_JSON_BYTES = 52_428_800;
    static final int MAX_RESPONSE_JSON_BYTES = 4_194_304;
    static final int MAX_STDERR_BYTES = 4_194_304;
    static final int MAX_PATH_UTF8_BYTES = 4_096;
    static final int MAX_PSI_NODES = 500_000;
    static final int MAX_DECLARATIONS = 25_000;
    static final int MAX_CALL_SITES = 100_000;
    static final int MAX_RESPONSE_NODES = 256;
    static final int MAX_CLAIMS = 16;
    static final int MAX_WITNESSES_PER_CLAIM = 32;
    static final int MAX_TOTAL_WITNESSES = 256;
    private static final Pattern HASH = Pattern.compile("[a-f0-9]{64}");
    private static final Set<String> REQUEST_KEYS = Set.of(
        "protocolVersion", "subsetVersion", "command", "kotlinInputSetSha256", "files");
    private static final Set<String> FILE_KEYS = Set.of("path", "bytes", "sha256", "contentBase64");

    private Main() {}

    public static void main(String[] args) {
        try {
            if (args.length != 1 || !"analyze".equals(args[0])) throw new IllegalArgumentException("invalid analyzer launch mode");
            Object request = Protocol.readFrame(System.in, MAX_REQUEST_JSON_BYTES);
            Protocol.writeFrame(System.out, handle(request), MAX_RESPONSE_JSON_BYTES);
        } catch (Throwable error) {
            System.err.println("analyzer protocol rejected: " + safeMessage(error));
            System.exit(1);
        }
    }

    private static Map<String, Object> handle(Object value) {
        Map<String, Object> request = object(value, "request", REQUEST_KEYS);
        requireInteger(request.get("protocolVersion"), PROTOCOL_VERSION, "protocolVersion");
        requireInteger(request.get("subsetVersion"), SUBSET_VERSION, "subsetVersion");
        String command = string(request.get("command"), "command");
        if (!command.equals("analyze") && !command.equals("describe")) throw new IllegalArgumentException("unknown command");
        String requestDigest = hash(request.get("kotlinInputSetSha256"), "kotlinInputSetSha256");
        List<Object> rawFiles = array(request.get("files"), "files");
        List<Map<String, Object>> receipts = new ArrayList<>();
        List<PsiIndex.Source> sources = new ArrayList<>();
        List<Map<String, Object>> manifest = new ArrayList<>();
        String previousPath = null;
        long totalBytes = 0;
        boolean limit = rawFiles.size() > MAX_KOTLIN_FILES;
        boolean unsupported = false;

        for (int index = 0; index < rawFiles.size(); index++) {
            Map<String, Object> file = object(rawFiles.get(index), "files[" + index + "]", FILE_KEYS);
            String path = validatePath(string(file.get("path"), "file path"));
            if (previousPath != null && Protocol.compareUtf8(previousPath, path) >= 0) {
                throw new IllegalArgumentException("files are duplicated or out of order");
            }
            previousPath = path;
            long bytes = integer(file.get("bytes"), "file bytes");
            String sha256 = hash(file.get("sha256"), "file sha256");
            String encoded = string(file.get("contentBase64"), "file contentBase64");
            byte[] content;
            try { content = Base64.getDecoder().decode(encoded); }
            catch (IllegalArgumentException error) { throw new IllegalArgumentException("file base64 is invalid", error); }
            if (!Base64.getEncoder().encodeToString(content).equals(encoded)) throw new IllegalArgumentException("file base64 is not canonical");
            if (bytes != content.length || !sha256.equals(Protocol.sha256(content))) throw new IllegalArgumentException("file receipt mismatch");
            String text = decodeUtf8(content);
            totalBytes = Math.addExact(totalBytes, bytes);
            if (bytes > MAX_KOTLIN_FILE_BYTES || totalBytes > MAX_KOTLIN_TOTAL_BYTES) limit = true;
            if (!path.endsWith(".kt")) unsupported = true;
            receipts.add(row("path", path, "bytes", bytes, "sha256", sha256));
            manifest.add(row("path", path, "bytes", bytes, "sha256", sha256));
            sources.add(new PsiIndex.Source(path, sha256, text));
        }

        String computedDigest = Protocol.sha256(Protocol.canonicalBytes(manifest));
        if (!computedDigest.equals(requestDigest)) throw new IllegalArgumentException("Kotlin input-set digest mismatch");
        if (command.equals("describe")) {
            if (!rawFiles.isEmpty() || !requestDigest.equals(Protocol.sha256(Protocol.canonicalBytes(List.of())))) {
                throw new IllegalArgumentException("describe requires the empty input set");
            }
            return response(command, "accepted", null, requestDigest, receipts, constants(), List.of(), List.of());
        }
        if (limit) return response(command, "rejected", "limit", requestDigest, receipts, null, List.of(), List.of());
        if (unsupported) return response(command, "rejected", "unsupported_script", requestDigest, receipts, null, List.of(), List.of());
        PsiIndex.Result result = PsiIndex.analyze(sources);
        return response(command, result.rejectionCode() == null ? "accepted" : "rejected",
            result.rejectionCode(), requestDigest, receipts, null, result.nodes(), result.claims());
    }

    private static Map<String, Object> response(String command, String status, String rejection,
            String digest, List<Map<String, Object>> files, Map<String, Object> constants,
            List<Map<String, Object>> nodes, List<Map<String, Object>> claims) {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("protocolVersion", (long) PROTOCOL_VERSION);
        response.put("subsetVersion", (long) SUBSET_VERSION);
        response.put("command", command);
        response.put("analysisStatus", status);
        response.put("rejectionCode", rejection);
        response.put("kotlinInputSetSha256", digest);
        response.put("files", files);
        response.put("constants", constants);
        response.put("nodes", nodes);
        response.put("claims", claims);
        return response;
    }

    private static Map<String, Object> constants() {
        Map<String, Object> values = new LinkedHashMap<>();
        values.put("ANALYZER_PROTOCOL_VERSION", 1L);
        values.put("ANALYZER_SUBSET_VERSION", 1L);
        values.put("MAX_KOTLIN_FILES", 512L);
        values.put("MAX_KOTLIN_FILE_BYTES", 1_048_576L);
        values.put("MAX_KOTLIN_TOTAL_BYTES", 8_388_608L);
        values.put("MAX_REQUEST_JSON_BYTES", 52_428_800L);
        values.put("MAX_RESPONSE_JSON_BYTES", 4_194_304L);
        values.put("MAX_STDERR_BYTES", 4_194_304L);
        values.put("MAX_PATH_UTF8_BYTES", 4_096L);
        values.put("MAX_JSON_DEPTH", 16L);
        values.put("MAX_PSI_NODES", 500_000L);
        values.put("MAX_DECLARATIONS", 25_000L);
        values.put("MAX_CALL_SITES", 100_000L);
        values.put("MAX_CFG_BLOCKS_PER_CALLABLE", 4_096L);
        values.put("MAX_CALL_DEPTH", 8L);
        values.put("MAX_FIXPOINT_ITERATIONS", 32L);
        values.put("MAX_RESPONSE_NODES", (long) MAX_RESPONSE_NODES);
        values.put("MAX_CLAIMS", (long) MAX_CLAIMS);
        values.put("MAX_WITNESSES_PER_CLAIM", (long) MAX_WITNESSES_PER_CLAIM);
        values.put("MAX_TOTAL_WITNESSES", (long) MAX_TOTAL_WITNESSES);
        values.put("CACHE_MAX_ENTRIES", 32L);
        values.put("CACHE_MAX_ENCODED_BYTES", 16_777_216L);
        values.put("ANALYZER_TIMEOUT_MS", 30_000L);
        return values;
    }

    private static String decodeUtf8(byte[] bytes) {
        try {
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException error) {
            throw new IllegalArgumentException("file content is not valid UTF-8", error);
        }
    }

    private static String validatePath(String path) {
        if (path.isEmpty() || path.getBytes(StandardCharsets.UTF_8).length > MAX_PATH_UTF8_BYTES || path.indexOf('\0') >= 0
                || path.startsWith("/") || path.contains("\\")) throw new IllegalArgumentException("invalid repository-relative path");
        for (String segment : path.split("/", -1)) {
            if (segment.isEmpty() || segment.equals(".") || segment.equals("..")) throw new IllegalArgumentException("invalid path segment");
        }
        return path;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> object(Object value, String label, Set<String> keys) {
        if (!(value instanceof Map<?, ?> raw)) throw new IllegalArgumentException(label + " must be an object");
        Map<String, Object> result = (Map<String, Object>) raw;
        if (!result.keySet().equals(keys)) throw new IllegalArgumentException(label + " has unknown or missing keys");
        return result;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> array(Object value, String label) {
        if (!(value instanceof List<?>)) throw new IllegalArgumentException(label + " must be an array");
        return (List<Object>) value;
    }

    private static String string(Object value, String label) {
        if (!(value instanceof String string)) throw new IllegalArgumentException(label + " must be a string");
        return string;
    }

    private static String hash(Object value, String label) {
        String hash = string(value, label);
        if (!HASH.matcher(hash).matches()) throw new IllegalArgumentException(label + " must be a lowercase SHA-256");
        return hash;
    }

    private static long integer(Object value, String label) {
        if (!(value instanceof Long number) || number < 0) throw new IllegalArgumentException(label + " must be a nonnegative safe integer");
        return number;
    }

    private static void requireInteger(Object value, long expected, String label) {
        if (integer(value, label) != expected) throw new IllegalArgumentException(label + " mismatch");
    }

    private static Map<String, Object> row(String key1, Object value1, String key2, Object value2, String key3, Object value3) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put(key1, value1); row.put(key2, value2); row.put(key3, value3);
        return row;
    }

    private static String safeMessage(Throwable error) {
        String message = error.getMessage();
        if (message == null || message.isBlank()) return error.getClass().getSimpleName();
        return message.replace('\n', ' ').replace('\r', ' ').substring(0, Math.min(message.length(), 500));
    }
}
