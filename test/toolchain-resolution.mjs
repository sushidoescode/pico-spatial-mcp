// Task S1 — component-valid PICO tool selection.
//
// The defect this suite pins down: pickVersion() used to hand back a requested
// version directory even when the component the caller asked for was not in it,
// so an emulator lane could be handed a 6.1 install that only ships the packer.
// Everything below runs against the in-memory tree in helpers/toolchain-fixture.mjs
// — no ~/Library/PICO read, no fixture binary is ever executed. The one exception
// is the legacy-adapter block at the bottom, which builds a throwaway tree under
// os.tmpdir() because the adapters are hard-wired to the host filesystem.
//
// Run: npm run build && node --test test/toolchain-resolution.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { macSdkTree, toolchainIOFromTree } from "./helpers/toolchain-fixture.mjs";
import { executableNames, resolveToolchain } from "../dist/toolchainselection.js";

const MAC_ROOT = "/fixture/Library/PICO/sdk";
const here = path.dirname(fileURLToPath(import.meta.url));

const briefTree = {
  "/fixture/Library/PICO/sdk/6.1/editor/spatialbundle/spatialbundle": { bytes: "six-one", executable: true },
  "/fixture/Library/PICO/sdk/6.0/emulator/emulator": { bytes: "six-zero", executable: true },
};
const briefIO = () => toolchainIOFromTree({ platform: "darwin", home: "/fixture", env: {}, files: briefTree });

const macIO = (versions, extra = {}) =>
  toolchainIOFromTree({ platform: "darwin", home: "/fixture", env: {}, files: macSdkTree(versions), ...extra });

// ---------------------------------------------------------------- fixture helper

test("fixture io models a tree deterministically and records attempted reads", () => {
  const io = macIO({ "6.1": { packer: "six-one", proto: "syntax" } });
  assert.deepEqual(io.entries(MAC_ROOT), ["6.1"]);
  assert.deepEqual(io.entries(`${MAC_ROOT}/6.1`), ["editor", "emulator"]);
  assert.equal(io.entries(`${MAC_ROOT}/6.1/editor/spatialbundle/spatialbundle`), null, "a file is not a directory");
  assert.equal(io.entries("/fixture/missing"), null);
  assert.equal(io.executable(`${MAC_ROOT}/6.1/editor/spatialbundle/spatialbundle`), true);
  assert.equal(io.executable(`${MAC_ROOT}/6.1/emulator/lib/emulator_controller.proto`), false, "proto is data, not a binary");
  assert.equal(io.executable(`${MAC_ROOT}/6.1/editor`), false, "a directory is never executable");
  assert.equal(String(io.read(`${MAC_ROOT}/6.1/editor/spatialbundle/spatialbundle`)), "six-one");
  assert.equal(io.read("/fixture/missing"), null);
  assert.equal(io.realpath(`${MAC_ROOT}/6.1`), `${MAC_ROOT}/6.1`);
  assert.equal(io.realpath("/fixture/missing"), null);
  assert.deepEqual(io.reads, [`${MAC_ROOT}/6.1/editor/spatialbundle/spatialbundle`, "/fixture/missing"]);
});

test("fixture io honours declared symlinks, empty dirs and unreadable entries", () => {
  const io = toolchainIOFromTree({
    platform: "darwin",
    home: "/fixture",
    files: { "/fixture/real/payload": { bytes: "p", executable: true } },
    dirs: ["/fixture/empty", "/fixture/alias"],
    symlinks: { "/fixture/alias": "/fixture/real" },
    unreadable: ["/fixture/locked"],
  });
  assert.deepEqual(io.entries("/fixture/empty"), []);
  assert.deepEqual(io.entries("/fixture/alias"), ["payload"]);
  assert.equal(io.realpath("/fixture/alias/payload"), "/fixture/real/payload");
  assert.equal(io.executable("/fixture/alias/payload"), true);
  assert.equal(io.entries("/fixture/locked"), null);
});

// ------------------------------------------------------- the brief's regression

test("brief regression: component validity, newest usable, explicit-vs-pin conflict", () => {
  const io = briefIO();
  assert.equal(resolveToolchain({ toolsVersion: "6.1", required: ["emulator"] }, io).status, "unavailable");
  assert.equal(resolveToolchain({ required: ["packer"] }, io).version, "6.1");
  assert.equal(resolveToolchain({ toolsVersion: "6.1", projectToolsVersion: "6.0", required: ["packer"] }, io).status, "ambiguous");
});

test("every contract failure code is reachable with its documented trigger", () => {
  const io = briefIO();
  assert.equal(
    resolveToolchain({ toolsVersion: "6.1", required: ["emulator"] }, io).code,
    "unavailable/component-missing",
    "explicit version lacks a required component",
  );
  assert.equal(
    resolveToolchain({ toolsVersion: "7.0", required: ["packer"] }, io).code,
    "unavailable/version-missing",
    "requested version directory does not exist",
  );
  assert.equal(
    resolveToolchain({ toolsRoot: "/fixture/not-installed", required: ["packer"] }, io).code,
    "unavailable/root-unavailable",
    "explicit root is absent",
  );
  assert.equal(
    resolveToolchain({ toolsVersion: "6.1", projectToolsVersion: "6.0", required: ["packer"] }, io).code,
    "ambiguous/version-conflict",
    "explicit request contradicts the supplied project pin",
  );
  const aliasIO = macIO({ "6.1": { packer: "one-payload" }, "6.1.0": { packer: "other-payload" } });
  assert.equal(
    resolveToolchain({ required: ["packer"] }, aliasIO).code,
    "ambiguous/version-alias-conflict",
    "equal numeric versions contain different required bytes",
  );
  const linuxIO = toolchainIOFromTree({ platform: "linux", home: "/home/dev", env: {}, files: {} });
  assert.equal(
    resolveToolchain({ required: ["packer"] }, linuxIO).code,
    "unavailable/unsupported-default-root",
    "platform has no verified default root",
  );
  const conflictingProps = toolchainIOFromTree({
    platform: "darwin",
    home: "/fixture",
    files: {
      "/fixture/app/local.properties": { bytes: "spatial.tools.dir=/fixture/a\nspatial.tools.dir=/fixture/b\n" },
      "/fixture/a/6.1/editor/spatialbundle/spatialbundle": { bytes: "a", executable: true },
      "/fixture/b/6.1/editor/spatialbundle/spatialbundle": { bytes: "b", executable: true },
    },
  });
  const conflict = resolveToolchain({ androidProjectRoot: "/fixture/app", required: ["packer"] }, conflictingProps);
  assert.equal(conflict.status, "ambiguous");
  assert.equal(conflict.code, "ambiguous/property-conflict", "duplicate selection properties disagree");
});

// ------------------------------------------------------------------- selection

test("automatic selection needs every requested component in the same installation", () => {
  const io = briefIO();
  const both = resolveToolchain({ required: ["packer", "emulator"] }, io);
  assert.equal(both.status, "unavailable");
  assert.equal(both.code, "unavailable/component-missing");
  assert.equal(both.version, undefined, "a failed selection never names a version");
  assert.match(both.detail, /packer|emulator/);
  // The whole point: 6.1's packer must never be paired with 6.0's emulator.
  assert.doesNotMatch(both.detail, /^ok/);
  const packerOnly = resolveToolchain({ required: ["packer"] }, io);
  assert.equal(packerOnly.version, "6.1");
  const emulatorOnly = resolveToolchain({ required: ["emulator"] }, io);
  assert.equal(emulatorOnly.version, "6.0");
  assert.notEqual(packerOnly.identity, emulatorOnly.identity);
});

test("newest usable selection reports reason, root and root source", () => {
  const io = macIO({ "6.0": { packer: "old" }, "6.1": { packer: "new" } });
  const sel = resolveToolchain({ required: ["packer"] }, io);
  assert.equal(sel.status, "ok");
  assert.equal(sel.version, "6.1");
  assert.equal(sel.reason, "newest-usable");
  assert.equal(sel.root, MAC_ROOT);
  assert.equal(sel.rootSource, "default");
  assert.equal(sel.files.packer.path, `${MAC_ROOT}/6.1/editor/spatialbundle/spatialbundle`);
});

test("version ordering is numeric, so 6.10 outranks 6.9", () => {
  const io = macIO({ "6.9": { packer: "nine" }, "6.10": { packer: "ten" }, "6.2": { packer: "two" } });
  assert.equal(resolveToolchain({ required: ["packer"] }, io).version, "6.10");
});

test("newest usable skips newer installs that lack the requested component", () => {
  const io = macIO({ "6.0": { packer: "old", emulator: "old-emu" }, "6.1": { packer: "new" } });
  assert.equal(resolveToolchain({ required: ["packer"] }, io).version, "6.1");
  assert.equal(resolveToolchain({ required: ["emulator"] }, io).version, "6.0");
  assert.equal(resolveToolchain({ required: ["packer", "emulator"] }, io).version, "6.0");
});

test("explicit versions and project pins fail closed instead of falling back", () => {
  const io = briefIO();
  const explicit = resolveToolchain({ toolsVersion: "6.0", required: ["packer"] }, io);
  assert.equal(explicit.code, "unavailable/component-missing");
  const pinned = resolveToolchain({ projectToolsVersion: "6.0", required: ["packer"] }, io);
  assert.equal(pinned.code, "unavailable/component-missing", "a pin never degrades into newest-usable");
  const pinnedOk = resolveToolchain({ projectToolsVersion: "6.0", required: ["emulator"] }, io);
  assert.equal(pinnedOk.status, "ok");
  assert.equal(pinnedOk.version, "6.0");
  assert.equal(pinnedOk.reason, "project-pin");
  const explicitOk = resolveToolchain({ toolsVersion: "6.1", required: ["packer"] }, io);
  assert.equal(explicitOk.reason, "explicit");
  const agreeing = resolveToolchain({ toolsVersion: "6.1", projectToolsVersion: "6.1", required: ["packer"] }, io);
  assert.equal(agreeing.status, "ok");
  assert.equal(agreeing.reason, "explicit", "an explicit request that matches the pin is not a conflict");
});

test("all four components resolve from their documented subdirectories", () => {
  const io = macIO({ "6.1": { packer: "p", emulator: "e", adb: "a", proto: "syntax = proto3;" } });
  const sel = resolveToolchain({ required: ["packer", "emulator", "adb", "proto"] }, io);
  assert.equal(sel.status, "ok");
  assert.equal(sel.files.packer.path, `${MAC_ROOT}/6.1/editor/spatialbundle/spatialbundle`);
  assert.equal(sel.files.emulator.path, `${MAC_ROOT}/6.1/emulator/emulator`);
  assert.equal(sel.files.adb.path, `${MAC_ROOT}/6.1/emulator/system-images/platform-tools/adb`);
  assert.equal(sel.files.proto.path, `${MAC_ROOT}/6.1/emulator/lib/emulator_controller.proto`);
});

test("a non-executable payload does not satisfy an executable component", () => {
  const io = toolchainIOFromTree({
    platform: "darwin",
    home: "/fixture",
    files: { [`${MAC_ROOT}/6.1/editor/spatialbundle/spatialbundle`]: { bytes: "not chmod +x", executable: false } },
  });
  assert.equal(resolveToolchain({ required: ["packer"] }, io).code, "unavailable/component-missing");
});

// ------------------------------------------------------------ version tokens

test("version tokens must be two- or three-part numerals; everything else is rejected", () => {
  const io = briefIO();
  for (const bad of ["6", "v6.1", "6.1.2.3", "../6.1", "6.1/", "6.1\\", "6 .1", "6.1\n", "6.x", "latest", "6..1", " 6.1", "6.1 ", "   "]) {
    const sel = resolveToolchain({ toolsVersion: bad, required: ["packer"] }, io);
    assert.equal(sel.status, "unavailable", `token ${JSON.stringify(bad)} must not select anything`);
    assert.equal(sel.code, "unavailable/version-missing", `token ${JSON.stringify(bad)}`);
  }
  assert.equal(resolveToolchain({ toolsVersion: "", required: ["packer"] }, io).version, "6.1", "an empty string is not a pin");
  assert.equal(resolveToolchain({ projectToolsVersion: "", required: ["packer"] }, io).reason, "newest-usable");
});

test("directory entries that are not valid version labels are skipped, never traversed", () => {
  const io = toolchainIOFromTree({
    platform: "darwin",
    home: "/fixture",
    files: {
      [`${MAC_ROOT}/licenses/pico-spatial-tools-license`]: { bytes: "accepted" },
      [`${MAC_ROOT}/6.1-beta/editor/spatialbundle/spatialbundle`]: { bytes: "beta", executable: true },
      [`${MAC_ROOT}/6.0/editor/spatialbundle/spatialbundle`]: { bytes: "stable", executable: true },
    },
  });
  const sel = resolveToolchain({ required: ["packer"] }, io);
  assert.equal(sel.version, "6.0");
  assert.equal(resolveToolchain({ toolsVersion: "6.1-beta", required: ["packer"] }, io).code, "unavailable/version-missing");
});

// --------------------------------------------------- unreadable / missing trees

test("missing, empty and unreadable trees produce structured unavailable results", () => {
  const empty = toolchainIOFromTree({ platform: "darwin", home: "/fixture", dirs: [MAC_ROOT] });
  const emptySel = resolveToolchain({ required: ["packer"] }, empty);
  assert.equal(emptySel.code, "unavailable/version-missing");
  assert.match(emptySel.detail, /no toolchain versions/i);

  const absent = toolchainIOFromTree({ platform: "darwin", home: "/fixture" });
  assert.equal(resolveToolchain({ required: ["packer"] }, absent).code, "unavailable/root-unavailable");

  const locked = toolchainIOFromTree({ platform: "darwin", home: "/fixture", dirs: [MAC_ROOT], unreadable: [MAC_ROOT] });
  assert.equal(resolveToolchain({ required: ["packer"] }, locked).code, "unavailable/root-unavailable");

  const noComponents = macIO({ "6.1": { proto: "syntax" } });
  const noComponentsSel = resolveToolchain({ required: ["packer"] }, noComponents);
  assert.equal(noComponentsSel.code, "unavailable/component-missing");
});

test("a non-directory or unreadable version entry is not a usable installation", () => {
  const io = toolchainIOFromTree({
    platform: "darwin",
    home: "/fixture",
    files: {
      [`${MAC_ROOT}/6.2`]: { bytes: "a stray file that looks like a version" },
      [`${MAC_ROOT}/6.3/editor/spatialbundle/spatialbundle`]: { bytes: "locked", executable: true },
      [`${MAC_ROOT}/6.0/editor/spatialbundle/spatialbundle`]: { bytes: "fine", executable: true },
    },
    unreadable: [`${MAC_ROOT}/6.3`],
  });
  assert.equal(resolveToolchain({ required: ["packer"] }, io).version, "6.0");
  assert.equal(resolveToolchain({ toolsVersion: "6.2", required: ["packer"] }, io).code, "unavailable/version-missing");
  assert.equal(resolveToolchain({ toolsVersion: "6.3", required: ["packer"] }, io).code, "unavailable/version-missing");
});

// ----------------------------------------------------------------- root order

test("root resolution order is explicit -> local.properties -> PICO_HOME -> platform default", () => {
  const files = {
    "/fixture/app/local.properties": { bytes: "spatial.tools.dir=/fixture/from-properties\n" },
    "/fixture/explicit/6.1/editor/spatialbundle/spatialbundle": { bytes: "explicit", executable: true },
    "/fixture/from-properties/6.1/editor/spatialbundle/spatialbundle": { bytes: "properties", executable: true },
    "/fixture/from-env/6.1/editor/spatialbundle/spatialbundle": { bytes: "env", executable: true },
    [`${MAC_ROOT}/6.1/editor/spatialbundle/spatialbundle`]: { bytes: "default", executable: true },
  };
  const io = () => toolchainIOFromTree({ platform: "darwin", home: "/fixture", env: { PICO_HOME: "/fixture/from-env" }, files });

  const explicit = resolveToolchain({ toolsRoot: "/fixture/explicit", androidProjectRoot: "/fixture/app", required: ["packer"] }, io());
  assert.equal(explicit.rootSource, "explicit");
  assert.equal(explicit.root, "/fixture/explicit");

  const fromProperties = resolveToolchain({ androidProjectRoot: "/fixture/app", required: ["packer"] }, io());
  assert.equal(fromProperties.rootSource, "local.properties");
  assert.equal(fromProperties.root, "/fixture/from-properties");

  const fromEnv = resolveToolchain({ required: ["packer"] }, io());
  assert.equal(fromEnv.rootSource, "PICO_HOME");
  assert.equal(fromEnv.root, "/fixture/from-env");

  const noEnv = toolchainIOFromTree({ platform: "darwin", home: "/fixture", env: {}, files });
  const fromDefault = resolveToolchain({ required: ["packer"] }, noEnv);
  assert.equal(fromDefault.rootSource, "default");
  assert.equal(fromDefault.root, MAC_ROOT);

  const blankEnv = toolchainIOFromTree({ platform: "darwin", home: "/fixture", env: { PICO_HOME: "   " }, files });
  assert.equal(resolveToolchain({ required: ["packer"] }, blankEnv).rootSource, "default", "a blank PICO_HOME is not a declaration");
});

test("a declared root that cannot be listed fails closed instead of walking down the chain", () => {
  const files = {
    "/fixture/app/local.properties": { bytes: "spatial.tools.dir=/fixture/gone\n" },
    "/fixture/from-env/6.1/editor/spatialbundle/spatialbundle": { bytes: "env", executable: true },
    [`${MAC_ROOT}/6.1/editor/spatialbundle/spatialbundle`]: { bytes: "default", executable: true },
  };
  const io = toolchainIOFromTree({ platform: "darwin", home: "/fixture", env: { PICO_HOME: "/fixture/from-env" }, files });
  const fromProperties = resolveToolchain({ androidProjectRoot: "/fixture/app", required: ["packer"] }, io);
  assert.equal(fromProperties.code, "unavailable/root-unavailable");
  assert.match(fromProperties.detail, /local\.properties/);

  const envGone = toolchainIOFromTree({ platform: "darwin", home: "/fixture", env: { PICO_HOME: "/fixture/gone" }, files });
  const fromEnv = resolveToolchain({ required: ["packer"] }, envGone);
  assert.equal(fromEnv.code, "unavailable/root-unavailable");
  assert.match(fromEnv.detail, /PICO_HOME/);
});

test("a project with no local.properties or no selection property continues down the chain", () => {
  const files = {
    "/fixture/app/local.properties": { bytes: "sdk.dir=/fixture/android\n# spatial.tools.dir=/fixture/commented-out\n" },
    "/fixture/from-env/6.1/editor/spatialbundle/spatialbundle": { bytes: "env", executable: true },
  };
  const io = toolchainIOFromTree({ platform: "darwin", home: "/fixture", env: { PICO_HOME: "/fixture/from-env" }, files });
  assert.equal(resolveToolchain({ androidProjectRoot: "/fixture/app", required: ["packer"] }, io).rootSource, "PICO_HOME");
  assert.equal(resolveToolchain({ androidProjectRoot: "/fixture/no-such-project", required: ["packer"] }, io).rootSource, "PICO_HOME");
});

// --------------------------------------------------------- java .properties

test("local.properties parsing follows java.util.Properties escapes and continuations", () => {
  const cases = [
    ["spatial.tools.dir=/fixture/tools\n", "/fixture/tools"],
    ["spatial.tools.dir:/fixture/tools\n", "/fixture/tools"],
    ["spatial.tools.dir /fixture/tools\n", "/fixture/tools"],
    ["   spatial.tools.dir   =    /fixture/tools\n", "/fixture/tools"],
    ["# comment\n! bang comment\nspatial.tools.dir=/fixture/tools\n", "/fixture/tools"],
    ["spatial.tools.dir=/fixture/to\\\n      ols\n", "/fixture/tools"],
    ["spatial.tools.dir=/fixture/with\\ space/tools\n", "/fixture/with space/tools"],
    ["spatial.tools.dir=/fixture/\\u0074ools\n", "/fixture/tools"],
    ["spatial\\.tools\\.dir=/fixture/tools\n", "/fixture/tools"],
    ["spatial.tools.dir=/fixture/tools\r\nsdk.dir=/x\r\n", "/fixture/tools"],
    ["spatial.tools.dir=/fixture/tools   \n", "/fixture/tools"],
  ];
  for (const [text, expected] of cases) {
    const io = toolchainIOFromTree({
      platform: "darwin",
      home: "/fixture",
      files: {
        "/fixture/app/local.properties": { bytes: text },
        "/fixture/with space/tools/6.1/editor/spatialbundle/spatialbundle": { bytes: "s", executable: true },
        "/fixture/tools/6.1/editor/spatialbundle/spatialbundle": { bytes: "t", executable: true },
      },
    });
    const sel = resolveToolchain({ androidProjectRoot: "/fixture/app", required: ["packer"] }, io);
    assert.equal(sel.status, "ok", `${JSON.stringify(text)} -> ${sel.code ?? "ok"}`);
    assert.equal(sel.root, expected, JSON.stringify(text));
    assert.equal(sel.rootSource, "local.properties");
  }
});

test("escaped colons and backslashes carry a Windows root through local.properties", () => {
  const io = toolchainIOFromTree({
    platform: "win32",
    home: "C:\\Users\\dev",
    files: {
      "C:\\app\\local.properties": { bytes: String.raw`spatial.tools.dir=C\:\\PICO SDK\\sdk` + "\n" },
      "C:\\PICO SDK\\sdk\\6.1\\editor\\spatialbundle\\spatialbundle.exe": { bytes: "p", executable: true },
    },
  });
  const sel = resolveToolchain({ androidProjectRoot: "C:\\app", required: ["packer"] }, io);
  assert.equal(sel.status, "ok", sel.detail);
  assert.equal(sel.root, "C:\\PICO SDK\\sdk");
});

test("a relative selection property resolves against the android project root", () => {
  const io = toolchainIOFromTree({
    platform: "darwin",
    home: "/fixture",
    files: {
      "/fixture/app/local.properties": { bytes: "spatial.tools.dir=../vendor/pico-sdk\n" },
      "/fixture/vendor/pico-sdk/6.1/editor/spatialbundle/spatialbundle": { bytes: "p", executable: true },
    },
  });
  const sel = resolveToolchain({ androidProjectRoot: "/fixture/app", required: ["packer"] }, io);
  assert.equal(sel.status, "ok", sel.detail);
  assert.equal(sel.root, "/fixture/vendor/pico-sdk");
});

test("a tilde selection property expands against the io home", () => {
  const io = toolchainIOFromTree({
    platform: "darwin",
    home: "/fixture/home",
    files: {
      "/fixture/app/local.properties": { bytes: "spatial.tools.dir=~/pico/sdk\n" },
      "/fixture/home/pico/sdk/6.1/editor/spatialbundle/spatialbundle": { bytes: "p", executable: true },
    },
  });
  assert.equal(resolveToolchain({ androidProjectRoot: "/fixture/app", required: ["packer"] }, io).root, "/fixture/home/pico/sdk");
});

test("duplicate selection properties conflict only when the values disagree", () => {
  const agree = toolchainIOFromTree({
    platform: "darwin",
    home: "/fixture",
    files: {
      "/fixture/app/local.properties": { bytes: "spatial.tools.dir=/fixture/tools\nsdk.dir=/x\nspatial.tools.dir=/fixture/tools\n" },
      "/fixture/tools/6.1/editor/spatialbundle/spatialbundle": { bytes: "p", executable: true },
    },
  });
  const ok = resolveToolchain({ androidProjectRoot: "/fixture/app", required: ["packer"] }, agree);
  assert.equal(ok.status, "ok", ok.detail);
  assert.equal(ok.root, "/fixture/tools");

  const disagree = toolchainIOFromTree({
    platform: "darwin",
    home: "/fixture",
    files: {
      "/fixture/app/local.properties": { bytes: "spatial.tools.dir=/fixture/tools\nspatial.tools.dir=/fixture/other\n" },
      "/fixture/tools/6.1/editor/spatialbundle/spatialbundle": { bytes: "p", executable: true },
      "/fixture/other/6.1/editor/spatialbundle/spatialbundle": { bytes: "p", executable: true },
    },
  });
  const conflict = resolveToolchain({ androidProjectRoot: "/fixture/app", required: ["packer"] }, disagree);
  assert.equal(conflict.code, "ambiguous/property-conflict");
  assert.match(conflict.detail, /spatial\.tools\.dir/);
});

// ---------------------------------------------------------- aliases & payloads

test("equal numeric versions with different required bytes are ambiguous", () => {
  const io = macIO({ "6.1": { packer: "payload-a" }, "6.1.0": { packer: "payload-b" } });
  const auto = resolveToolchain({ required: ["packer"] }, io);
  assert.equal(auto.status, "ambiguous");
  assert.equal(auto.code, "ambiguous/version-alias-conflict");
  assert.match(auto.detail, /6\.1/);
});

test("an exact directory name disambiguates equal numeric versions", () => {
  const io = macIO({ "6.1": { packer: "payload-a" }, "6.1.0": { packer: "payload-b" } });
  const exact = resolveToolchain({ toolsVersion: "6.1.0", required: ["packer"] }, io);
  assert.equal(exact.status, "ok", exact.detail);
  assert.equal(exact.version, "6.1.0");
  assert.equal(exact.files.packer.path, `${MAC_ROOT}/6.1.0/editor/spatialbundle/spatialbundle`);
  const other = resolveToolchain({ toolsVersion: "6.1", required: ["packer"] }, io);
  assert.equal(other.version, "6.1");
  assert.notEqual(exact.identity, other.identity);
});

test("an alias directory pointing at the same payload is not a conflict", () => {
  const io = toolchainIOFromTree({
    platform: "darwin",
    home: "/fixture",
    files: { [`${MAC_ROOT}/6.1.0/editor/spatialbundle/spatialbundle`]: { bytes: "one-payload", executable: true } },
    dirs: [`${MAC_ROOT}/6.1`],
    symlinks: { [`${MAC_ROOT}/6.1`]: `${MAC_ROOT}/6.1.0` },
  });
  assert.deepEqual(io.entries(MAC_ROOT), ["6.1", "6.1.0"]);
  const sel = resolveToolchain({ required: ["packer"] }, io);
  assert.equal(sel.status, "ok", sel.detail);
  assert.equal(sel.version, "6.1", "the lexicographically first alias is selected deterministically");
});

test("component validity is judged before alias ambiguity", () => {
  // Leading zeros are legal numerals, so 06.1 and 6.1.0 are two spellings of one
  // numeric version and neither is an exact match for a request of "6.1".
  const io = macIO({ "06.1": { emulator: "shared" }, "6.1.0": { emulator: "shared" } });
  assert.equal(
    resolveToolchain({ toolsVersion: "6.1", required: ["packer"] }, io).code,
    "unavailable/component-missing",
    "neither spelling ships a packer, so this is not an ambiguity",
  );
  const ok = resolveToolchain({ toolsVersion: "6.1", required: ["emulator"] }, io);
  assert.equal(ok.status, "ok", ok.detail);
  assert.equal(ok.version, "06.1");
});

test("byte-identical copies of the same numeric version are not a conflict", () => {
  const io = macIO({ "6.1": { packer: "same" }, "6.1.0": { packer: "same" } });
  const sel = resolveToolchain({ required: ["packer"] }, io);
  assert.equal(sel.status, "ok", sel.detail);
  assert.equal(sel.version, "6.1");
});

// ------------------------------------------------------------------- platforms

test("executableNames appends .exe on win32 only", () => {
  assert.deepEqual(executableNames("adb", "win32"), ["adb.exe"]);
  assert.deepEqual(executableNames("emulator", "win32"), ["emulator.exe"]);
  assert.deepEqual(executableNames("spatialbundle", "win32"), ["spatialbundle.exe"]);
  for (const platform of ["darwin", "linux", "freebsd"]) {
    assert.deepEqual(executableNames("adb", platform), ["adb"]);
    assert.deepEqual(executableNames("emulator", platform), ["emulator"]);
    assert.deepEqual(executableNames("spatialbundle", platform), ["spatialbundle"]);
  }
});

test("an explicit Windows drive root selects .exe payloads", () => {
  const io = toolchainIOFromTree({
    platform: "win32",
    home: "C:\\Users\\dev",
    files: {
      "C:\\PICO\\sdk\\6.1\\editor\\spatialbundle\\spatialbundle.exe": { bytes: "p", executable: true },
      "C:\\PICO\\sdk\\6.1\\emulator\\emulator.exe": { bytes: "e", executable: true },
      "C:\\PICO\\sdk\\6.1\\emulator\\system-images\\platform-tools\\adb.exe": { bytes: "a", executable: true },
      "C:\\PICO\\sdk\\6.1\\emulator\\lib\\emulator_controller.proto": { bytes: "syntax" },
    },
  });
  const sel = resolveToolchain({ toolsRoot: "C:\\PICO\\sdk", required: ["packer", "emulator", "adb", "proto"] }, io);
  assert.equal(sel.status, "ok", sel.detail);
  assert.equal(sel.rootSource, "explicit");
  assert.equal(sel.files.adb.path, "C:\\PICO\\sdk\\6.1\\emulator\\system-images\\platform-tools\\adb.exe");
  assert.equal(sel.files.packer.path, "C:\\PICO\\sdk\\6.1\\editor\\spatialbundle\\spatialbundle.exe");
});

test("a Windows tree with extensionless binaries does not satisfy win32 components", () => {
  const io = toolchainIOFromTree({
    platform: "win32",
    home: "C:\\Users\\dev",
    files: { "C:\\PICO\\sdk\\6.1\\emulator\\emulator": { bytes: "e", executable: true } },
  });
  assert.equal(resolveToolchain({ toolsRoot: "C:\\PICO\\sdk", required: ["emulator"] }, io).code, "unavailable/component-missing");
});

test("an explicit UNC root resolves", () => {
  const io = toolchainIOFromTree({
    platform: "win32",
    home: "C:\\Users\\dev",
    files: { "\\\\build-share\\pico\\sdk\\6.1\\emulator\\emulator.exe": { bytes: "e", executable: true } },
  });
  const sel = resolveToolchain({ toolsRoot: "\\\\build-share\\pico\\sdk", required: ["emulator"] }, io);
  assert.equal(sel.status, "ok", sel.detail);
  assert.equal(sel.root, "\\\\build-share\\pico\\sdk");
  assert.equal(sel.files.emulator.path, "\\\\build-share\\pico\\sdk\\6.1\\emulator\\emulator.exe");
});

test("Windows environment keys are matched case-insensitively", () => {
  const io = toolchainIOFromTree({
    platform: "win32",
    home: "C:\\Users\\dev",
    env: { Pico_Home: "C:\\PICO\\sdk" },
    files: { "C:\\PICO\\sdk\\6.1\\emulator\\emulator.exe": { bytes: "e", executable: true } },
  });
  const sel = resolveToolchain({ required: ["emulator"] }, io);
  assert.equal(sel.status, "ok", sel.detail);
  assert.equal(sel.rootSource, "PICO_HOME");
  const posix = toolchainIOFromTree({
    platform: "linux",
    home: "/home/dev",
    env: { Pico_Home: "/opt/pico/sdk" },
    files: { "/opt/pico/sdk/6.1/emulator/emulator": { bytes: "e", executable: true } },
  });
  assert.equal(resolveToolchain({ required: ["emulator"] }, posix).code, "unavailable/unsupported-default-root", "posix env keys stay case-sensitive");
});

test("an explicit Linux root works even though Linux has no documented default", () => {
  const io = toolchainIOFromTree({
    platform: "linux",
    home: "/home/dev",
    files: { "/opt/pico/sdk/6.1/emulator/emulator": { bytes: "e", executable: true } },
  });
  const sel = resolveToolchain({ toolsRoot: "/opt/pico/sdk", required: ["emulator"] }, io);
  assert.equal(sel.status, "ok", sel.detail);
  assert.equal(sel.rootSource, "explicit");
});

test("platforms with no verified default root never invent one", () => {
  for (const platform of ["linux", "win32", "freebsd"]) {
    const io = toolchainIOFromTree({ platform, home: platform === "win32" ? "C:\\Users\\dev" : "/home/dev", env: {}, files: {} });
    const sel = resolveToolchain({ required: ["packer"] }, io);
    assert.equal(sel.code, "unavailable/unsupported-default-root", platform);
    assert.doesNotMatch(sel.detail, /Library[\\/]PICO/, "no invented macOS path leaks into other platforms");
    assert.deepEqual(io.reads, [], "an unsupported default root probes nothing");
  }
});

test("roots and payload paths containing spaces resolve", () => {
  const io = toolchainIOFromTree({
    platform: "darwin",
    home: "/fixture",
    files: { "/fixture/Application Support/PICO sdk/6.1/editor/spatialbundle/spatialbundle": { bytes: "p", executable: true } },
  });
  const sel = resolveToolchain({ toolsRoot: "/fixture/Application Support/PICO sdk", required: ["packer"] }, io);
  assert.equal(sel.status, "ok", sel.detail);
  assert.equal(sel.files.packer.path, "/fixture/Application Support/PICO sdk/6.1/editor/spatialbundle/spatialbundle");
});

// -------------------------------------------------------------------- identity

test("identity covers exactly the selected required payloads", () => {
  const io = macIO({ "6.1": { packer: "p", emulator: "e", adb: "a", proto: "syntax" } });
  const sel = resolveToolchain({ required: ["packer"] }, io);
  assert.equal(sel.status, "ok", sel.detail);
  assert.deepEqual(Object.keys(sel.files), ["packer"]);
  assert.deepEqual(io.reads, [`${MAC_ROOT}/6.1/editor/spatialbundle/spatialbundle`], "only the required payload is hashed");
  assert.match(sel.identity, /^[0-9a-f]{64}$/);
  assert.match(sel.files.packer.sha256, /^[0-9a-f]{64}$/);
});

test("identity is deterministic, content-sensitive and independent of the root path", () => {
  const first = resolveToolchain({ required: ["packer", "emulator"] }, macIO({ "6.1": { packer: "p", emulator: "e" } }));
  const again = resolveToolchain({ required: ["packer", "emulator"] }, macIO({ "6.1": { packer: "p", emulator: "e" } }));
  assert.equal(first.identity, again.identity);

  const reordered = resolveToolchain({ required: ["emulator", "packer"] }, macIO({ "6.1": { packer: "p", emulator: "e" } }));
  assert.equal(first.identity, reordered.identity, "required order does not change identity");

  const changed = resolveToolchain({ required: ["packer", "emulator"] }, macIO({ "6.1": { packer: "p2", emulator: "e" } }));
  assert.notEqual(first.identity, changed.identity);

  const fewer = resolveToolchain({ required: ["packer"] }, macIO({ "6.1": { packer: "p", emulator: "e" } }));
  assert.notEqual(first.identity, fewer.identity);

  const elsewhere = toolchainIOFromTree({
    platform: "darwin",
    home: "/fixture",
    files: {
      "/elsewhere/sdk/6.1/editor/spatialbundle/spatialbundle": { bytes: "p", executable: true },
      "/elsewhere/sdk/6.1/emulator/emulator": { bytes: "e", executable: true },
    },
  });
  const relocated = resolveToolchain({ toolsRoot: "/elsewhere/sdk", required: ["packer", "emulator"] }, elsewhere);
  assert.equal(relocated.identity, first.identity, "identity is relative to the root, so a moved install keeps it");
});

// ---------------------------------------------------------------------- purity

test("the selection module performs no filesystem, subprocess or registry work of its own", () => {
  const source = fs.readFileSync(path.join(here, "..", "src", "toolchainselection.ts"), "utf8");
  for (const forbidden of ["child_process", "node:fs", "node:os", "node:http", "node:https", "fetch(", "execSync", "spawnSync"]) {
    assert.equal(source.includes(forbidden), false, `src/toolchainselection.ts must not reference ${forbidden}`);
  }
});

// ------------------------------------------------------------- legacy adapters

test("legacy adapters are component-aware and keep their shape", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico-toolchain-s1-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel, bytes, mode) => {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { mode });
  };
  write("6.1/editor/spatialbundle/spatialbundle", "packer-6.1", 0o755);
  write("6.0/emulator/emulator", "emulator-6.0", 0o755);

  return import("../dist/toolchain.js").then(({ listVersions, pickVersion, resolveToolsRoot }) => {
    const versions = listVersions(root);
    assert.deepEqual(versions.map((v) => v.version), ["6.0", "6.1"]);
    assert.equal(versions[1].spatialbundle, path.join(root, "6.1/editor/spatialbundle/spatialbundle"));
    assert.equal(versions[1].emulatorBin, null);
    assert.equal(versions[1].hasEditor, true);
    assert.equal(versions[1].hasEmulator, false);
    assert.equal(versions[0].emulatorBin, path.join(root, "6.0/emulator/emulator"));

    // The regression: a requested version that lacks the requested component is not a hit.
    assert.equal(pickVersion(root, "6.1", "emulator"), null, "6.1 ships no emulator payload");
    assert.equal(pickVersion(root, "6.0", "editor"), null, "6.0 ships no packer payload");
    assert.equal(pickVersion(root, "6.1", "editor").version, "6.1");
    assert.equal(pickVersion(root, "6.0", "emulator").version, "6.0");
    assert.equal(pickVersion(root, undefined, "editor").version, "6.1");
    assert.equal(pickVersion(root, undefined, "emulator").version, "6.0");
    assert.equal(pickVersion(root, undefined, "any").version, "6.1");
    assert.equal(pickVersion(path.join(root, "nope"), undefined, "any"), null);
    assert.equal(pickVersion("", undefined, "any"), null, "an empty root never falls back to the root order");

    const savedHome = process.env.PICO_HOME;
    try {
      delete process.env.PICO_HOME;
      const project = path.join(root, "project");
      fs.mkdirSync(project, { recursive: true });
      fs.writeFileSync(path.join(project, "local.properties"), `spatial.tools.dir=${root}\n`);
      assert.deepEqual(resolveToolsRoot(project), { root, source: "local.properties" });
      process.env.PICO_HOME = root;
      assert.deepEqual(resolveToolsRoot(), { root, source: "PICO_HOME" });
      delete process.env.PICO_HOME;
      assert.equal(resolveToolsRoot().source, "default");
    } finally {
      if (savedHome === undefined) delete process.env.PICO_HOME;
      else process.env.PICO_HOME = savedHome;
    }
  });
});
