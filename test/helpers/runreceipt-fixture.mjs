import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  canonicalIdentity,
  collectGradleInputIdentity,
  readAuthoredAppSpecIdentity,
} from "../../dist/runreceiptidentity.js";

export const FIXTURE_APP = "com.example.receipt";

export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    table[index] = crc >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const name = Buffer.from(type, "ascii");
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

export function makePng(shade = 48) {
  const width = 64;
  const height = 64;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  const raster = Buffer.alloc(height * (width + 1));
  for (let row = 0; row < height; row += 1) {
    raster.fill(shade, row * (width + 1) + 1, (row + 1) * (width + 1));
  }
  return Buffer.concat([
    signature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raster)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function writeFile(root, relativePath, contents) {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}

export const authoredSpec = (packageName = FIXTURE_APP) => ({
  meta: {
    appName: "ReceiptFixture",
    packageName,
    brief: "literal receipt fixture",
  },
  scenes: [{ id: "main", environment: { kind: "procedural" } }],
  navigation: { startScene: "main" },
});

export const effectiveSpec = (packageName = FIXTURE_APP) => ({
  meta: {
    appName: "ReceiptFixture",
    packageName,
    brief: "literal receipt fixture",
  },
  scenes: [{ id: "main", environment: { kind: "procedural" } }],
  navigation: { startScene: "main" },
  fleet: { semanticAnchorsResolved: true },
});

export async function createRunReceiptFixture(t, store, options = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pico-run-receipt-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const rootDir = path.join(scratch, "receipt-store");
  const ledgerDir = path.join(scratch, "ledger-store");
  const projectDir = path.join(scratch, "project");
  const briefPath = path.join(scratch, "brief.json");
  const packageName = options.app ?? FIXTURE_APP;

  writeFile(projectDir, "settings.gradle.kts", "rootProject.name = \"receipt-fixture\"\n");
  writeFile(projectDir, "build.gradle.kts", "plugins {}\n");
  writeFile(projectDir, "gradlew", "#!/bin/sh\n");
  writeFile(projectDir, "app/build.gradle.kts", `plugins { id(\"com.android.application\") }\nandroid { namespace = \"${packageName}\" }\n`);
  writeFile(projectDir, "gradle/wrapper/gradle-wrapper.properties", "distributionUrl=https://example.invalid/gradle.zip\n");
  writeFile(projectDir, "app/src/main/AndroidManifest.xml", `<manifest package=\"${packageName}\" />\n`);
  writeFile(projectDir, "app/src/main/java/com/example/MainActivity.kt", `package ${packageName}\nclass MainActivity\n`);
  writeFile(projectDir, "app/src/main/assets/scene.json", "{\"fixture\":true}\n");
  fs.writeFileSync(briefPath, JSON.stringify({ brief: "literal receipt fixture", spec: authoredSpec(packageName) }));

  const apkBytes = Buffer.from("PK\u0003\u0004bounded-apk-fixture-v1", "utf8");
  const sourceApkPath = writeFile(projectDir, "app/build/outputs/apk/debug/app-debug.apk", apkBytes);
  const outputMetadata = {
    version: 3,
    artifactType: { type: "APK", kind: "Directory" },
    applicationId: packageName,
    variantName: "debug",
    elements: [{ type: "SINGLE", versionCode: 1, versionName: "1.0", outputFile: "app-debug.apk" }],
  };
  const outputMetadataPath = writeFile(
    projectDir,
    "app/build/outputs/apk/debug/output-metadata.json",
    `${JSON.stringify(outputMetadata)}\n`,
  );

  const captureBytes = makePng(options.captureShade ?? 48);
  const captureSourcePath = path.join(scratch, "capture.png");
  fs.writeFileSync(captureSourcePath, captureBytes);
  const captureSha256 = sha256(captureBytes);
  const captureArtifactPath = path.join(ledgerDir, "artifacts", `${captureSha256}.png`);
  fs.mkdirSync(path.dirname(captureArtifactPath), { recursive: true });
  fs.writeFileSync(captureArtifactPath, captureBytes);

  const storeOptions = { rootDir, ledgerDir };
  const apk = await store.publishApkArtifact(sourceApkPath, storeOptions);
  const effective = effectiveSpec(packageName);
  const publishedSpec = store.publishEffectiveSpecArtifact(effective, storeOptions);
  const metadataBytes = fs.readFileSync(outputMetadataPath);
  const component = `${packageName}/.MainActivity`;
  const pid = 4242;
  const pidStartTicks = "987654321";
  const payload = {
    kind: "pico.native-run-receipt",
    schemaVersion: 1,
    createdAt: options.createdAt ?? "2026-08-14T12:00:00.000Z",
    scope: "fleet-native-debug",
    app: packageName,
    source: {
      authoredAppSpec: readAuthoredAppSpecIdentity(briefPath),
      effectiveAppSpec: publishedSpec,
      gradleInputs: collectGradleInputIdentity(projectDir),
    },
    build: {
      task: ":app:assembleDebug",
      outcome: "success",
      startedAt: "2026-08-14T11:59:00.000Z",
      finishedAt: "2026-08-14T11:59:30.000Z",
      outputMetadata: {
        path: fs.realpathSync(outputMetadataPath),
        sha256: sha256(metadataBytes),
        bytes: metadataBytes.length,
      },
    },
    apk: {
      ...apk,
      packageName,
      manifestInspection: {
        status: "inspected",
        tool: "aapt2",
        packageName,
        versionCode: "1",
        versionName: "1.0",
      },
      signingInspection: {
        status: "inspected",
        tool: "apksigner",
        certificateSha256: [sha256("fixture-debug-certificate")],
      },
    },
    install: {
      status: "success",
      method: "adb-install-replace",
      completedAt: "2026-08-14T11:59:40.000Z",
      packageName,
      remoteApkPath: `/data/app/${packageName}/base.apk`,
      remoteApkSha256: apk.sha256,
      acknowledgementSha256: sha256("Success\n"),
    },
    runtime: {
      sessionId: "11111111-2222-4333-8444-555555555555",
      serial: "emulator-5554",
      model: "PICO Emulator",
      fingerprint: "PICO/PICO_Emulator/PICO_Emulator:14/fixture/test-keys",
      bootQemu: "1",
      bootId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      component,
      launchedAt: "2026-08-14T11:59:45.000Z",
      launchAcknowledgementSha256: sha256("Starting: Intent fixture\n"),
      pid,
      pidStartTicks,
    },
    capture: {
      capturedAt: "2026-08-14T11:59:50.000Z",
      sourcePath: fs.realpathSync(captureSourcePath),
      artifactPath: captureArtifactPath,
      sha256: captureSha256,
      bytes: captureBytes.length,
      width: 64,
      height: 64,
      format: "png",
      before: {
        observedAt: "2026-08-14T11:59:49.000Z",
        foregroundPackage: packageName,
        foregroundComponent: component,
        pid,
        pidStartTicks,
      },
      after: {
        observedAt: "2026-08-14T11:59:51.000Z",
        foregroundPackage: packageName,
        foregroundComponent: component,
        pid,
        pidStartTicks,
      },
    },
  };

  return {
    scratch,
    rootDir,
    ledgerDir,
    projectDir,
    briefPath,
    sourceApkPath,
    outputMetadataPath,
    outputMetadata,
    apkBytes,
    captureBytes,
    captureSourcePath,
    captureArtifactPath,
    effectiveSpec: effective,
    publishedSpec,
    storeOptions,
    payload,
    effectiveSpecIdentity: canonicalIdentity(effective),
  };
}
