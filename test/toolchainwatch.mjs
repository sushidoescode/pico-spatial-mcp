// check_toolchain_updates' verdict must COMPARE advertised payload versions with the installed
// components before calling anything "newer". At 38.0.0 it said "a newer 6.x runtime is publicly
// downloadable" whenever any public artifact name looked 6.x — on a host already on 6.1 with only
// 6.0.0 public payloads, that is an upgrade that does not exist (2026-09-16 native acceptance).
import test from "node:test";
import assert from "node:assert/strict";

const { compareVersions, parseArtifactVersion, toolchainUpdateVerdict } = await import("../dist/toolchainwatch.js");

test("compareVersions orders dotted versions numerically", () => {
  assert.ok(compareVersions("6.1.9", "6.1.0") > 0);
  assert.ok(compareVersions("6.1.0", "6.0.0") > 0);
  assert.ok(compareVersions("6.0.0", "0.13.6") > 0);
  assert.equal(compareVersions("6.1.0", "6.1.0"), 0);
  assert.ok(compareVersions("6.1", "6.1.0") === 0, "a missing component counts as zero");
  assert.ok(compareVersions("0.12.2", "6.1.9") < 0);
});

test("parseArtifactVersion reads a dotted version out of channel artifact names, and refuses to guess", () => {
  assert.equal(parseArtifactVersion("spatial_editor_20260729_v6.0.0_mac.zip"), "6.0.0");
  assert.equal(parseArtifactVersion("pico_emulator_20260729_v6.0.0_win.zip"), "6.0.0");
  assert.equal(parseArtifactVersion("pico_spatial_editor_20260910_v6.2.2_mac.zip"), "6.2.2");
  assert.equal(parseArtifactVersion("templates-6.1.0.zip"), "6.1.0");
  assert.equal(parseArtifactVersion("spatial_editor_0.11.2_0408_mac.zip"), "0.11.2");
  assert.equal(parseArtifactVersion("preview_spatial_editor_v.12.3_mac_0513.zip"), null, "'v.12.3' is not a three-part version");
  assert.equal(parseArtifactVersion("swan_spaceos_pico_emulator_mac_20260910_ide.zip"), null, "a date is not a version");
  assert.equal(parseArtifactVersion("spatial_editor_win_0619_064001.zip"), null);
});

const INSTALLED_61 = { emulator: "6.1.0", editor: "6.1.9", sdkMaven: "6.0.0" };
const PUBLIC_600 = [
  { name: "spatial_editor_20260729_v6.0.0_mac.zip", url: "x", public: true },
  { name: "pico_emulator_20260729_v6.0.0_mac.zip", url: "x", public: true },
  { name: "pico-spatial-profiler-0.0.8-release-mac-arm64.zip", url: "x", public: true },
];
const INTERNAL_62 = [
  { name: "pico_spatial_editor_20260910_v6.2.2_mac.zip", url: "x", public: false },
  { name: "swan_spaceos_pico_emulator_mac_20260910_ide.zip", url: "x", public: false },
  { name: "agent-vault-6.1.0.zip", url: "x", public: false },
];
const SDK_MAP = [{ osVersion: "6.0", spatialSDK: "6.0.0" }, { osVersion: "6.1", spatialSDK: "6.1.7" }, { osVersion: "6.2", spatialSDK: "6.2.1" }];

test("a host already on the 6.1 line with only 6.0.0 public payloads is told nothing public is newer, and which internal line is", () => {
  const v = toolchainUpdateVerdict({ installed: INSTALLED_61, publicNow: PUBLIC_600, stagedInternal: INTERNAL_62, sdkMap: SDK_MAP, mavenLatest: "6.1.9" });
  assert.equal(v.publicUpgradeAvailable, false);
  assert.doesNotMatch(v.verdict, /newer 6\.x runtime is publicly downloadable/i);
  assert.match(v.verdict, /not newer than the installed/i);
  assert.match(v.verdict, /editor 6\.1\.9/);
  assert.match(v.verdict, /emulator 6\.1\.0/);
  assert.match(v.verdict, /6\.2/, "the internal-only 6.2 line is named as advertised, not as installable");
  assert.match(v.verdict, /not downloadable from here/i);
  assert.match(v.verdict, /Maven SDK: 6\.1\.9/);
  const editor = v.comparisons.find((c) => c.name === "spatial_editor_20260729_v6.0.0_mac.zip");
  assert.deepEqual({ component: editor.component, version: editor.version, relation: editor.relation, source: editor.source },
    { component: "editor", version: "6.0.0", relation: "older-than-installed", source: "public" });
  const internal = v.comparisons.find((c) => c.name === "pico_spatial_editor_20260910_v6.2.2_mac.zip");
  assert.equal(internal.relation, "newer-than-installed");
  assert.equal(internal.source, "internal");
  assert.deepEqual(v.advertisedLines.map((l) => l.osVersion), ["6.2"], "only lines above the installed 6.1 line are 'advertised newer'");
});

test("a host on 6.0.0 with a public 6.1.0 emulator payload is told exactly what is newer", () => {
  const v = toolchainUpdateVerdict({
    installed: { emulator: "6.0.0", editor: "6.0.0", sdkMaven: "6.0.0" },
    publicNow: [{ name: "pico_emulator_20260910_v6.1.0_mac.zip", url: "x", public: true }, ...PUBLIC_600],
    stagedInternal: [], sdkMap: SDK_MAP, mavenLatest: "6.1.9",
  });
  assert.equal(v.publicUpgradeAvailable, true);
  assert.match(v.verdict, /newer/i);
  assert.match(v.verdict, /emulator 6\.1\.0/);
  assert.match(v.verdict, /installed 6\.0\.0/);
  assert.doesNotMatch(v.verdict, /editor 6\.0\.0 .*newer/i);
});

test("a 6.x-looking public payload whose version cannot be read is reported as uncomparable, never as newer", () => {
  const v = toolchainUpdateVerdict({
    installed: INSTALLED_61,
    publicNow: [{ name: "swan_spaceos_pico_emulator_mac_20260910_ide.zip", url: "x", public: true }],
    stagedInternal: [], sdkMap: [], mavenLatest: "6.1.9",
  });
  assert.equal(v.publicUpgradeAvailable, null);
  assert.match(v.verdict, /could not be compared/i);
  assert.doesNotMatch(v.verdict, /newer 6\.x runtime is publicly downloadable/i);
  assert.equal(v.comparisons[0].relation, "uncomparable");
});

test("nothing 6.x advertised anywhere → 'Nothing newer advertised' with the installed versions", () => {
  const v = toolchainUpdateVerdict({ installed: INSTALLED_61, publicNow: [{ name: "preview_spatial_editor_v.12.3_mac_0513.zip", url: "x", public: true }], stagedInternal: [], sdkMap: [{ osVersion: "0.13", spatialSDK: "0.13.6" }], mavenLatest: "6.1.9" });
  assert.equal(v.publicUpgradeAvailable, false);
  assert.match(v.verdict, /Nothing newer advertised/);
  assert.match(v.verdict, /editor 6\.1\.9/);
});

test("an unknown installed version makes every comparison uncomparable instead of silently older", () => {
  const v = toolchainUpdateVerdict({ installed: { emulator: "unknown", editor: "unknown", sdkMaven: "6.0.0" }, publicNow: PUBLIC_600, stagedInternal: [], sdkMap: SDK_MAP, mavenLatest: "6.1.9" });
  assert.equal(v.publicUpgradeAvailable, null);
  assert.ok(v.comparisons.filter((c) => c.component !== "other").every((c) => c.relation === "uncomparable"));
  assert.match(v.verdict, /could not be compared/i);
});
