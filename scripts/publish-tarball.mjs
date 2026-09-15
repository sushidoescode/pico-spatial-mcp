/**
 * publish-tarball — land a verified release artifact without replacing or removing anything.
 *
 * The defect this module exists to remove: `verify-tarball --publish <dir>` used to enumerate the
 * destination directory and `rmSync` every `.tgz` in it before copying the new one in. Publishing
 * 37.0.0 therefore destroyed the 36.9.x artifacts testers were still installing from, and a failed
 * copy after that sweep left the directory with no release at all.
 *
 * The primitive here can only ADD. Its guarantees, in the order they are enforced:
 *
 *   1. Bytes that did not pass verification are never staged. The caller passes the digest the
 *      installed-copy checks actually ran against; the source is hashed first and refused on any
 *      mismatch.
 *   2. Nothing partial is ever visible under the destination name. The copy goes to a task-owned
 *      temporary in the destination's own directory, opened `wx` so it can never collide with
 *      anything that is already there.
 *   3. What landed is re-read from disk and re-hashed before publication — deliberately through
 *      real `fs`, never through the injectable `io` seam, so a broken or stubbed write cannot
 *      certify itself.
 *   4. Publication is `link()`: an exclusive, non-replacing primitive. EEXIST means the artifact is
 *      already there and the existing file is left exactly as it was.
 *   5. The only path this module ever removes is the temporary it created itself. There is no
 *      directory enumeration anywhere in this file, so no other archive can be reached.
 *
 * Receipt ordering: the artifact is published first and the receipt written second. A receipt
 * collision then fails loudly with the verified artifact already in place, which destroys nothing;
 * reserving the receipt first would mean cleaning it up whenever the artifact turned out to be
 * occupied, adding a removal path for no gain.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const COPY_CHUNK_BYTES = 1024 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * link() failures that mean "this filesystem has no hard links" rather than "this operation was
 * wrong": FAT/exFAT volumes, some network mounts and some Windows shares. Anything else is a real
 * error and is rethrown untouched.
 */
const LINK_UNSUPPORTED = new Set(["EXDEV", "EPERM", "ENOSYS", "EOPNOTSUPP", "ENOTSUP", "EMLINK"]);

/**
 * The seam. Tests inject a single failing step (a short write, a failing fsync, a filesystem that
 * cannot link) to prove the failure paths leave nothing behind. Verification hashing deliberately
 * does NOT go through here.
 */
export const PUBLISH_IO = Object.freeze({
  openExclusive: (target) => fs.openSync(target, "wx"),
  openRead: (target) => fs.openSync(target, "r"),
  read: (fd, buffer) => fs.readSync(fd, buffer, 0, buffer.length, null),
  write: (fd, buffer, length) => fs.writeSync(fd, buffer, 0, length),
  fsync: (fd) => fs.fsyncSync(fd),
  close: (fd) => fs.closeSync(fd),
  link: (from, to) => fs.linkSync(from, to),
  rename: (from, to) => fs.renameSync(from, to),
  unlink: (target) => fs.unlinkSync(target),
});

const operations = (io) => (io ? { ...PUBLISH_IO, ...io } : PUBLISH_IO);

function requirePath(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty path; received ${JSON.stringify(value)}`);
  }
  return path.resolve(value);
}

/** sha256 and byte count of a file, streamed so a large tarball never lands in memory at once. */
export function fileDigest(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(requirePath(filePath, "filePath"), "r");
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  let bytes = 0;
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
      bytes += read;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { sha256: hash.digest("hex"), bytes };
}

function closeQuietly(fd, ops) {
  try {
    ops.close(fd);
  } catch (error) {
    // A close failure must never replace the error that brought us here.
    console.error(`publish-tarball: closing a descriptor failed: ${error?.message ?? error}`);
  }
}

function occupiedError(what, target) {
  const error = new Error(
    `refusing to publish: ${what} ${target} already exists. A published artifact is never replaced — `
    + "publish under its own version-stamped name, or move that file aside deliberately first.",
  );
  error.code = "EEXIST";
  return error;
}

/** Claim a name nothing else holds, in the destination's own directory so the landing is local. */
function reserveTemporary(directory, basename, ops) {
  let lastError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const temporaryPath = path.join(directory, `.${basename}.${crypto.randomBytes(8).toString("hex")}.part`);
    try {
      return { path: temporaryPath, fd: ops.openExclusive(temporaryPath) };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      lastError = error;
    }
  }
  throw lastError;
}

function copyInto(fd, sourcePath, ops) {
  const readFd = ops.openRead(sourcePath);
  try {
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    for (;;) {
      const read = ops.read(readFd, buffer);
      if (read <= 0) break;
      let written = 0;
      while (written < read) {
        const chunk = buffer.subarray(written, read);
        const wrote = ops.write(fd, chunk, chunk.length);
        if (!(wrote > 0)) throw new Error(`copy stalled after ${written} of ${read} bytes of a chunk`);
        written += wrote;
      }
    }
  } finally {
    closeQuietly(readFd, ops);
  }
  ops.fsync(fd);
}

function removeTemporary(temporaryPath, ops) {
  try {
    ops.unlink(temporaryPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    // Reported, never thrown: this runs in a `finally` and must not mask the real failure.
    console.error(`publish-tarball: could not remove the staged copy ${temporaryPath}: ${error?.message ?? error}`);
  }
}

function land(temporaryPath, destinationPath, ops) {
  try {
    ops.link(temporaryPath, destinationPath);
    return;
  } catch (error) {
    if (error?.code === "EEXIST") throw occupiedError("the artifact", destinationPath);
    if (!LINK_UNSUPPORTED.has(error?.code)) throw error;
  }

  // Hard links are unavailable on this filesystem. rename() would replace silently, so the name is
  // first claimed with an exclusive create — the only primitive left that fails when someone else
  // already holds it. The probe file is ours: we created it one statement ago with `wx`.
  //
  // This leaves a window between removing the probe and the rename that the link path does not
  // have. It is the narrowest non-replacing sequence the platform offers; the hard-link path above
  // is used everywhere it exists.
  const probePath = destinationPath;
  let probeFd;
  try {
    probeFd = ops.openExclusive(probePath);
  } catch (error) {
    if (error?.code === "EEXIST") throw occupiedError("the artifact", destinationPath);
    throw error;
  }
  closeQuietly(probeFd, ops);
  ops.unlink(probePath);
  ops.rename(temporaryPath, destinationPath);
}

/**
 * Publish `source` at the exact file path `destination`, or fail leaving the directory as it was.
 *
 * @param {{source: string, destination: string, expectedSha256: string, io?: object}} options
 *   `destination` is a FILE path, never a directory to prune. `expectedSha256` is the digest of the
 *   artifact that passed the installed-copy checks.
 * @returns {{path: string, sha256: string, bytes: number}}
 */
export function publishVerifiedTarball({ source, destination, expectedSha256, io } = {}) {
  const ops = operations(io);
  const sourcePath = requirePath(source, "source");
  const destinationPath = requirePath(destination, "destination");
  if (typeof expectedSha256 !== "string" || !SHA256_HEX.test(expectedSha256)) {
    throw new TypeError(
      `expectedSha256 must be a lowercase 64-character sha256 hex digest; received ${JSON.stringify(expectedSha256)}`,
    );
  }

  const origin = fileDigest(sourcePath);
  if (origin.sha256 !== expectedSha256) {
    throw new Error(
      `source digest ${origin.sha256} does not match the verified digest ${expectedSha256}: ${sourcePath}. `
      + "Only the artifact the checks actually ran against may be published.",
    );
  }

  const directory = path.dirname(destinationPath);
  fs.mkdirSync(directory, { recursive: true });

  const temporary = reserveTemporary(directory, path.basename(destinationPath), ops);
  try {
    try {
      copyInto(temporary.fd, sourcePath, ops);
    } finally {
      closeQuietly(temporary.fd, ops);
    }

    const staged = fileDigest(temporary.path);
    if (staged.sha256 !== expectedSha256 || staged.bytes !== origin.bytes) {
      throw new Error(
        `the staged copy hashed ${staged.sha256} over ${staged.bytes} bytes, expected `
        + `${expectedSha256} over ${origin.bytes}; nothing was published.`,
      );
    }

    land(temporary.path, destinationPath, ops);
  } finally {
    removeTemporary(temporary.path, ops);
  }

  return { path: destinationPath, sha256: expectedSha256, bytes: origin.bytes };
}

/** The receipt always sits beside its artifact, under the artifact's own name. */
export function receiptPathFor(destination) {
  return `${requirePath(destination, "destination")}.receipt.json`;
}

/**
 * Write the publication receipt for `destination`. Never overwrites: a receipt describes one
 * specific published artifact, so a collision means the caller is about to rewrite history.
 *
 * @param {{destination: string, receipt: object, io?: object}} options
 * @returns {{path: string, bytes: number}}
 */
export function writePublicationReceipt({ destination, receipt, io } = {}) {
  const ops = operations(io);
  const filePath = receiptPathFor(destination);
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new TypeError("receipt must be a plain object describing the published artifact");
  }
  const body = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  let fd;
  try {
    fd = ops.openExclusive(filePath);
  } catch (error) {
    if (error?.code === "EEXIST") throw occupiedError("the publication receipt", filePath);
    throw error;
  }

  let landed = false;
  try {
    let written = 0;
    while (written < body.length) {
      const chunk = body.subarray(written);
      const wrote = ops.write(fd, chunk, chunk.length);
      if (!(wrote > 0)) throw new Error(`receipt write stalled after ${written} of ${body.length} bytes`);
      written += wrote;
    }
    ops.fsync(fd);
    landed = true;
  } finally {
    closeQuietly(fd, ops);
    if (!landed) {
      // Remove only the file we just created ourselves, so a failed write leaves no half receipt.
      try {
        ops.unlink(filePath);
      } catch (error) {
        console.error(`publish-tarball: could not remove the partial receipt ${filePath}: ${error?.message ?? error}`);
      }
    }
  }

  return { path: filePath, bytes: body.length };
}
