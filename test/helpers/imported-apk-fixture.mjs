import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Real 919-byte unsigned APK, compiled with aapt2 from a minimal application manifest.
// Only the external aapt2 process is substituted, using its retained output for these bytes.
const APK_BASE64 = "UEsDBAAAAAAIAAAAIQBoUSRdfQIAACQHAAATAAAAQW5kcm9pZE1hbmlmZXN0LnhtbJVUu24TQRQ947XjTWwndkiCQRRIuELKRkggRXQhQgpSSMGrN34Ey4+svJuQUKVEVIhPoOAzKKmpKPkARMEHIMG5d8evJQN4V2dm9syZ+9q768FHLQ8YXMN3D7iCyXU+tS4S14mAeEK8IT4Sn4gvxDfiJ3HbAKfEO+ID8ZX4QexlgDbxinhLvCc+E1n63CayGKCOPlq04XM8RYgjDBFz3SSXwwn3ezhWRQUN7vap6ZBr4TE1XTzjaoiI3BGtSS7/Vu1ybJKZeK8yx5D6On23NYY+mX0+H1PVwAvscIx5/oSIccYzGdzCHc4LVCV7SQT++HmizZMb0OeQmo7mdjXFBBwHmrmMwYzNAA/p/wEO9H38/VxDc2jhULM40yx28JRnd7GH+3hEGwVqQs23Y/WT2NPnJdKkogErIxVtqZ8ILzWSPs9G48rG5J6rSnKWGre1hj3uADdZx5h3iLvY4h1pZVu0Uec6+COzxO+WRtvlPKQ20ufZWpZmarBJnx31KO9ccurriQ55OS+RLOp7l2g3aaGuK4k41Lp3OR5qDuvaRxKHZBzaWklPBmop0QU2jup/qiPtip7tvHTf3WO9JP6mo2vnOXMw7vBz4/NrBzwYUyZqxDBnTESATBXyPwB+8VrkXJYOJ/96ipdrles13jn7jyirzWTf5+MNy2X1y5Dqw1uw+2ucly23bLnLqbOyrk5xKzaOWiqOoo1jdIlmP6W5ZDWZqVihbzWJYX2UJ7FiOZm9VD1GtubxsWHtbUz5GOVk5vThO3zkrI+c5czEx6rMF9WtckHdtlOavNWYlL8l62/JEX/eYa/ksFew9goOeyUHX3HwvoMvOnjpZePo/d9QSwMEAAAAAAAAAAAhAAtQNhMoAAAAKAAAAA4AAgByZXNvdXJjZXMuYXJzYwAAAgAMACgAAAAAAAAAAQAcABwAAAAAAAAAAAAAAAABAAAcAAAAAAAAAFBLAQIAAAAAAAAIAAAAIQBoUSRdfQIAACQHAAATAAAAAAAAAAAAAAAAAAAAAABBbmRyb2lkTWFuaWZlc3QueG1sUEsBAgAAAAAAAAAAAAAhAAtQNhMoAAAAKAAAAA4AAAAAAAAAAAAAAAAArgIAAHJlc291cmNlcy5hcnNjUEsFBgAAAAACAAIAfQAAAAQDAAAAAA==";
export const IMPORTED_MANIFEST_DUMP = "N: android=http://schemas.android.com/apk/res/android (line=1)\n  E: manifest (line=1)\n    A: http://schemas.android.com/apk/res/android:compileSdkVersion(0x01010572)=35\n    A: http://schemas.android.com/apk/res/android:compileSdkVersionCodename(0x01010573)=\"15\" (Raw: \"15\")\n    A: package=\"com.fleet.swanmissiontable\" (Raw: \"com.fleet.swanmissiontable\")\n    A: platformBuildVersionCode=35\n    A: platformBuildVersionName=15\n      E: application (line=1)\n          E: meta-data (line=1)\n            A: http://schemas.android.com/apk/res/android:name(0x01010003)=\"pico.spatial.stage.id\" (Raw: \"pico.spatial.stage.id\")\n            A: http://schemas.android.com/apk/res/android:value(0x01010024)=\"default\" (Raw: \"default\")\n          E: meta-data (line=1)\n            A: http://schemas.android.com/apk/res/android:name(0x01010003)=\"pico.spatial.stage.style\" (Raw: \"pico.spatial.stage.style\")\n            A: http://schemas.android.com/apk/res/android:value(0x01010024)=1\n          E: activity (line=1)\n            A: http://schemas.android.com/apk/res/android:name(0x01010003)=\".platform.LaunchActivity\" (Raw: \".platform.LaunchActivity\")\n            A: http://schemas.android.com/apk/res/android:exported(0x01010010)=true\n              E: intent-filter (line=1)\n                  E: action (line=1)\n                    A: http://schemas.android.com/apk/res/android:name(0x01010003)=\"android.intent.action.MAIN\" (Raw: \"android.intent.action.MAIN\")\n                  E: category (line=1)\n                    A: http://schemas.android.com/apk/res/android:name(0x01010003)=\"android.intent.category.LAUNCHER\" (Raw: \"android.intent.category.LAUNCHER\")\n";
export const IMPORTED_PACKAGE = "com.fleet.swanmissiontable";
export function importedApkFixture(t, { manifestDump = IMPORTED_MANIFEST_DUMP } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pico-imported-apk-"));
  const apkPath = path.join(root, "hand-built.apk");
  fs.writeFileSync(apkPath, Buffer.from(APK_BASE64, "base64"));
  const sdk = path.join(root, "sdk");
  const tools = path.join(sdk, "build-tools", "35.0.0");
  fs.mkdirSync(tools, { recursive: true });
  const aapt2 = path.join(tools, process.platform === "win32" ? "aapt2.exe" : "aapt2");
  fs.writeFileSync(aapt2, `#!/usr/bin/env node
const expected = ${JSON.stringify(["dump", "xmltree", "--file", "AndroidManifest.xml", apkPath])};
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(23);
process.stdout.write(${JSON.stringify(manifestDump)});
`);
  fs.chmodSync(aapt2, 0o755);
  const previous = { ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT, ANDROID_HOME: process.env.ANDROID_HOME };
  process.env.ANDROID_SDK_ROOT = sdk;
  process.env.ANDROID_HOME = sdk;
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const provenance = {
    kind: "imported_apk",
    apkPath,
    apkSha256: crypto.createHash("sha256").update(fs.readFileSync(apkPath)).digest("hex"),
    packageName: IMPORTED_PACKAGE,
    declaredStageStyle: "1",
  };
  return {
    root,
    provenance,
    receipt: {
      ...provenance,
      evidenceCeiling: "structural",
      manifestInspection: {
        tool: "aapt2",
        manifestPath: "AndroidManifest.xml",
        packageName: IMPORTED_PACKAGE,
        declaredStageStyle: "1",
        launchComponent: `${IMPORTED_PACKAGE}/.platform.LaunchActivity`,
        stageStyleSource: "application",
        manifestDumpSha256: crypto.createHash("sha256").update(manifestDump).digest("hex"),
      },
    },
  };
}

// Small retained-style aapt2 trees used to exercise manifest ownership, independently of SDK tools.
export function scopedImportedManifestDump({ appStyle, launchStyle, secondaryStyle, secondLauncher = false, launchNameResource = false, launchResource = false, noLauncher = false } = {}) {
  const attribute = (indent, name, value) => `${" ".repeat(indent)}A: http://schemas.android.com/apk/res/android:${name}=${value}`;
  const metadata = (indent, value) => value === undefined ? [] : [
    `${" ".repeat(indent)}E: meta-data (line=1)`,
    attribute(indent + 2, "name", '\"pico.spatial.stage.style\"'),
    attribute(indent + 2, "value", value),
  ];
  const launcher = (indent) => [
    `${" ".repeat(indent)}E: intent-filter (line=1)`,
    `${" ".repeat(indent + 2)}E: action (line=1)`,
    attribute(indent + 4, "name", '\"android.intent.action.MAIN\"'),
    `${" ".repeat(indent + 2)}E: category (line=1)`,
    attribute(indent + 4, "name", '\"android.intent.category.LAUNCHER\"'),
  ];
  return [
    "E: manifest (line=1)",
    `  A: package="${IMPORTED_PACKAGE}"`,
    "  E: application (line=1)",
    ...metadata(4, appStyle),
    "    E: activity (line=1)",
    attribute(6, "name", '\".platform.LaunchActivity\"'),
    ...metadata(6, launchStyle).map((line) => launchNameResource ? line.replace('name="pico.spatial.stage.style"', 'name=@0x7f010000') : line),
    ...(launchResource ? [attribute(8, "resource", "@0x7f010001")] : []),
    ...(noLauncher ? [] : launcher(6)),
    "    E: activity (line=1)",
    attribute(6, "name", '\".SecondaryActivity\"'),
    ...metadata(6, secondaryStyle),
    ...(secondLauncher ? launcher(6) : []),
  ].join("\n");
}
