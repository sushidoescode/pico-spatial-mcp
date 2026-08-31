#!/usr/bin/env python3
"""Descriptor-safe filesystem primitive for audited run-receipt portability.

The TypeScript caller owns schemas and semantic identities.  This helper owns only the POSIX
operations that Node does not expose safely enough on every supported runtime: descriptor-relative
no-follow traversal, stable snapshots, create-only hard-link publication, and final rehashing.
"""

import base64
import binascii
import hashlib
import json
import os
import re
import resource
import secrets
import stat
import sys
import zlib


PROTOCOL = "pico.receipt-portability-helper"
VERSION = 1
MAX_REQUEST_BYTES = 5 * 1024 * 1024
MAX_RECEIPT_BYTES = 2 * 1024 * 1024
MAX_SPEC_BYTES = 2 * 1024 * 1024
MAX_MANIFEST_BYTES = 64 * 1024
MAX_CAPTURE_BYTES = 64 * 1024 * 1024
MAX_APK_BYTES = 2 * 1024 * 1024 * 1024
MAX_DECODED_BYTES = 256 * 1024 * 1024
MAX_ROOT_COMPONENTS = 64
MAX_RETAINED_DESCENDANTS = 16
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
SHA256 = re.compile(r"^[a-f0-9]{64}$")
APP = re.compile(r"^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$")
DECIMAL = re.compile(r"^(?:0|[1-9][0-9]*)$")
TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
TOOL_VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$")


class PortabilityError(Exception):
    pass


class UnsupportedPortabilityError(PortabilityError):
    pass


def fail(message):
    raise PortabilityError(message)


def unavailable(message):
    raise UnsupportedPortabilityError(message)


def exact_keys(value, expected, label):
    if not isinstance(value, dict) or set(value) != set(expected):
        fail("%s must contain exactly keys %s" % (label, ", ".join(sorted(expected))))


def strict_pairs(label):
    def hook(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                fail("%s contains duplicate JSON key %r" % (label, key))
            result[key] = value
        return result
    return hook


def parse_json_bytes(raw, maximum, label, canonical=False):
    if len(raw) > maximum:
        fail("%s exceeds the %d-byte limit" % (label, maximum))
    if canonical and (not raw.endswith(b"\n") or len(raw) < 2 or raw[-2:] == b"\n\n"):
        fail("%s does not use the required single trailing newline convention" % label)
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        fail("%s is not UTF-8" % label)
    try:
        value = json.loads(text, object_pairs_hook=strict_pairs(label))
    except PortabilityError:
        raise
    except Exception as error:
        fail("%s is not valid JSON: %s" % (label, error))
    return value


def decode_base64(value, maximum, label):
    if not isinstance(value, str) or len(value) > ((maximum + 2) // 3) * 4:
        fail("%s is not bounded base64" % label)
    try:
        raw = base64.b64decode(value.encode("ascii"), validate=True)
    except (UnicodeEncodeError, binascii.Error):
        fail("%s is not canonical base64" % label)
    if len(raw) > maximum or base64.b64encode(raw).decode("ascii") != value:
        fail("%s is not canonical bounded base64" % label)
    return raw


def encode_base64(raw):
    return base64.b64encode(raw).decode("ascii")


def valid_sha(value, label):
    if not isinstance(value, str) or not SHA256.fullmatch(value):
        fail("%s must be a lowercase SHA-256" % label)
    return value


def valid_nonnegative_int(value, label, maximum=None, positive=False):
    if isinstance(value, bool) or not isinstance(value, int) or value < (1 if positive else 0):
        fail("%s must be a %s integer" % (label, "positive" if positive else "nonnegative"))
    if maximum is not None and value > maximum:
        fail("%s exceeds its bound" % label)
    return value


def validate_root_locator(value, label):
    if not isinstance(value, str) or value == "/" or not value.startswith("/") or "\x00" in value:
        fail("%s must be an absolute non-root POSIX path" % label)
    components = value.split("/")[1:]
    if not components or len(components) > MAX_ROOT_COMPONENTS or any(
            component in ("", ".", "..") or "\\" in component for component in components):
        fail("%s is not a canonical resolved POSIX path" % label)
    if os.path.normpath(value) != value:
        fail("%s must be a canonical POSIX path" % label)
    return components


def validate_root_path(value, label):
    components = validate_root_locator(value, label)
    if os.path.realpath(value) != value:
        fail("%s must already be resolved and contain no symlink component" % label)
    return components


def stat_identity(st):
    return (st.st_dev, st.st_ino, st.st_mode, st.st_size, st.st_mtime_ns, st.st_ctime_ns)


def final_content_identity(st):
    # A create-only publisher first adds the final hard link and then removes its temporary name.
    # That required unlink changes ctime/link-count on the same immutable inode.  Final readers bind
    # dev/inode/type/size/mtime plus rehashed bytes; source snapshots retain the stricter ctime check.
    return (st.st_dev, st.st_ino, st.st_mode, st.st_size, st.st_mtime_ns)


def directory_identity(st):
    return (st.st_dev, st.st_ino, st.st_mode)


def root_identity(path, st):
    return {"realPath": path, "deviceId": str(st.st_dev), "inode": str(st.st_ino)}


def validate_identity(value, label):
    exact_keys(value, ["realPath", "deviceId", "inode"], label)
    components = validate_root_path(value["realPath"], label + ".realPath")
    if not isinstance(value["deviceId"], str) or not DECIMAL.fullmatch(value["deviceId"]):
        fail(label + ".deviceId is not canonical unsigned decimal")
    if not isinstance(value["inode"], str) or not DECIMAL.fullmatch(value["inode"]):
        fail(label + ".inode is not canonical unsigned decimal")
    return components


class StoreRoot:
    def __init__(self, label, expected):
        self.label = label
        self.expected = expected
        self.path = expected["realPath"]
        components = validate_identity(expected, label)
        self.descriptors = []
        self.cache = {}
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        try:
            current = os.open("/", flags)
            self._retain(current, "/")
            for index, component in enumerate(components):
                parent = current
                current = os.open(component, flags, dir_fd=parent)
                self._retain(current, "/" + "/".join(components[:index + 1]), parent, component)
        except Exception as error:
            self.close()
            fail("%s could not be opened component-by-component without following links: %s" % (label, error))
        self.fd = current
        final = os.fstat(self.fd)
        if not stat.S_ISDIR(final.st_mode):
            self.close()
            fail(label + " is not a directory")
        actual = root_identity(self.path, final)
        if actual != expected:
            self.close()
            fail("%s identity changed before use" % label)
        self.chain_ids = [(snapshot[0], snapshot[1]) for _, snapshot, _, _, _ in self.descriptors]
        self.cache[()] = self.fd

    def _retain(self, fd, display, parent=None, name=None):
        snapshot = directory_identity(os.fstat(fd))
        if not stat.S_ISDIR(snapshot[2]):
            os.close(fd)
            fail("%s component %s is not a directory" % (self.label, display))
        if parent is not None:
            try:
                entry = directory_identity(os.stat(name, dir_fd=parent, follow_symlinks=False))
            except OSError:
                os.close(fd)
                raise
            if entry != snapshot:
                os.close(fd)
                fail("%s component %s was substituted while being opened" % (self.label, display))
        self.descriptors.append((fd, snapshot, display, parent, name))

    def open_dir(self, parts, create=False):
        prefix = ()
        current = self.fd
        for component in parts:
            if not isinstance(component, str) or component in ("", ".", "..") or "/" in component or "\x00" in component:
                fail("unsafe %s descendant component" % self.label)
            prefix = prefix + (component,)
            cached = self.cache.get(prefix)
            if cached is not None:
                current = cached
                continue
            if len(self.cache) > MAX_RETAINED_DESCENDANTS:
                fail("%s descendant descriptor budget exceeded" % self.label)
            flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
            try:
                child = os.open(component, flags, dir_fd=current)
            except FileNotFoundError:
                if not create:
                    raise
                try:
                    os.mkdir(component, mode=0o700, dir_fd=current)
                    os.fsync(current)
                except FileExistsError:
                    pass
                child = os.open(component, flags, dir_fd=current)
            except OSError as error:
                fail("%s descendant %s could not be opened without following links: %s" %
                     (self.label, "/".join(prefix), error))
            self._retain(child, self.path + "/" + "/".join(prefix), current, component)
            self.cache[prefix] = child
            current = child
        return current

    def verify(self):
        for fd, before, display, parent, name in self.descriptors:
            try:
                after = directory_identity(os.fstat(fd))
                entry = after if parent is None else directory_identity(
                    os.stat(name, dir_fd=parent, follow_symlinks=False))
            except OSError as error:
                fail("retained directory %s could not be rechecked: %s" % (display, error))
            if after != before or entry != before:
                fail("retained directory %s changed during the operation" % display)

    def close(self):
        for fd, _, _, _, _ in reversed(getattr(self, "descriptors", [])):
            try:
                os.close(fd)
            except OSError:
                pass
        self.descriptors = []


class Snapshot:
    def __init__(self, store, parts, maximum, label, positive=False, retain_bytes=True, final=False):
        self.label = label
        self.fd = None
        parent = store.open_dir(parts[:-1], create=False)
        try:
            self.fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
        except Exception as error:
            fail("%s could not be opened as a no-follow source file: %s" % (label, error))
        self.identity = final_content_identity if final else stat_identity
        try:
            before = self.identity(os.fstat(self.fd))
            if not stat.S_ISREG(before[2]):
                fail(label + " is not a regular file")
            if before[3] > maximum or (positive and before[3] <= 0):
                fail("%s has an invalid byte length %d" % (label, before[3]))
            self.before = before
            self.parent = parent
            self.name = parts[-1]
            entry = self.identity(os.stat(self.name, dir_fd=self.parent, follow_symlinks=False))
            if entry != self.before:
                fail(label + " was substituted while being opened")
            self.size = before[3]
            self.sha256, self.bytes = self._read(retain_bytes)
            self.verify()
        except Exception:
            self.close()
            raise

    def _read(self, retain_bytes):
        os.lseek(self.fd, 0, os.SEEK_SET)
        digest = hashlib.sha256()
        chunks = [] if retain_bytes else None
        total = 0
        while True:
            chunk = os.read(self.fd, 1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > self.size:
                fail(self.label + " grew while being read")
            digest.update(chunk)
            if chunks is not None:
                chunks.append(chunk)
        if total != self.size:
            fail(self.label + " changed or was truncated while being read")
        return digest.hexdigest(), b"".join(chunks) if chunks is not None else None

    def verify(self):
        try:
            descriptor = self.identity(os.fstat(self.fd))
            entry = self.identity(os.stat(self.name, dir_fd=self.parent, follow_symlinks=False))
        except OSError as error:
            fail("%s could not be rechecked: %s" % (self.label, error))
        if descriptor != self.before or entry != self.before:
            fail(self.label + " changed while snapshotted")

    def close(self):
        if self.fd is not None:
            try:
                os.close(self.fd)
            except OSError:
                pass
            self.fd = None


def read_final(store, parts, maximum, label, positive=False, retain_bytes=True):
    snapshot = Snapshot(store, parts, maximum, label, positive=positive, retain_bytes=retain_bytes, final=True)
    try:
        return snapshot.sha256, snapshot.size, snapshot.bytes
    finally:
        snapshot.close()


def write_all(fd, raw):
    offset = 0
    while offset < len(raw):
        written = os.write(fd, raw[offset:])
        if written <= 0:
            fail("temporary publication write made no progress")
        offset += written


def publish_bytes(store, parts, raw, label, existing_validator=None):
    parent = store.open_dir(parts[:-1], create=True)
    final_name = parts[-1]
    temp_name = ".%s.tmp-%d-%s" % (final_name, os.getpid(), secrets.token_hex(12))
    temp_fd = None
    temp_created = False
    try:
        temp_fd = os.open(temp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                          0o600, dir_fd=parent)
        temp_created = True
        write_all(temp_fd, raw)
        os.fsync(temp_fd)
        os.close(temp_fd)
        temp_fd = None
        try:
            os.link(temp_name, final_name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
            os.fsync(parent)
        except FileExistsError:
            _, _, existing = read_final(store, parts, max(len(raw), MAX_MANIFEST_BYTES), label, retain_bytes=True)
            if existing_validator is not None:
                existing_validator(existing, raw)
            elif existing != raw:
                fail("existing final %s is corrupt or mismatched" % label)
    finally:
        if temp_fd is not None:
            try:
                os.close(temp_fd)
            except OSError:
                pass
        if temp_created:
            try:
                os.unlink(temp_name, dir_fd=parent)
                os.fsync(parent)
            except FileNotFoundError:
                pass
            except OSError as error:
                fail("temporary name for %s could not be cleaned: %s" % (label, error))


def publish_stream(store, parts, source, expected_sha, expected_size, label):
    parent = store.open_dir(parts[:-1], create=True)
    final_name = parts[-1]
    temp_name = ".%s.tmp-%d-%s" % (final_name, os.getpid(), secrets.token_hex(12))
    temp_fd = None
    temp_created = False
    try:
        temp_fd = os.open(temp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                          0o600, dir_fd=parent)
        temp_created = True
        os.lseek(source.fd, 0, os.SEEK_SET)
        digest = hashlib.sha256()
        total = 0
        while True:
            chunk = os.read(source.fd, 1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > expected_size:
                fail(label + " source grew during publication")
            digest.update(chunk)
            write_all(temp_fd, chunk)
        if total != expected_size or digest.hexdigest() != expected_sha:
            fail(label + " source changed during publication")
        source.verify()
        os.fsync(temp_fd)
        os.close(temp_fd)
        temp_fd = None
        try:
            os.link(temp_name, final_name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
            os.fsync(parent)
        except FileExistsError:
            sha, size, _ = read_final(store, parts, MAX_APK_BYTES, label, positive=True, retain_bytes=False)
            if sha != expected_sha or size != expected_size:
                fail("existing final %s is corrupt or mismatched" % label)
    finally:
        if temp_fd is not None:
            try:
                os.close(temp_fd)
            except OSError:
                pass
        if temp_created:
            try:
                os.unlink(temp_name, dir_fd=parent)
                os.fsync(parent)
            except FileNotFoundError:
                pass
            except OSError as error:
                fail("temporary name for %s could not be cleaned: %s" % (label, error))


def png_expected_bytes(width, height, bits_per_pixel, interlace):
    passes = [(0, 0, 1, 1)] if interlace == 0 else [
        (0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4),
        (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2),
    ]
    total = 0
    row_starts = []
    for start_x, start_y, step_x, step_y in passes:
        if width <= start_x or height <= start_y:
            continue
        pass_width = (width - start_x + step_x - 1) // step_x
        pass_height = (height - start_y + step_y - 1) // step_y
        row_bytes = (pass_width * bits_per_pixel + 7) // 8
        for _ in range(pass_height):
            row_starts.append(total)
            total += 1 + row_bytes
            if total > MAX_DECODED_BYTES:
                fail("PNG decoded raster exceeds the bounded evidence limit")
    return total, row_starts


def inspect_png(raw, label):
    if len(raw) < 67 or len(raw) > MAX_CAPTURE_BYTES or raw[:8] != PNG_SIGNATURE:
        fail(label + " is not a bounded PNG capture")
    offset = 8
    width = height = bits_per_pixel = interlace = 0
    color_type = -1
    saw_ihdr = saw_plte = saw_idat = left_idat = saw_iend = False
    idat = []
    while offset < len(raw):
        if len(raw) - offset < 12:
            fail(label + " has a truncated PNG chunk header")
        length = int.from_bytes(raw[offset:offset + 4], "big")
        data_start = offset + 8
        data_end = data_start + length
        chunk_end = data_end + 4
        if chunk_end > len(raw):
            fail(label + " has truncated PNG chunk data")
        type_bytes = raw[offset + 4:offset + 8]
        try:
            chunk_type = type_bytes.decode("ascii")
        except UnicodeDecodeError:
            fail(label + " has an invalid PNG chunk type")
        if not re.fullmatch(r"[A-Za-z]{4}", chunk_type):
            fail(label + " has an invalid PNG chunk type")
        expected_crc = int.from_bytes(raw[data_end:chunk_end], "big")
        if (zlib.crc32(raw[offset + 4:data_end]) & 0xffffffff) != expected_crc:
            fail("%s %s PNG chunk CRC mismatch" % (label, chunk_type))
        data = raw[data_start:data_end]
        if not saw_ihdr and chunk_type != "IHDR":
            fail(label + " PNG IHDR is not first")
        if chunk_type == "IHDR":
            if saw_ihdr or length != 13:
                fail(label + " has invalid or duplicate PNG IHDR")
            saw_ihdr = True
            width = int.from_bytes(data[0:4], "big")
            height = int.from_bytes(data[4:8], "big")
            bit_depth = data[8]
            color_type = data[9]
            channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}
            depths = {0: (1, 2, 4, 8, 16), 2: (8, 16), 3: (1, 2, 4, 8), 4: (8, 16), 6: (8, 16)}
            if not width or not height or width > 16384 or height > 16384:
                fail(label + " has invalid PNG dimensions")
            if bit_depth not in depths.get(color_type, ()):
                fail(label + " has invalid PNG bit depth/color type")
            if data[10] != 0 or data[11] != 0 or data[12] not in (0, 1):
                fail(label + " has unsupported PNG methods")
            interlace = data[12]
            bits_per_pixel = channels[color_type] * bit_depth
        elif chunk_type == "PLTE":
            if saw_idat or saw_plte or length == 0 or length % 3 != 0 or length > 768:
                fail(label + " has invalid PNG PLTE")
            saw_plte = True
        elif chunk_type == "IDAT":
            if left_idat or (color_type == 3 and not saw_plte):
                fail(label + " has invalid PNG IDAT ordering")
            saw_idat = True
            idat.append(data)
        elif chunk_type == "IEND":
            if not saw_idat or saw_iend or length != 0:
                fail(label + " has invalid PNG IEND")
            saw_iend = True
            offset = chunk_end
            if offset != len(raw):
                fail(label + " has bytes after PNG IEND")
            break
        else:
            if saw_idat:
                left_idat = True
            if 0x41 <= type_bytes[0] <= 0x5a:
                fail(label + " has unknown critical PNG chunk " + chunk_type)
        offset = chunk_end
    if not saw_ihdr or not saw_idat or not saw_iend:
        fail(label + " is missing PNG IHDR, IDAT, or IEND")
    expected_length, row_starts = png_expected_bytes(width, height, bits_per_pixel, interlace)
    decoder = zlib.decompressobj()
    try:
        decoded = decoder.decompress(b"".join(idat), expected_length + 1)
        if len(decoded) > expected_length or decoder.unconsumed_tail:
            fail(label + " PNG decoded raster exceeds its exact bound")
        decoded += decoder.flush(max(1, expected_length + 1 - len(decoded)))
    except Exception as error:
        fail("%s PNG IDAT stream did not decode: %s" % (label, error))
    if (not decoder.eof or decoder.unused_data or decoder.unconsumed_tail or
            len(decoded) != expected_length):
        fail(label + " PNG decoded raster length/stream is invalid")
    if any(decoded[row] > 4 for row in row_starts):
        fail(label + " PNG raster has an invalid filter byte")
    if width < 64 or height < 64:
        fail(label + " PNG is too small to be a scene capture")
    return {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw),
            "width": width, "height": height, "format": "png"}


def validate_artifacts(value, label):
    exact_keys(value, ["apk", "effectiveAppSpec", "capture"], label)
    for role in ("apk", "effectiveAppSpec"):
        exact_keys(value[role], ["store", "algorithm", "sha256", "bytes"], label + "." + role)
        if value[role]["store"] != "receipt" or value[role]["algorithm"] != "sha256":
            fail(label + "." + role + " has invalid store/algorithm")
        valid_sha(value[role]["sha256"], label + "." + role + ".sha256")
        valid_nonnegative_int(value[role]["bytes"], label + "." + role + ".bytes",
                              MAX_APK_BYTES if role == "apk" else MAX_SPEC_BYTES,
                              positive=(role == "apk"))
    capture = value["capture"]
    exact_keys(capture, ["store", "algorithm", "sha256", "bytes", "width", "height", "format"], label + ".capture")
    if capture["store"] != "ledger" or capture["algorithm"] != "sha256" or capture["format"] != "png":
        fail(label + ".capture has invalid store/algorithm/format")
    valid_sha(capture["sha256"], label + ".capture.sha256")
    valid_nonnegative_int(capture["bytes"], label + ".capture.bytes", MAX_CAPTURE_BYTES)
    valid_nonnegative_int(capture["width"], label + ".capture.width", 16384, positive=True)
    valid_nonnegative_int(capture["height"], label + ".capture.height", 16384, positive=True)


def validate_recorded_root_identity(value, label):
    exact_keys(value, ["realPath", "deviceId", "inode"], label)
    validate_root_locator(value["realPath"], label + ".realPath")
    if not isinstance(value["deviceId"], str) or not DECIMAL.fullmatch(value["deviceId"]):
        fail(label + ".deviceId is not canonical unsigned decimal")
    if not isinstance(value["inode"], str) or not DECIMAL.fullmatch(value["inode"]):
        fail(label + ".inode is not canonical unsigned decimal")


def validate_manifest_core(core):
    exact_keys(core, ["app", "portableReceiptId", "sourceReceiptId", "sourceRoots", "targetRoots", "artifacts"], "promotion core")
    if not isinstance(core["app"], str) or not APP.fullmatch(core["app"]):
        fail("promotion core app is invalid")
    valid_sha(core["portableReceiptId"], "promotion core portableReceiptId")
    valid_sha(core["sourceReceiptId"], "promotion core sourceReceiptId")
    for group in ("sourceRoots", "targetRoots"):
        exact_keys(core[group], ["receipt", "ledger"], "promotion " + group)
        for role in ("receipt", "ledger"):
            validate_recorded_root_identity(core[group][role], "promotion %s.%s" % (group, role))
    validate_artifacts(core["artifacts"], "promotion artifacts")


def validate_manifest(raw, expected_core=None, expected_promotion=None):
    manifest = parse_json_bytes(raw, MAX_MANIFEST_BYTES, "promotion manifest", canonical=True)
    exact_keys(manifest, ["kind", "schemaVersion", "promotionId", "auditId", "core", "recordedAt", "toolVersion"], "promotion manifest")
    if manifest["kind"] != "pico.run-receipt-promotion" or manifest["schemaVersion"] != 1:
        fail("promotion manifest kind/schema is invalid")
    valid_sha(manifest["promotionId"], "manifest promotionId")
    valid_sha(manifest["auditId"], "manifest auditId")
    validate_manifest_core(manifest["core"])
    if expected_promotion is not None and manifest["promotionId"] != expected_promotion:
        fail("promotion manifest ID does not match the requested filename")
    if expected_core is not None and manifest["core"] != expected_core:
        fail("existing promotion manifest core is mismatched")
    if not isinstance(manifest["recordedAt"], str) or not TIMESTAMP.fullmatch(manifest["recordedAt"]):
        fail("promotion manifest recordedAt is invalid")
    if (not isinstance(manifest["toolVersion"], str) or len(manifest["toolVersion"]) > 64 or
            not TOOL_VERSION.fullmatch(manifest["toolVersion"])):
        fail("promotion manifest toolVersion is invalid")
    return manifest


def inspect_targets(target_receipt, target_ledger, app, portable_id, promotion_id):
    # The manifest is the sole commit marker and must be opened before any dependent target.
    _, _, manifest_raw = read_final(
        target_receipt, ["promotions-v1", app, promotion_id + ".json"],
        MAX_MANIFEST_BYTES, "promotion manifest", retain_bytes=True)
    manifest = validate_manifest(manifest_raw, expected_promotion=promotion_id)
    core = manifest["core"]
    if core["app"] != app or core["portableReceiptId"] != portable_id:
        fail("promotion manifest app/portable ID does not match the request")
    valid_sha(core["sourceReceiptId"], "promotion sourceReceiptId")
    # Recorded source roots were checked lexically by validate_manifest_core.  Never resolve or open
    # either source locator here; target roots are compared only with already-open descriptors.
    if core["targetRoots"]["receipt"] != root_identity(target_receipt.path, os.fstat(target_receipt.fd)):
        fail("manifest target receipt root identity does not match the opened root")
    if core["targetRoots"]["ledger"] != root_identity(target_ledger.path, os.fstat(target_ledger.fd)):
        fail("manifest target ledger root identity does not match the opened root")

    _, _, portable_raw = read_final(
        target_receipt, ["portable-v1", app, portable_id + ".json"],
        MAX_RECEIPT_BYTES, "portable receipt", retain_bytes=True)
    portable = parse_json_bytes(portable_raw, MAX_RECEIPT_BYTES, "portable receipt", canonical=True)
    exact_keys(portable, ["kind", "schemaVersion", "receiptId", "app", "sourceReceipt", "artifacts"], "portable receipt")
    if (portable["kind"] != "pico.portable-native-run-receipt" or portable["schemaVersion"] != 1 or
            portable["receiptId"] != portable_id or portable["app"] != app):
        fail("portable receipt identity/app/kind is invalid")
    exact_keys(portable["sourceReceipt"], ["kind", "schemaVersion", "receiptId", "fileSha256"], "portable sourceReceipt")
    if (portable["sourceReceipt"]["kind"] != "pico.native-run-receipt" or
            portable["sourceReceipt"]["schemaVersion"] != 1 or
            portable["sourceReceipt"]["receiptId"] != core["sourceReceiptId"]):
        fail("portable source receipt does not match the manifest")
    valid_sha(portable["sourceReceipt"]["fileSha256"], "portable source fileSha256")
    validate_artifacts(portable["artifacts"], "portable artifacts")
    if portable["artifacts"] != core["artifacts"]:
        fail("portable and manifest artifacts differ")
    _, _, lineage_raw = read_final(
        target_receipt, ["portable-lineage-v1", app, core["sourceReceiptId"] + ".json"],
        MAX_RECEIPT_BYTES, "native lineage receipt", retain_bytes=True)
    lineage = parse_json_bytes(lineage_raw, MAX_RECEIPT_BYTES, "native lineage receipt", canonical=True)
    if not isinstance(lineage, dict) or lineage.get("receiptId") != core["sourceReceiptId"]:
        fail("native lineage embedded identity does not match its filename")
    if hashlib.sha256(lineage_raw).hexdigest() != portable["sourceReceipt"]["fileSha256"]:
        fail("native lineage receipt file hash is mismatched")

    artifacts = core["artifacts"]
    apk_sha, apk_size, _ = read_final(
        target_receipt, ["artifacts", "apk", artifacts["apk"]["sha256"] + ".apk"],
        MAX_APK_BYTES, "target APK", positive=True, retain_bytes=False)
    if apk_sha != artifacts["apk"]["sha256"] or apk_size != artifacts["apk"]["bytes"]:
        fail("target APK facts are mismatched")
    spec_stored_sha, spec_stored_size, spec_raw = read_final(
        target_receipt, ["artifacts", "spec", artifacts["effectiveAppSpec"]["sha256"] + ".json"],
        MAX_SPEC_BYTES, "target effective AppSpec", retain_bytes=True)
    parse_json_bytes(spec_raw, MAX_SPEC_BYTES, "target effective AppSpec", canonical=True)
    if (hashlib.sha256(spec_raw[:-1]).hexdigest() != artifacts["effectiveAppSpec"]["sha256"] or
            len(spec_raw) - 1 != artifacts["effectiveAppSpec"]["bytes"]):
        fail("target effective AppSpec canonical identity is mismatched")
    capture_sha, capture_size, capture_raw = read_final(
        target_ledger, ["artifacts", artifacts["capture"]["sha256"] + ".png"],
        MAX_CAPTURE_BYTES, "target capture", retain_bytes=True)
    capture = inspect_png(capture_raw, "target capture")
    if capture_sha != capture["sha256"] or capture_size != capture["bytes"] or capture != {
            "sha256": artifacts["capture"]["sha256"], "bytes": artifacts["capture"]["bytes"],
            "width": artifacts["capture"]["width"], "height": artifacts["capture"]["height"], "format": "png"}:
        fail("target capture facts are mismatched")

    return {
        "rootIdentities": {
            "receipt": root_identity(target_receipt.path, os.fstat(target_receipt.fd)),
            "ledger": root_identity(target_ledger.path, os.fstat(target_ledger.fd)),
        },
        "lineageReceiptBase64": encode_base64(lineage_raw),
        "effectiveAppSpecBase64": encode_base64(spec_raw),
        "captureBase64": encode_base64(capture_raw),
        "portableReceiptBase64": encode_base64(portable_raw),
        "manifestBase64": encode_base64(manifest_raw),
        "artifacts": {
            "apk": {"sha256": apk_sha, "bytes": apk_size},
            "effectiveAppSpec": {"storedSha256": spec_stored_sha, "storedBytes": spec_stored_size},
            "capture": capture,
        },
    }


def check_platform_apis():
    required_constants = ("O_NOFOLLOW", "O_DIRECTORY", "O_CLOEXEC")
    if os.name != "posix" or any(not hasattr(os, name) for name in required_constants):
        unavailable("required POSIX no-follow descriptor APIs are unavailable")
    for function in (os.open, os.mkdir, os.link, os.unlink, os.stat):
        if function not in os.supports_dir_fd:
            unavailable("required descriptor-relative filesystem APIs are unavailable")
    if (os.link not in os.supports_follow_symlinks or os.stat not in os.supports_follow_symlinks or
            not callable(getattr(os, "fsync", None))):
        unavailable("required create-only hard-link/fsync APIs are unavailable")


def enforce_fd_budget(root_values):
    component_count = sum(len(value["realPath"].split("/")) - 1 for value in root_values)
    required = component_count + len(root_values) * MAX_RETAINED_DESCENDANTS + 16
    soft, _ = resource.getrlimit(resource.RLIMIT_NOFILE)
    if soft != resource.RLIM_INFINITY and soft < required:
        fail("open-file limit %d is below the calculated helper budget %d" % (soft, required))


def reject_root_overlap(named_roots):
    items = list(named_roots.items())
    for index, (left_name, left) in enumerate(items):
        for right_name, right in items[index + 1:]:
            same_path = left.path == right.path
            same_identity = (os.fstat(left.fd).st_dev, os.fstat(left.fd).st_ino) == (
                os.fstat(right.fd).st_dev, os.fstat(right.fd).st_ino)
            allowed_equal = {left_name, right_name} == {"sourceReceipt", "targetReceipt"}
            if same_path and not allowed_equal:
                fail("store roots %s and %s must be distinct" % (left_name, right_name))
            if same_path:
                continue
            if same_identity:
                fail("store roots %s and %s are non-identical aliases of one directory" % (left_name, right_name))
            left_prefix = left.path + "/"
            right_prefix = right.path + "/"
            descriptor_overlap = ((os.fstat(left.fd).st_dev, os.fstat(left.fd).st_ino) in right.chain_ids or
                                  (os.fstat(right.fd).st_dev, os.fstat(right.fd).st_ino) in left.chain_ids)
            if left.path.startswith(right_prefix) or right.path.startswith(left_prefix) or descriptor_overlap:
                fail("store roots %s and %s must not be ancestors or descendants" % (left_name, right_name))


def validate_expected(expected):
    exact_keys(expected, ["sourceReceiptFileSha256", "apk", "effectiveAppSpec", "capture"], "expected")
    valid_sha(expected["sourceReceiptFileSha256"], "expected source receipt file hash")
    exact_keys(expected["apk"], ["sha256", "bytes"], "expected.apk")
    valid_sha(expected["apk"]["sha256"], "expected APK hash")
    valid_nonnegative_int(expected["apk"]["bytes"], "expected APK bytes", MAX_APK_BYTES, positive=True)
    exact_keys(expected["effectiveAppSpec"], ["sha256", "bytes", "storedSha256", "storedBytes"], "expected.effectiveAppSpec")
    valid_sha(expected["effectiveAppSpec"]["sha256"], "expected spec hash")
    valid_sha(expected["effectiveAppSpec"]["storedSha256"], "expected stored spec hash")
    valid_nonnegative_int(expected["effectiveAppSpec"]["bytes"], "expected spec canonical bytes", MAX_SPEC_BYTES)
    valid_nonnegative_int(expected["effectiveAppSpec"]["storedBytes"], "expected stored spec bytes", MAX_SPEC_BYTES)
    exact_keys(expected["capture"], ["sha256", "bytes", "width", "height", "format"], "expected.capture")
    valid_sha(expected["capture"]["sha256"], "expected capture hash")
    valid_nonnegative_int(expected["capture"]["bytes"], "expected capture bytes", MAX_CAPTURE_BYTES)
    valid_nonnegative_int(expected["capture"]["width"], "expected capture width", 16384, positive=True)
    valid_nonnegative_int(expected["capture"]["height"], "expected capture height", 16384, positive=True)
    if expected["capture"]["format"] != "png":
        fail("expected capture format must be png")


def do_promote(request):
    exact_keys(request, ["protocol", "version", "operation", "app", "sourceReceiptId", "roots", "expected", "publications"], "promote request")
    app = request["app"]
    source_id = request["sourceReceiptId"]
    if not isinstance(app, str) or not APP.fullmatch(app):
        fail("app is not a canonical Android package")
    valid_sha(source_id, "sourceReceiptId")
    exact_keys(request["roots"], ["sourceReceipt", "sourceLedger", "targetReceipt", "targetLedger"], "promote roots")
    validate_expected(request["expected"])
    exact_keys(request["publications"], ["portableReceiptBase64", "manifestBase64"], "publications")
    portable_raw = decode_base64(request["publications"]["portableReceiptBase64"], MAX_RECEIPT_BYTES, "portable receipt publication")
    manifest_raw = decode_base64(request["publications"]["manifestBase64"], MAX_MANIFEST_BYTES, "manifest publication")
    portable = parse_json_bytes(portable_raw, MAX_RECEIPT_BYTES, "portable receipt publication", canonical=True)
    manifest = validate_manifest(manifest_raw)
    expected = request["expected"]
    roots = request["roots"]
    enforce_fd_budget(list(roots.values()))
    opened = {}
    source_files = []
    try:
        for name in ("sourceReceipt", "sourceLedger", "targetReceipt", "targetLedger"):
            opened[name] = StoreRoot(name, roots[name])
        reject_root_overlap(opened)
        if manifest["core"]["sourceReceiptId"] != source_id or manifest["core"]["app"] != app:
            fail("manifest source/app does not match the promotion request")
        if portable["receiptId"] != manifest["core"]["portableReceiptId"]:
            fail("portable publication does not match the manifest")

        receipt = Snapshot(opened["sourceReceipt"], ["native-v1", app, source_id + ".json"],
                           MAX_RECEIPT_BYTES, "source native receipt", retain_bytes=True)
        source_files.append(receipt)
        apk = Snapshot(opened["sourceReceipt"], ["artifacts", "apk", expected["apk"]["sha256"] + ".apk"],
                       MAX_APK_BYTES, "source APK", positive=True, retain_bytes=False)
        source_files.append(apk)
        spec = Snapshot(opened["sourceReceipt"], ["artifacts", "spec", expected["effectiveAppSpec"]["sha256"] + ".json"],
                        MAX_SPEC_BYTES, "source effective AppSpec", retain_bytes=True)
        source_files.append(spec)
        capture = Snapshot(opened["sourceLedger"], ["artifacts", expected["capture"]["sha256"] + ".png"],
                           MAX_CAPTURE_BYTES, "source capture", retain_bytes=True)
        source_files.append(capture)
        source_receipt = parse_json_bytes(receipt.bytes, MAX_RECEIPT_BYTES, "source native receipt", canonical=True)
        if not isinstance(source_receipt, dict) or source_receipt.get("receiptId") != source_id:
            fail("source native receipt embedded identity does not match its filename")
        parse_json_bytes(spec.bytes, MAX_SPEC_BYTES, "source effective AppSpec", canonical=True)
        capture_facts = inspect_png(capture.bytes, "source capture")
        if receipt.sha256 != expected["sourceReceiptFileSha256"]:
            fail("source native receipt file hash is mismatched")
        if apk.sha256 != expected["apk"]["sha256"] or apk.size != expected["apk"]["bytes"]:
            fail("source APK facts are mismatched")
        if (spec.sha256 != expected["effectiveAppSpec"]["storedSha256"] or
                spec.size != expected["effectiveAppSpec"]["storedBytes"]):
            fail("source effective AppSpec stored facts are mismatched")
        if (hashlib.sha256(spec.bytes[:-1]).hexdigest() != expected["effectiveAppSpec"]["sha256"] or
                len(spec.bytes) - 1 != expected["effectiveAppSpec"]["bytes"]):
            fail("source effective AppSpec canonical identity is mismatched")
        if capture_facts != expected["capture"]:
            fail("source capture facts are mismatched")

        publish_stream(opened["targetReceipt"], ["artifacts", "apk", expected["apk"]["sha256"] + ".apk"],
                       apk, expected["apk"]["sha256"], expected["apk"]["bytes"], "target APK")
        publish_bytes(opened["targetReceipt"], ["artifacts", "spec", expected["effectiveAppSpec"]["sha256"] + ".json"],
                      spec.bytes, "target effective AppSpec")
        publish_bytes(opened["targetLedger"], ["artifacts", expected["capture"]["sha256"] + ".png"],
                      capture.bytes, "target capture")
        publish_bytes(opened["targetReceipt"], ["portable-lineage-v1", app, source_id + ".json"],
                      receipt.bytes, "native lineage receipt")
        publish_bytes(opened["targetReceipt"], ["portable-v1", app, portable["receiptId"] + ".json"],
                      portable_raw, "portable receipt")

        def validate_manifest_winner(existing, proposed):
            proposed_value = validate_manifest(proposed)
            validate_manifest(existing, expected_core=proposed_value["core"],
                              expected_promotion=proposed_value["promotionId"])

        publish_bytes(opened["targetReceipt"], ["promotions-v1", app, manifest["promotionId"] + ".json"],
                      manifest_raw, "promotion manifest", existing_validator=validate_manifest_winner)
        inspection = inspect_targets(opened["targetReceipt"], opened["targetLedger"], app,
                                     portable["receiptId"], manifest["promotionId"])
        for source in source_files:
            source.verify()
        for root in opened.values():
            root.verify()
        return inspection
    finally:
        for source in source_files:
            source.close()
        for root in reversed(list(opened.values())):
            root.close()


def do_inspect(request):
    exact_keys(request, ["protocol", "version", "operation", "app", "portableReceiptId", "promotionId", "roots"], "inspect request")
    app = request["app"]
    if not isinstance(app, str) or not APP.fullmatch(app):
        fail("app is not a canonical Android package")
    valid_sha(request["portableReceiptId"], "portableReceiptId")
    valid_sha(request["promotionId"], "promotionId")
    exact_keys(request["roots"], ["targetReceipt", "targetLedger"], "inspect roots")
    enforce_fd_budget(list(request["roots"].values()))
    opened = {}
    try:
        opened["targetReceipt"] = StoreRoot("targetReceipt", request["roots"]["targetReceipt"])
        opened["targetLedger"] = StoreRoot("targetLedger", request["roots"]["targetLedger"])
        reject_root_overlap(opened)
        inspection = inspect_targets(opened["targetReceipt"], opened["targetLedger"], app,
                                     request["portableReceiptId"], request["promotionId"])
        for root in opened.values():
            root.verify()
        return inspection
    finally:
        for root in reversed(list(opened.values())):
            root.close()


def read_request():
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        fail("helper request exceeds the %d-byte limit" % MAX_REQUEST_BYTES)
    if not raw:
        fail("helper request is empty")
    request = parse_json_bytes(raw, MAX_REQUEST_BYTES, "helper request", canonical=False)
    if not isinstance(request, dict):
        fail("helper request must be an object")
    if request.get("protocol") != PROTOCOL or request.get("version") != VERSION:
        fail("unsupported helper protocol/version")
    if request.get("operation") not in ("promote", "inspect"):
        fail("unsupported helper operation")
    return request


def emit(value):
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8") + b"\n"
    sys.stdout.buffer.write(raw)
    sys.stdout.buffer.flush()


def main():
    operation = "unknown"
    try:
        request = read_request()
        operation = request["operation"]
        check_platform_apis()
        inspection = do_promote(request) if operation == "promote" else do_inspect(request)
        emit({"protocol": PROTOCOL, "version": VERSION, "status": "ok",
              "operation": operation, "inspection": inspection})
    except UnsupportedPortabilityError as error:
        emit({"protocol": PROTOCOL, "version": VERSION, "status": "unavailable",
              "operation": operation, "reason": str(error)[:4096]})
    except PortabilityError as error:
        emit({"protocol": PROTOCOL, "version": VERSION, "status": "error",
              "operation": operation, "reason": str(error)[:4096]})
    except Exception as error:
        emit({"protocol": PROTOCOL, "version": VERSION, "status": "error",
              "operation": operation, "reason": ("helper failure: %s" % error)[:4096]})


if __name__ == "__main__":
    main()
