import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { appSpecSchema } from "./appspec.js";

export type CanonicalIdentity = {
  algorithm: "sha256";
  sha256: string;
  bytes: number;
};

export type AuthoredAppSpecIdentity = CanonicalIdentity & {
  sourcePath: string;
};

export type GradleInputEntry = {
  path: string;
  bytes: number;
  sha256: string;
};

export type GradleInputIdentity = {
  schemaVersion: 1;
  projectDir: string;
  algorithm: "sha256";
  sha256: string;
  entryCount: number;
  totalBytes: number;
  entries: GradleInputEntry[];
};

export const GRADLE_INPUT_MAX_ENTRIES = 20_000;
export const GRADLE_INPUT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const GRADLE_INPUT_MAX_FILE_BYTES = 512 * 1024 * 1024;

const ROOT_FILES = new Set([
  "settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts",
  "gradle.properties", "gradlew", "gradlew.bat",
  "app/build.gradle", "app/build.gradle.kts", "app/proguard-rules.pro",
]);
const RECURSIVE_ROOTS = ["gradle", "buildSrc", "app/src", "app/libs", "libs"] as const;

function canonicalValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON requires finite numbers");
    return value;
  }
  if (typeof value !== "object") {
    throw new Error(`unsupported canonical JSON value: ${typeof value}`);
  }
  if (ancestors.has(value)) throw new Error("canonical JSON does not support cyclic values");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new Error("unsupported canonical JSON array type");
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new Error("canonical JSON does not support sparse arrays");
      }
      const keys = Reflect.ownKeys(value).filter((key) => key !== "length");
      if (keys.length !== value.length) {
        throw new Error("canonical JSON arrays must have no extra properties");
      }
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new Error("unsupported canonical JSON array accessor property");
        }
        result.push(canonicalValue(descriptor.value, ancestors));
      }
      return result;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("unsupported canonical JSON object type");
    }
    const result: Record<string, unknown> = Object.create(null);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      throw new Error("unsupported canonical JSON symbol key");
    }
    for (const key of (keys as string[]).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new Error("unsupported canonical JSON property");
      }
      result[key] = canonicalValue(descriptor.value, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(canonicalValue(value, new Set()));
  if (encoded === undefined) throw new Error("value has no canonical JSON encoding");
  return encoded;
}

export function canonicalIdentity(value: unknown): CanonicalIdentity {
  const canonical = canonicalJson(value);
  return {
    algorithm: "sha256",
    sha256: crypto.createHash("sha256").update(canonical).digest("hex"),
    bytes: Buffer.byteLength(canonical),
  };
}

export function readAuthoredAppSpecIdentity(briefPath: string): AuthoredAppSpecIdentity {
  const sourcePath = fs.realpathSync(path.resolve(briefPath));
  const brief: unknown = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  if (
    brief === null ||
    typeof brief !== "object" ||
    Array.isArray(brief) ||
    !Object.hasOwn(brief, "spec")
  ) {
    throw new Error(`authored brief ${sourcePath} must contain .spec`);
  }
  const identity = canonicalIdentity(appSpecSchema.parse((brief as { spec: unknown }).spec));
  return { ...identity, sourcePath };
}

export function effectiveAppSpecIdentity(spec: unknown): CanonicalIdentity {
  return canonicalIdentity(spec);
}

function isWithinProject(projectRealPath: string, candidateRealPath: string): boolean {
  const relative = path.relative(projectRealPath, candidateRealPath);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function validateSelectedPath(
  projectRealPath: string,
  selectedPath: string,
): { stat: fs.Stats; realPath: string } {
  const stat = fs.lstatSync(selectedPath);
  let realPath: string;
  try {
    realPath = fs.realpathSync(selectedPath);
  } catch (error) {
    if (stat.isSymbolicLink()) throw new Error(`selected Gradle input is an unsupported symlink: ${selectedPath}`);
    throw error;
  }
  if (!isWithinProject(projectRealPath, realPath)) {
    throw new Error(`selected Gradle input escapes the real project root: ${selectedPath}`);
  }
  if (stat.isSymbolicLink()) throw new Error(`selected Gradle input is an unsupported symlink: ${selectedPath}`);
  return { stat, realPath };
}

function lstatIfPresent(selectedPath: string): fs.Stats | null {
  try {
    return fs.lstatSync(selectedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function hashSelectedFile(filePath: string, expected: fs.Stats): { bytes: number; sha256: string } {
  if (!expected.isFile()) throw new Error(`selected Gradle input is not a regular file: ${filePath}`);
  if (expected.size > GRADLE_INPUT_MAX_FILE_BYTES) {
    throw new Error(`selected Gradle input exceeds the ${GRADLE_INPUT_MAX_FILE_BYTES}-byte file limit: ${filePath}`);
  }
  const descriptor = fs.openSync(filePath, "r");
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino ||
      opened.size !== expected.size ||
      opened.mtimeMs !== expected.mtimeMs ||
      opened.ctimeMs !== expected.ctimeMs
    ) {
      throw new Error(`selected Gradle input changed before hashing: ${filePath}`);
    }
    const openedStable = fs.fstatSync(descriptor, { bigint: true });
    const digest = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    while (bytes < opened.size) {
      const count = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, opened.size - bytes), null);
      if (count === 0) throw new Error(`selected Gradle input ended while hashing: ${filePath}`);
      digest.update(buffer.subarray(0, count));
      bytes += count;
    }
    const afterStable = fs.fstatSync(descriptor, { bigint: true });
    if (
      afterStable.dev !== openedStable.dev ||
      afterStable.ino !== openedStable.ino ||
      afterStable.size !== openedStable.size ||
      afterStable.mtimeNs !== openedStable.mtimeNs ||
      afterStable.ctimeNs !== openedStable.ctimeNs
    ) {
      throw new Error(`selected Gradle input changed while hashing: ${filePath}`);
    }
    return { bytes, sha256: digest.digest("hex") };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function collectGradleInputIdentity(projectDir: string): GradleInputIdentity {
  const projectRealPath = fs.realpathSync(path.resolve(projectDir));
  if (!fs.lstatSync(projectRealPath).isDirectory()) {
    throw new Error(`Gradle project is not a directory: ${projectRealPath}`);
  }
  const entries: GradleInputEntry[] = [];
  let totalBytes = 0;

  const addFile = (selectedPath: string): void => {
    const { stat, realPath } = validateSelectedPath(projectRealPath, selectedPath);
    const relativePath = path.relative(projectRealPath, realPath).split(path.sep).join("/");
    const hashed = hashSelectedFile(realPath, stat);
    if (entries.length >= GRADLE_INPUT_MAX_ENTRIES) {
      throw new Error(`Gradle input manifest exceeds ${GRADLE_INPUT_MAX_ENTRIES} entries`);
    }
    if (totalBytes + hashed.bytes > GRADLE_INPUT_MAX_TOTAL_BYTES) {
      throw new Error(`Gradle input manifest exceeds ${GRADLE_INPUT_MAX_TOTAL_BYTES} total bytes`);
    }
    entries.push({ path: relativePath, bytes: hashed.bytes, sha256: hashed.sha256 });
    totalBytes += hashed.bytes;
  };

  const walk = (selectedPath: string): void => {
    const { stat, realPath } = validateSelectedPath(projectRealPath, selectedPath);
    if (stat.isFile()) {
      addFile(realPath);
      return;
    }
    if (!stat.isDirectory()) {
      throw new Error(`selected Gradle input is not a regular file or directory: ${selectedPath}`);
    }
    for (const name of fs.readdirSync(realPath).sort()) walk(path.join(realPath, name));
  };

  for (const relativePath of ROOT_FILES) {
    const selectedPath = path.join(projectRealPath, ...relativePath.split("/"));
    if (lstatIfPresent(selectedPath)) addFile(selectedPath);
  }
  for (const relativeRoot of RECURSIVE_ROOTS) {
    const selectedRoot = path.join(projectRealPath, ...relativeRoot.split("/"));
    if (lstatIfPresent(selectedRoot)) walk(selectedRoot);
  }

  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (!entries.some((entry) => entry.path.startsWith("app/src/") && path.posix.basename(entry.path) === "AndroidManifest.xml")) {
    throw new Error("Gradle input manifest requires at least one Android manifest under app/src");
  }
  if (!entries.some((entry) => entry.path.startsWith("app/src/") && /\.(?:kt|java)$/.test(entry.path))) {
    throw new Error("Gradle input manifest requires at least one Kotlin or Java source under app/src");
  }
  const manifestIdentity = canonicalIdentity(entries);
  return {
    schemaVersion: 1,
    projectDir: projectRealPath,
    algorithm: "sha256",
    sha256: manifestIdentity.sha256,
    entryCount: entries.length,
    totalBytes,
    entries,
  };
}
