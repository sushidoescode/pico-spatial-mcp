// Hermetic in-memory filesystem for PICO toolchain selection tests (Task S1).
//
// Nothing here touches the host filesystem and nothing here is ever executed: an
// "executable" is a boolean flag on a simulated tree node, so a fixture can model
// ~/Library/PICO/sdk layouts, Windows drive/UNC roots and broken installs without
// a real SDK being present (or being read).
//
// toolchainIOFromTree({platform, home, env, files}) -> ToolchainIO
//   files     : {absolutePath: {bytes: string, executable?: boolean}}
//   dirs      : [absolutePath]            extra directories with no files in them
//   symlinks  : {aliasPath: targetPath}   path aliases, honoured by realpath()
//   unreadable: [absolutePath]            entries that exist but deny read/list
// The returned io also carries `reads` — every path passed to io.read(), in call
// order — so a test can prove which payload bytes a selection actually consumed.

import path from "node:path";

export function toolchainIOFromTree({
  platform = "darwin",
  home = "/fixture",
  env = {},
  files = {},
  dirs = [],
  symlinks = {},
  unreadable = [],
} = {}) {
  const P = platform === "win32" ? path.win32 : path.posix;
  const caseInsensitive = platform === "win32";
  const key = (value) => (caseInsensitive ? value.toLowerCase() : value);

  const normalize = (raw) => {
    if (typeof raw !== "string" || raw === "") return "";
    let value = P.normalize(raw);
    const root = P.parse(value).root;
    while (value.length > root.length && value.endsWith(P.sep)) value = value.slice(0, -1);
    return value;
  };

  const absolute = (raw, what) => {
    const value = normalize(raw);
    if (!P.isAbsolute(value)) throw new Error(`toolchainIOFromTree: ${what} must be an absolute ${platform} path, got ${JSON.stringify(raw)}`);
    return value;
  };

  const fileTable = new Map(); // key(path) -> {path, bytes, executable}
  const dirTable = new Map(); // key(path) -> path
  const childTable = new Map(); // key(dirPath) -> Map(key(name) -> name)

  const addDir = (dir) => {
    if (!dirTable.has(key(dir))) dirTable.set(key(dir), dir);
    if (!childTable.has(key(dir))) childTable.set(key(dir), new Map());
  };
  const addAncestors = (target) => {
    let cur = target;
    for (;;) {
      const parent = P.dirname(cur);
      if (parent === cur) {
        addDir(parent);
        break;
      }
      addDir(parent);
      const name = P.basename(cur);
      if (name) childTable.get(key(parent)).set(key(name), name);
      cur = parent;
    }
  };

  for (const dir of dirs) {
    const abs = absolute(dir, "dirs entry");
    addDir(abs);
    addAncestors(abs);
  }
  for (const [rawPath, spec] of Object.entries(files)) {
    const abs = absolute(rawPath, "files key");
    if (dirTable.has(key(abs))) throw new Error(`toolchainIOFromTree: ${rawPath} is declared both as a directory and a file`);
    fileTable.set(key(abs), {
      path: abs,
      bytes: typeof spec === "string" ? spec : String(spec?.bytes ?? ""),
      executable: typeof spec === "string" ? false : Boolean(spec?.executable),
    });
    addAncestors(abs);
  }

  const linkTable = Object.entries(symlinks).map(([alias, target]) => [
    absolute(alias, "symlinks alias"),
    absolute(target, "symlinks target"),
  ]);
  const resolveLinks = (input) => {
    let current = input;
    for (let hop = 0; hop < 16; hop += 1) {
      let rewritten = null;
      for (const [alias, target] of linkTable) {
        if (key(current) === key(alias)) { rewritten = target; break; }
        if (key(current).startsWith(key(alias) + P.sep)) { rewritten = normalize(target + current.slice(alias.length)); break; }
      }
      if (rewritten === null) return current;
      current = rewritten;
    }
    return current;
  };

  const unreadableTable = new Set(unreadable.map((p) => key(absolute(p, "unreadable entry"))));
  const denied = (resolved) => {
    if (unreadableTable.has(key(resolved))) return true;
    for (const blocked of unreadableTable) {
      if (key(resolved).startsWith(blocked + P.sep)) return true;
    }
    return false;
  };

  const io = {
    platform,
    home: normalize(home),
    env: { ...env },
    reads: [],
    read(target) {
      const requested = normalize(target);
      io.reads.push(requested);
      const resolved = resolveLinks(requested);
      if (denied(resolved)) return null;
      const file = fileTable.get(key(resolved));
      return file ? Buffer.from(file.bytes, "utf8") : null;
    },
    entries(target) {
      const resolved = resolveLinks(normalize(target));
      if (denied(resolved)) return null;
      if (!dirTable.has(key(resolved))) return null;
      return [...childTable.get(key(resolved)).values()].sort();
    },
    realpath(target) {
      const resolved = resolveLinks(normalize(target));
      if (fileTable.has(key(resolved))) return fileTable.get(key(resolved)).path;
      if (dirTable.has(key(resolved))) return dirTable.get(key(resolved));
      return null;
    },
    executable(target) {
      const resolved = resolveLinks(normalize(target));
      if (denied(resolved)) return false;
      const file = fileTable.get(key(resolved));
      return Boolean(file && file.executable);
    },
  };
  return io;
}

/** The macOS layout the real host uses, for tests that only vary the payload. */
export function macSdkTree(versions) {
  const files = {};
  for (const [version, components] of Object.entries(versions)) {
    const base = `/fixture/Library/PICO/sdk/${version}`;
    if (components.packer !== undefined) files[`${base}/editor/spatialbundle/spatialbundle`] = { bytes: components.packer, executable: true };
    if (components.emulator !== undefined) files[`${base}/emulator/emulator`] = { bytes: components.emulator, executable: true };
    if (components.adb !== undefined) files[`${base}/emulator/system-images/platform-tools/adb`] = { bytes: components.adb, executable: true };
    if (components.proto !== undefined) files[`${base}/emulator/lib/emulator_controller.proto`] = { bytes: components.proto };
  }
  return files;
}
