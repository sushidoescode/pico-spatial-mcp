import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { okJson } from "./util.js";
import { buildLedger, splatAssetFileName } from "./compiler.js";
import { appSpecSchema, isSafeIblAssetPath } from "./appspec.js";
import { resolveAnchors } from "./semanticplace.js";
import { proceduralUsda } from "./procedural.js";
import { bakeTexturedModel } from "./bundle.js";
import { startBridgeDetached } from "./mousebridge.js";
import { classifyBriefExecution } from "./briefroute.js";
import { fileURLToPath } from "node:url";
import { findBriefPath, corpusBriefsDir } from "./briefstore.js";

const run = promisify(execFile);

/**
 * fleetbuild.ts — v10.4 (P2): the UNATTENDED fleet builder.
 *
 * `fleet_build` takes brief ids from briefs/ and, for each (SERIALLY — one emulator):
 * scaffold → execute the compile ledger's generate steps by SELF-DRIVING this same MCP server
 * over stdio (a child `node dist/index.js`) → write emitted files (wiring/panels/menu handled) →
 * gradle assembleDebug → install + launch on the emulator → settle → deterministic forward
 * capture. Stage claims flow to `visual_judge`; panel-only claims flow to structural window
 * discovery instead. A stage PASS records `auto_judged` (NEVER vision_verified — the honesty
 * split holds unattended), while panel readiness never becomes a visual verdict.
 */

const ADB = path.join(os.homedir(), "Library/PICO/sdk/0.13/emulator/system-images/platform-tools/adb");
const JBR = "/Applications/Android Studio.app/Contents/jbr/Contents/Home";
/**
 * The known-good Gradle project every generated app is cloned and rebranded from. It is NOT shipped
 * in the npm package: it is a full Android project whose editor-asset module alone is ~420MB, so a
 * generated app is a rebranded clone of it rather than a thin scaffold. Anyone installing from the
 * tarball therefore has no template and cannot build until one exists at this path. preflight_env
 * checks for it by name so that failure is reported up front rather than after a long build.
 */
export const APP_TEMPLATE = path.join(os.homedir(), "AndroidStudioProjects/galleryxr-native");
const TEMPLATE = APP_TEMPLATE;
const MENU_BUNDLE = path.join(os.homedir(), "AndroidStudioProjects/showroomxr-native/app/src/main/assets/menu.bundle");

const KTX1_IDENTIFIER = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x31, 0x31, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
const KTX_R11F_G11F_B10F = 0x8c3a;
const KTX_RGB = 0x1907;
const MAX_IBL_KTX_BYTES = 256 * 1024 * 1024;
const MAX_IBL_DIMENSION = 8192;

export type SplatAssetPlan = {
  sourcePath: string;
  sceneIds: string[];
  fileName: string;
  remoteDir: string;
  remotePath: string;
  bytes: number;
  sha256: string;
};

export type SplatAssetPlanResult = {
  ok: boolean;
  assets: SplatAssetPlan[];
  errors: string[];
};

type CommandRunner = (
  file: string,
  args: string[],
  options?: Record<string, unknown>,
) => Promise<{ stdout?: string | Buffer; stderr?: string | Buffer }>;

export type FleetSemanticAnchorResult = {
  ok: boolean;
  spec: any;
  notes: string[];
  unresolvedObjectIds: string[];
};

/** Fleet must not turn a failed authored anchor into assemble.ts's generic fallback pose.
 * Resolve once up front, retain every structural note, and fail closed while any anchor remains
 * without a concrete position. Explicit authored positions still count as concrete. */
export function prepareFleetSemanticAnchors(spec: any): FleetSemanticAnchorResult {
  const resolved = resolveAnchors(spec);
  const unresolvedObjectIds = (resolved.spec?.objects ?? [])
    .filter((object: any) => object?.anchorTo && !object?.transform?.position)
    .map((object: any) => String(object.id));
  return {
    ok: unresolvedObjectIds.length === 0,
    spec: resolved.spec,
    notes: resolved.notes,
    unresolvedObjectIds,
  };
}

function hashFileInChunks(file: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    let offset = 0;
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, offset);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      offset += read;
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/** Resolve every splat scene to the exact, safe app-files delivery that generated Kotlin expects.
 * This is structural planning only; pushSplatAssets verifies the remote bytes after installation. */
export function planSplatAssets(spec: any, packageName: string): SplatAssetPlanResult {
  const assets: SplatAssetPlan[] = [];
  const errors: string[] = [];
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(packageName)) {
    return { ok: false, assets, errors: [`invalid Android package for splat delivery: ${packageName}`] };
  }

  const byRuntimeName = new Map<string, SplatAssetPlan>();
  for (const scene of spec?.scenes ?? []) {
    if (scene?.environment?.kind !== "splat") continue;
    const declared = scene.environment.asset;
    if (typeof declared !== "string" || !declared.trim()) {
      errors.push(`scene '${scene.id}' splat environment.asset is missing`);
      continue;
    }
    const expanded = declared.startsWith("~/") ? path.join(os.homedir(), declared.slice(2)) : declared;
    const sourcePath = path.resolve(expanded);
    if (!/\.(?:ply|spz)$/i.test(sourcePath)) {
      errors.push(`scene '${scene.id}' splat must be a .ply or .spz file: ${declared}`);
      continue;
    }
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(sourcePath);
    } catch {
      errors.push(`scene '${scene.id}' splat does not exist: ${sourcePath}`);
      continue;
    }
    if (stat.isSymbolicLink()) {
      errors.push(`scene '${scene.id}' splat must be a regular file, not a symbolic link: ${sourcePath}`);
      continue;
    }
    if (!stat.isFile() || stat.size <= 0) {
      errors.push(`scene '${scene.id}' splat must be a non-empty regular file: ${sourcePath}`);
      continue;
    }

    const fileName = splatAssetFileName(sourcePath);
    const existing = byRuntimeName.get(fileName);
    if (existing) {
      if (existing.sourcePath === sourcePath) {
        if (!existing.sceneIds.includes(scene.id)) existing.sceneIds.push(scene.id);
      } else {
        errors.push(`splat runtime filename collision '${fileName}' between ${existing.sourcePath} and ${sourcePath}`);
      }
      continue;
    }

    const remoteDir = `/sdcard/Android/data/${packageName}/files`;
    const planned: SplatAssetPlan = {
      sourcePath,
      sceneIds: [scene.id],
      fileName,
      remoteDir,
      remotePath: `${remoteDir}/${fileName}`,
      bytes: stat.size,
      sha256: hashFileInChunks(sourcePath),
    };
    byRuntimeName.set(fileName, planned);
    assets.push(planned);
  }
  return { ok: errors.length === 0, assets: errors.length === 0 ? assets : [], errors };
}

export type SplatPushResult = {
  ok: boolean;
  assets: Array<SplatAssetPlan & { serial: string; remoteBytes: number; remoteSha256: string }>;
  errors: string[];
};

/** Deliver planned splats only to the managed emulator and prove the remote file is byte-identical.
 * A failure is returned, never swallowed, so fleet_build can abort before launch/capture/judging. */
export async function pushSplatAssets(
  plans: SplatAssetPlan[],
  options: { adbPath?: string; serial?: string; runner?: CommandRunner } = {},
): Promise<SplatPushResult> {
  const serial = options.serial ?? "emulator-5554";
  const pushed: SplatPushResult["assets"] = [];
  if (!/^emulator-\d+$/.test(serial)) {
    return { ok: false, assets: pushed, errors: [`splat delivery is emulator-only; refusing serial '${serial}'`] };
  }
  const adbPath = options.adbPath ?? process.env.PICO_ADB ?? ADB;
  const runner = options.runner ?? (run as unknown as CommandRunner);

  for (const asset of plans) {
    try {
      await runner(adbPath, ["-s", serial, "shell", "mkdir", "-p", asset.remoteDir], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
      await runner(adbPath, ["-s", serial, "push", asset.sourcePath, asset.remotePath], { timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024 });
      const stat = await runner(adbPath, ["-s", serial, "shell", "toybox", "stat", "-c", "%s", asset.remotePath], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
      const sizeText = String(stat.stdout ?? "").trim();
      if (!/^\d+$/.test(sizeText)) throw new Error(`unparseable remote size '${sizeText}'`);
      const remoteBytes = Number(sizeText);
      if (!Number.isSafeInteger(remoteBytes) || remoteBytes !== asset.bytes) {
        throw new Error(`size mismatch for ${asset.fileName}: local ${asset.bytes}, remote ${sizeText}`);
      }
      const digest = await runner(adbPath, ["-s", serial, "shell", "toybox", "sha256sum", asset.remotePath], { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
      const hashMatch = String(digest.stdout ?? "").trim().match(/^([a-fA-F0-9]{64})(?:\s|$)/);
      if (!hashMatch) throw new Error(`unparseable remote sha256 '${String(digest.stdout ?? "").trim()}'`);
      const remoteSha256 = hashMatch[1].toLowerCase();
      if (remoteSha256 !== asset.sha256) {
        throw new Error(`sha256 mismatch for ${asset.fileName}: local ${asset.sha256}, remote ${remoteSha256}`);
      }
      pushed.push({ ...asset, serial, remoteBytes, remoteSha256 });
    } catch (error: any) {
      return {
        ok: false,
        assets: pushed,
        errors: [`${asset.fileName}: ${String(error?.message ?? error)}`],
      };
    }
  }
  return { ok: true, assets: pushed, errors: [] };
}

export type IblKtxInspection = {
  ok: boolean;
  file: string;
  error?: string;
  version?: 1;
  bytes?: number;
  sha256?: string;
  width?: number;
  height?: number;
  depth?: number;
  arrayElements?: number;
  faces?: number;
  mipLevels?: number;
  internalFormat?: number;
  payloadBytes?: number;
};

/** Inspect the exact cmgen KTX1 shape that PICO's ImageBasedLightComponent consumes. A filename
 * or magic prefix alone is not evidence: an IBL must be a square six-face cubemap with a roughness
 * mip chain. This is structural validation only; a rendered LOOK is still required for appearance. */
export function inspectIblKtx(file: string): IblKtxInspection {
  try {
    if (!fs.existsSync(file)) return { ok: false, file, error: "file does not exist" };
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return { ok: false, file, error: "IBL KTX must be a regular file, not a symbolic link" };
    if (!stat.isFile()) return { ok: false, file, error: "IBL KTX is not a regular file" };
    if (stat.size > MAX_IBL_KTX_BYTES) {
      return { ok: false, file, bytes: stat.size, error: `IBL KTX exceeds the ${MAX_IBL_KTX_BYTES}-byte validation limit` };
    }
    const data = fs.readFileSync(file);
    if (data.length < 64) return { ok: false, file, error: `KTX1 header truncated (${data.length} bytes)` };
    if (!data.subarray(0, KTX1_IDENTIFIER.length).equals(KTX1_IDENTIFIER)) {
      return { ok: false, file, error: "not a KTX1 file (cmgen conformance assets use KTX1)" };
    }
    if (data.readUInt32LE(12) !== 0x04030201) {
      return { ok: false, file, error: "unsupported non-little-endian KTX1" };
    }
    const width = data.readUInt32LE(36);
    const height = data.readUInt32LE(40);
    const depth = data.readUInt32LE(44);
    const arrayElements = data.readUInt32LE(48);
    const faces = data.readUInt32LE(52);
    const mipLevels = data.readUInt32LE(56);
    const glType = data.readUInt32LE(16);
    const glTypeSize = data.readUInt32LE(20);
    const glFormat = data.readUInt32LE(24);
    const internalFormat = data.readUInt32LE(28);
    const baseInternalFormat = data.readUInt32LE(32);
    const base = {
      file,
      version: 1 as const,
      bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
      width,
      height,
      depth,
      arrayElements,
      faces,
      mipLevels,
      internalFormat,
    };
    if (width === 0 || height === 0 || width !== height || depth !== 0) {
      return { ok: false, ...base, error: `IBL must be a square 2D-face cubemap (got ${width}x${height}, depth=${depth})` };
    }
    if (width > MAX_IBL_DIMENSION || (width & (width - 1)) !== 0) {
      return { ok: false, ...base, error: `IBL dimensions must be power-of-two and at most ${MAX_IBL_DIMENSION} (got ${width}x${height})` };
    }
    if (arrayElements !== 0) return { ok: false, ...base, error: `IBL must not be a cubemap array (got ${arrayElements} array elements)` };
    if (faces !== 6) return { ok: false, ...base, error: `IBL cubemap must contain six faces (got ${faces})` };
    if (mipLevels <= 1) return { ok: false, ...base, error: `prefiltered IBL needs a roughness mip chain (got ${mipLevels} level)` };
    const maxMipLevels = Math.floor(Math.log2(width)) + 1;
    if (mipLevels > maxMipLevels) {
      return { ok: false, ...base, error: `IBL declares ${mipLevels} mips but ${width}x${height} permits at most ${maxMipLevels}` };
    }
    if (
      internalFormat !== KTX_R11F_G11F_B10F ||
      glType !== KTX_R11F_G11F_B10F ||
      glTypeSize !== 1 ||
      glFormat !== KTX_RGB ||
      baseInternalFormat !== KTX_R11F_G11F_B10F
    ) {
      return {
        ok: false,
        ...base,
        error: `unsupported IBL KTX format (expected cmgen R11F_G11F_B10F, got internalFormat=0x${internalFormat.toString(16)})`,
      };
    }

    // KTX1 stores a uint32 imageSize followed by one padded payload per face for every mip.
    // Walk all of them so a plausible 64-byte header cannot masquerade as a baked cubemap.
    const keyValueBytes = data.readUInt32LE(60);
    if (keyValueBytes % 4 !== 0 || keyValueBytes > data.length - 64) {
      return { ok: false, ...base, error: `KTX1 key/value data is truncated (${keyValueBytes} declared bytes)` };
    }
    const metadataEnd = 64 + keyValueBytes;
    let metadataOffset = 64;
    while (metadataOffset < metadataEnd) {
      if (metadataEnd - metadataOffset < 4) {
        return { ok: false, ...base, error: "KTX1 metadata entry header is truncated" };
      }
      const entryBytes = data.readUInt32LE(metadataOffset);
      metadataOffset += 4;
      const paddedEntryBytes = Math.ceil(entryBytes / 4) * 4;
      if (entryBytes === 0 || paddedEntryBytes > metadataEnd - metadataOffset) {
        return { ok: false, ...base, error: `KTX1 metadata key/value entry declares invalid size ${entryBytes}` };
      }
      const entryEnd = metadataOffset + entryBytes;
      const keyTerminator = data.indexOf(0, metadataOffset);
      if (keyTerminator <= metadataOffset || keyTerminator >= entryEnd) {
        return { ok: false, ...base, error: "KTX1 metadata entry has no non-empty null-terminated key" };
      }
      metadataOffset += paddedEntryBytes;
    }
    let offset = metadataEnd;
    let payloadBytes = 0;
    for (let level = 0; level < mipLevels; level++) {
      if (offset + 4 > data.length) {
        return { ok: false, ...base, payloadBytes, error: `KTX1 mip ${level} imageSize/payload is truncated` };
      }
      const imageSize = data.readUInt32LE(offset);
      offset += 4;
      if (imageSize === 0) {
        return { ok: false, ...base, payloadBytes, error: `KTX1 mip ${level} declares an empty face payload` };
      }
      const mipWidth = Math.max(1, Math.floor(width / (2 ** level)));
      const mipHeight = Math.max(1, Math.floor(height / (2 ** level)));
      const expectedImageSize = mipWidth * mipHeight * 4;
      if (imageSize !== expectedImageSize) {
        return {
          ok: false,
          ...base,
          payloadBytes,
          error: `KTX1 mip ${level} R11F_G11F_B10F face payload is ${imageSize} bytes, expected ${expectedImageSize}`,
        };
      }
      const padded = Math.ceil(imageSize / 4) * 4;
      for (let face = 0; face < faces; face++) {
        if (padded > data.length - offset) {
          return { ok: false, ...base, payloadBytes, error: `KTX1 mip ${level} face ${face} payload is truncated` };
        }
        payloadBytes += imageSize;
        offset += padded;
      }
    }
    if (offset !== data.length) {
      return { ok: false, ...base, payloadBytes, error: `KTX1 has ${data.length - offset} unexpected trailing bytes after its mip payloads` };
    }
    return { ok: true, ...base, payloadBytes };
  } catch (e: any) {
    return { ok: false, file, error: String(e?.message ?? e) };
  }
}

/** Return the first symbolic-link component below a trusted lexical root. The root itself is the
 * caller-selected trust anchor; descendants must be real directories/files so staging cannot walk
 * through an assets/ibl link and write elsewhere. Missing descendants are safe until we create them. */
function symlinkBelow(root: string, target: string): string | null {
  const rel = path.relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  let current = root;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return current;
    } catch (error: any) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
  return null;
}

export type ProvisionedIblAsset = IblKtxInspection & {
  sceneId: string;
  assetPath: string;
  source: string;
  destination: string;
  copied: boolean;
};

/** Stage every IBL scene's declared APK-relative KTX from the corpus beside its brief. Reused
 * fleet projects may supply the destination themselves; either route must pass the same cubemap
 * inspection. Paths are deliberately relative and traversal-free so a brief cannot write outside
 * app/src/main/assets. */
export function provisionIblAssets(
  spec: any,
  opts: { briefsDir: string; projectDir: string },
): { ok: boolean; assets: ProvisionedIblAsset[]; errors: string[] } {
  const assets: ProvisionedIblAsset[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const projectRoot = path.resolve(opts.projectDir);
  const projectAssets = path.resolve(opts.projectDir, "app/src/main/assets");
  const corpusRoot = path.resolve(opts.briefsDir);

  for (const scene of spec?.scenes ?? []) {
    if (scene?.lighting?.rig !== "ibl") continue;
    const raw = scene?.lighting?.params?.ktxAssetPath;
    if (typeof raw !== "string" || !raw.trim()) {
      errors.push(`scene '${scene?.id ?? "?"}': IBL needs lighting.params.ktxAssetPath`);
      continue;
    }
    const rel = raw;
    const normalized = path.posix.normalize(rel);
    if (
      raw !== raw.trim() ||
      normalized !== rel ||
      !isSafeIblAssetPath(rel) ||
      path.isAbsolute(rel) ||
      rel.includes("\\") ||
      normalized === ".." ||
      normalized.startsWith("../") ||
      normalized.startsWith("/") ||
      path.posix.extname(normalized).toLowerCase() !== ".ktx"
    ) {
      errors.push(`scene '${scene.id}': ktxAssetPath must be a safe relative .ktx asset path (got '${rel}')`);
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const source = path.resolve(corpusRoot, normalized);
    const destination = path.resolve(projectAssets, normalized);
    if (!source.startsWith(corpusRoot + path.sep) || !destination.startsWith(projectAssets + path.sep)) {
      errors.push(`scene '${scene.id}': ktxAssetPath must be a safe relative .ktx asset path (got '${rel}')`);
      continue;
    }

    const sourceLink = symlinkBelow(corpusRoot, source);
    const destinationLink = symlinkBelow(projectRoot, destination);
    if (sourceLink || destinationLink) {
      errors.push(
        `scene '${scene.id}': IBL paths must not traverse a symbolic link` +
        `${sourceLink ? ` (corpus: '${sourceLink}')` : ""}${destinationLink ? ` (project: '${destinationLink}')` : ""}`,
      );
      continue;
    }

    const bundled = inspectIblKtx(source);
    const existing = inspectIblKtx(destination);
    const selected = bundled.ok ? bundled : existing;
    const selectedFile = bundled.ok ? source : destination;
    if (!selected.ok) {
      errors.push(
        `scene '${scene.id}': no valid baked IBL at corpus '${source}' or project '${destination}'` +
        ` (corpus: ${bundled.error}; project: ${existing.error})`,
      );
      continue;
    }

    let copied = false;
    if (selectedFile === source) {
      try {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const linkAfterMkdir = symlinkBelow(projectRoot, destination);
        if (linkAfterMkdir) {
          errors.push(`scene '${scene.id}': IBL destination traverses symbolic link '${linkAfterMkdir}'`);
          continue;
        }
        if (!existing.ok || existing.sha256 !== bundled.sha256) {
          const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
          try {
            fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
            fs.renameSync(temporary, destination);
          } finally {
            if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
          }
          copied = true;
        }
      } catch (error: any) {
        errors.push(`scene '${scene.id}': failed to stage IBL at '${destination}': ${String(error?.message ?? error)}`);
        continue;
      }
    }
    const final = inspectIblKtx(destination);
    if (!final.ok) {
      errors.push(`scene '${scene.id}': staged IBL failed validation at '${destination}': ${final.error}`);
      continue;
    }
    assets.push({
      ...final,
      sceneId: String(scene.id ?? "?"),
      assetPath: normalized,
      source: selectedFile,
      destination,
      copied,
    });
  }
  return { ok: errors.length === 0, assets, errors };
}

type Step = { order: number; tool: string; args: any; targetPath: string; note?: string };

async function selfClient() {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
  const transport = new StdioClientTransport({ command: "node", args: [path.join(here, "index.js")], cwd: path.dirname(here) });
  const client = new Client({ name: "fleet-executor", version: "1" });
  await client.connect(transport);
  const call = async (name: string, args: any = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    const text = (r.content ?? []).map((c: any) => (c.type === "text" ? c.text : "")).join("\n");
    try { return JSON.parse(text); } catch { return text; }
  };
  return { client, call };
}

function patchManifest(projectDir: string, entry: string) {
  const mf = path.join(projectDir, "app/src/main/AndroidManifest.xml");
  let m = fs.readFileSync(mf, "utf8");
  const name = entry.match(/android:name="([^"]+)"/)?.[1] ?? "";
  if (name && !m.includes(name)) {
    m = m.replace("    </application>", `        ${entry}\n    </application>`);
    fs.writeFileSync(mf, m);
  }
}

const PALETTE_ITEMS = [
  { id: "item0", label: "Item 0", color: [0.85, 0.12, 0.2] },
  { id: "item1", label: "Item 1", color: [0.95, 0.6, 0.1] },
  { id: "item2", label: "Item 2", color: [0.95, 0.9, 0.2] },
  { id: "item3", label: "Item 3", color: [0.15, 0.75, 0.35] },
  { id: "item4", label: "Item 4", color: [0.2, 0.45, 0.9] },
  { id: "item5", label: "Item 5", color: [0.6, 0.25, 0.85] },
];

// v27.1: NAME-AWARE PROCEDURAL PROVISIONING — closes "friction #4" from the first-light stranger
// test. A data-bound object named like a shape ("gems"/"crystals"/…) previously always got a
// color-only PALETTE_ITEMS card (SceneDataBinding.makeModelCard falls back to a tinted quad when
// item.model is absent). If the data node's id, its declared asset's basename, or the bound
// object's id names a shape archetype, provisionDataItems below bakes a REAL per-item procedural
// prop (src/procedural.ts, tinted per-item by the palette color) via the same spatialbundle bake
// bake_textured_model uses, and writes items WITH model/modelName so makeModelCard loads real
// geometry. Any bake failure (or no name match at all) falls back to the honest color-only card —
// provisioning must never abort the build.
const SHAPE_KEYWORDS: [string, string[]][] = [
  ["gem", ["gems", "gem", "jewels", "jewel"]],
  ["crystal", ["crystals", "crystal"]],
  ["prism", ["prisms", "prism"]],
  ["cube", ["cubes", "cube", "crates", "crate", "boxes", "box"]],
  ["pyramid", ["pyramids", "pyramid"]],
  ["octahedron", ["octahedrons", "octahedra", "octahedron"]],
  ["tetrahedron", ["tetrahedrons", "tetrahedra", "tetrahedron"]],
  ["pin", ["pins", "pin"]],
  ["bottle", ["bottles", "bottle"]],
];

/** Match a data node's names against the shape-archetype keyword table (case-insensitive substring).
 *  Checked in order: earlier args win on a tie. Returns null when nothing names a known shape —
 *  the honest color-only card fallback stays in place. */
export function matchShapeArchetype(...names: (string | undefined)[]): string | null {
  for (const raw of names) {
    if (!raw) continue;
    const lower = raw.toLowerCase();
    for (const [shape, keywords] of SHAPE_KEYWORDS) {
      if (keywords.some((kw) => lower.includes(kw))) return shape;
    }
  }
  return null;
}

type VisualExpectation = {
  minObjects: number;
  maxObjects?: number;
  notMostlyBlack: true;
};

/** Resolve the layout whose foreground instances a verification node actually claims. A node may
 * target the layout directly (`targetRef: "tiles"`) or target the one object instantiated by that
 * layout (`targetRef: "metrics"`, `metrics.layoutRef: "tiles"`). */
function targetLayout(spec: any, verificationNode: any): any | null {
  const ref = verificationNode?.targetRef;
  if (!ref) return null;
  const direct = (spec?.layouts ?? []).find((l: any) => l.id === ref);
  if (direct) return direct;
  const object = (spec?.objects ?? []).find((o: any) => o.id === ref);
  if (!object?.layoutRef) return null;
  return (spec?.layouts ?? []).find((l: any) => l.id === object.layoutRef) ?? null;
}

/** Derive the calibrated eye's predicate from the verification target. Layout-backed claims are
 * exact: an N-slot layout must measure N foreground objects, never the historical fleet-wide 2..3
 * fallback that allowed an unrelated environment frame to "prove" a six-tile claim. Non-layout
 * targets retain the conservative legacy minimum; callers may still explicitly override it via the
 * fleet_build `minObjects` map. */
export function deriveVisualExpectation(spec: any, verificationNode: any): VisualExpectation {
  const layout = targetLayout(spec, verificationNode);
  const count = Number(layout?.count);
  if (Number.isInteger(count) && count >= 0) {
    return { minObjects: count, maxObjects: count, notMostlyBlack: true };
  }
  return { minObjects: 2, notMostlyBlack: true };
}

export type VerificationRoute = {
  mode: "stage-eye" | "panel-structural" | "hybrid";
  stageEyeClaim: any | null;
  panelClaims: any[];
  panelTargetIds: string[];
  reason: string;
};

/** Split verification by rendered surface. Spatial panels are separate Android windows, so a
 * panel-only claim must never be sent to the stage-frame eye. Hybrid specs keep the first
 * non-panel claim for the stage eye and verify every declared panel through structural runtime
 * evidence instead. A panel-only spec with no explicit verification node still targets all of its
 * panels; absence of a claim does not justify inventing a foreground-object predicate. */
export function deriveVerificationRoute(spec: any): VerificationRoute {
  const panels = Array.isArray(spec?.panels) ? spec.panels : [];
  const panelIds = new Set(panels.map((panel: any) => String(panel?.id ?? "")).filter(Boolean));
  const plan = Array.isArray(spec?.verificationPlan) ? spec.verificationPlan : [];
  const panelClaims = plan.filter((claim: any) => panelIds.has(String(claim?.targetRef ?? "")));
  const stageClaims = plan.filter((claim: any) => !panelIds.has(String(claim?.targetRef ?? "")));
  const noStageGeometry = (spec?.objects?.length ?? 0) === 0 && (spec?.layouts?.length ?? 0) === 0;
  const onlyPanelClaims = panelClaims.length > 0 && stageClaims.length === 0;
  const panelStructuralOnly = panels.length > 0 && (noStageGeometry || onlyPanelClaims);
  const stageEyeClaim = panelStructuralOnly ? null : (stageClaims[0] ?? plan[0] ?? null);
  const mode: VerificationRoute["mode"] = panelStructuralOnly
    ? "panel-structural"
    : panels.length > 0
      ? "hybrid"
      : "stage-eye";
  return {
    mode,
    stageEyeClaim,
    panelClaims,
    panelTargetIds: panels.map((panel: any) => String(panel.id)),
    reason: panelStructuralOnly
      ? (noStageGeometry
          ? "panels declared with no stage objects/layouts"
          : "verification plan contains only panel targets")
      : mode === "hybrid"
        ? "stage claim and spatial panels are verified on separate surfaces"
        : "no spatial panels declared",
  };
}

type GeneratedPanel = { nodeId: string; activity: string; kind: string };

/** AppSpec panel nodes currently compile to one generated activity per rendering kind. Preserve the
 * node→activity mapping for honesty, but dedupe activities before launching: two HUD nodes do not
 * magically become two OS panels when both map to HudPanelActivity. */
function generatedPanels(spec: any, pkg: string): { mappings: GeneratedPanel[]; activities: string[] } {
  const mappings: GeneratedPanel[] = (spec?.panels ?? []).map((panel: any) => {
    const web = panel.kind === "web";
    return {
      nodeId: String(panel.id),
      activity: `${pkg}.content.${web ? "WebPanelActivity" : "HudPanelActivity"}`,
      kind: web ? "web" : "hud",
    };
  });
  return { mappings, activities: [...new Set(mappings.map((m: GeneratedPanel) => m.activity))] };
}

/** Provision one data node's item catalog: PALETTE_ITEMS tinted cards by default, or — when the
 *  node/asset/bound-object name matches a shape archetype — real baked procedural props (one bundle
 *  per item, tinted by that item's palette color). Never throws; a bake failure logs to `notes` and
 *  falls back to the color-only items so the build always proceeds. */
async function provisionDataItems(opts: {
  assetsRoot: string;
  briefId: string;
  dataId: string;
  assetBasename: string;
  boundObjectId?: string;
  count: number;
  notes: string[];
}): Promise<any[]> {
  const n = Math.max(1, opts.count);
  const fallback = () => PALETTE_ITEMS.slice(0, n);
  const shape = matchShapeArchetype(opts.dataId, opts.assetBasename, opts.boundObjectId);
  if (!shape) return fallback();

  const propsDir = path.join(opts.assetsRoot, "props");
  fs.mkdirSync(propsDir, { recursive: true });
  const items: any[] = [];
  for (let i = 0; i < n; i++) {
    const base = PALETTE_ITEMS[i % PALETTE_ITEMS.length];
    const propName = `${shape}${i}`;
    const usda = proceduralUsda({
      shape,
      size: 0.34,
      color: base.color as [number, number, number],
      metallic: 0.15,
      roughness: 0.35,
      name: propName,
    });
    const usdaPath = path.join(os.tmpdir(), `pico-fleet-${opts.briefId}-${propName}-${Date.now()}-${i}.usda`);
    const outBundle = path.join(propsDir, `${propName}.bundle`);
    let bake: any;
    try {
      fs.writeFileSync(usdaPath, usda);
      bake = await bakeTexturedModel({ modelPath: usdaPath, outBundle });
    } catch (e: any) {
      bake = { error: String(e?.message ?? e) };
    } finally {
      try { fs.rmSync(usdaPath, { force: true }); } catch {}
    }
    if (bake?.error || !fs.existsSync(outBundle)) {
      opts.notes.push(
        `procedural provisioning: bake failed for data '${opts.dataId}' item ${i} (shape=${shape}) — falling back to color-only cards for this data node (${bake?.error ?? "no bundle written"})`,
      );
      return fallback();
    }
    items.push({ id: base.id, label: base.label, color: base.color, model: `props/${propName}.bundle`, modelName: bake.modelName });
  }
  return items;
}

export function registerFleetBuildTools(server: McpServer) {
  server.registerTool(
    "fleet_build",
    {
      description:
        "UNATTENDED end-to-end fleet build (P2): for each brief id (briefs/<id>.json), SERIALLY scaffold a fresh app, execute the compile ledger's generate steps (self-driving this MCP over stdio), write emitted Kotlin/wiring/panel/menu files (manifest patched, menu.bundle + items.json provisioned), gradle-build, install + launch on emulator-5554, settle, and take a deterministic forward capture. Stage claims use the calibrated visual_judge; panel-only or panel-target-only specs bypass that stage eye instead of false-failing an empty frame. A target layout is checked against its exact declared count (N means min=max=N), not the historical blanket 2..3; a confident PASS records an `auto_judged` ledger entry — NEVER vision_verified. Each distinct generated panel activity is launched and polled through list_spatial_panels; its caption-backed readiness is returned separately as structural panelEvidence plus an unjudged panel-time capture. Requires the local toolchain + a running emulator. Briefs whose environments need external assets or explicitly declare a hand-authored execution route are skipped honestly.",
      inputSchema: {
        briefIds: z.array(z.string()).min(1).describe("Brief ids from briefs/ (e.g. ['knockdown','studio','console'])."),
        projectsRoot: z.string().optional().describe("Where per-brief projects go (default ~/AndroidStudioProjects). Dir per brief: fleet-<id>-native (reused if present)."),
        settleSec: z.number().optional().describe("Seconds to wait after launch before capturing (default 12)."),
        minObjects: z.record(z.number()).optional().describe("Per-brief judge expectation override, e.g. {knockdown: 2}. Without an override, a target layout uses its exact declared count (min=max=N); non-layout targets retain the conservative 2-object fallback."),
      },
    },
    async ({ briefIds, projectsRoot, settleSec, minObjects }) => {
      const root = projectsRoot ?? path.join(os.homedir(), "AndroidStudioProjects");

      const settle = (settleSec ?? 12) * 1000;
      const results: any[] = [];
      const { client, call } = await selfClient();
      try {
        for (const id of briefIds) {
          const rec: any = { id, built: false, installed: false, verdict: null, artifact: null, verificationRoute: null, panelEvidence: null, panelArtifact: null, notes: [] };
          results.push(rec);
          try {
            const briefPath = findBriefPath(id);
            if (!briefPath) { rec.notes.push("brief not found"); continue; }
            // IBL assets (ibl/*.ktx) ship with the packaged corpus. Resolving them relative to the
            // brief that was found breaks user-store briefs, which sit in ~/.pico-mcp/briefs where no
            // ibl/ exists — provisioning then fails with "no valid baked IBL at corpus ...". So use
            // the brief's own directory only when it actually carries assets, and fall back to the
            // corpus otherwise. This keeps corpus briefs behaving exactly as before.
            const briefDir = path.dirname(briefPath);
            const briefsDir = fs.existsSync(path.join(briefDir, "ibl")) ? briefDir : corpusBriefsDir();
            const entry = JSON.parse(fs.readFileSync(briefPath, "utf8"));
            let execution;
            try {
              execution = classifyBriefExecution(entry);
            } catch (error: any) {
              rec.notes.push(`invalid execution metadata: ${error.message}`);
              continue;
            }
            if (execution.route === "hand-authored-classic-android") {
              rec.externalImplementation = execution;
              rec.notes.push(
                `skipped: execution route ${execution.route}; generic fleet codegen cannot build ` +
                `${execution.packageName}. Build ${execution.projectPath} and launch ${execution.launcherActivity}.`,
              );
              continue;
            }
            const parsed = appSpecSchema.safeParse(entry.spec);
            if (!parsed.success) { rec.notes.push("spec invalid"); continue; }
            const semanticPlacement = prepareFleetSemanticAnchors(parsed.data);
            for (const note of semanticPlacement.notes) rec.notes.push(`semantic placement: ${note}`);
            if (!semanticPlacement.ok) {
              rec.notes.push(
                `skipped: semantic placement unresolved for object(s) ${semanticPlacement.unresolvedObjectIds.join(", ")}; ` +
                "launch/capture skipped instead of using a fallback pose",
              );
              continue;
            }
            const spec: any = semanticPlacement.spec;
            const verificationRoute = deriveVerificationRoute(spec);
            rec.verificationRoute = verificationRoute;
            // v15.1b: asset gates check EVERY scene (multi-scene briefs like narrative previously
            // slipped past the first-scene-only check and failed the build downstream), and ibl
            // rigs without a provided .ktx are asset-gated too (generate_ibl_kotlin requires it).
            // v19: an env is only asset-GATED when its asset is actually MISSING — a resolvable
            // file (e.g. a downloaded World Labs GLB) flows through bake_textured_model normally.
            const assetOk = (a: any) => typeof a === "string" && fs.existsSync(a.replace(/^~\//, os.homedir() + "/"));
            const gated = spec.scenes.find((s: any) => ["splat", "pano", "texturedMesh"].includes(s.environment?.kind) && !assetOk(s.environment?.asset));
            if (gated) { rec.notes.push(`skipped: env '${gated.environment.kind}' (scene '${gated.id}') needs an external asset (environment.asset must be an existing file)`); continue; }
            const iblNoKtx = spec.scenes.find((s: any) => s.lighting?.rig === "ibl" && !s.lighting?.params?.ktxAssetPath);
            if (iblNoKtx) { rec.notes.push(`skipped: rig 'ibl' (scene '${iblNoKtx.id}') needs a baked .ktx cubemap (lighting.params.ktxAssetPath — bake with prepare_ibl_cubemap)`); continue; }

            // unique fleet identity so installs never collide with dev apps
            const pkg = `com.fleet.${id}`;
            spec.meta.packageName = pkg;
            spec.meta.appName = `Fleet${id[0].toUpperCase()}${id.slice(1)}`;
            const projectDir = path.join(root, `fleet-${id}-native`);

            // v29: a splat reference is not runtime delivery. Plan the exact sanitized app-files
            // name and hash every local source before expensive scaffold/build work. The same
            // splatAssetFileName helper drives compiler codegen, so Kotlin and adb cannot drift.
            const splatPlan = planSplatAssets(spec, pkg);
            if (!splatPlan.ok) {
              rec.notes.push(`skipped: splat delivery planning failed: ${splatPlan.errors.join("; ")}`);
              continue;
            }

            // 1. scaffold (idempotent)
            if (!fs.existsSync(projectDir)) {
              const sc = await call("scaffold_spatial_app", { templateProject: TEMPLATE, targetDir: projectDir, packageName: pkg, appName: spec.meta.appName, stageStyle: spec.meta.stageStyle ?? "3" });
              if (!sc.created) { rec.notes.push(`scaffold failed: ${JSON.stringify(sc).slice(0, 150)}`); continue; }
            }
            const jdir = path.join(projectDir, `app/src/main/java/${pkg.replace(/\./g, "/")}`);

            // v28.3: a ktxAssetPath string is not an asset. Validate the corpus/project file as a
            // real six-face prefiltered KTX cubemap, then stage it at the exact APK-relative path
            // before codegen/build. This closes ambient's historical "ungated but missing in APK"
            // hole while keeping custom project-provided assets possible on reused fleet projects.
            const iblAssets = provisionIblAssets(spec, { briefsDir, projectDir });
            if (!iblAssets.ok) {
              rec.notes.push(`skipped: IBL asset validation/provisioning failed: ${iblAssets.errors.join("; ")}`);
              continue;
            }
            for (const asset of iblAssets.assets) {
              rec.notes.push(
                `IBL asset staged: ${asset.assetPath} (${asset.width}x${asset.height}, ${asset.faces} faces, ` +
                `${asset.mipLevels} mips, sha256 ${asset.sha256}${asset.copied ? ", copied from corpus" : ", reused"})`,
              );
            }

            // 2. execute the ledger's generate steps
            const steps = buildLedger(spec, projectDir) as Step[];
            let wiringFailed = false;
            for (const st of steps) {
              if (st.tool === "scaffold_spatial_app" || st.tool === "build_and_run") continue;
              if (st.tool === "generate_agent_bridge") {
                // v25: OVERWRITE the template's bridge with the CURRENT generator output so live
                // copilot commands (spawn/move/remove) exist in every fleet app — template drift
                // was shipping a stale bridge (unknown_cmd spawn) while the host tools moved on.
                const bridge = await call("generate_agent_bridge", { packageName: `${pkg}.agent` });
                for (const f of bridge.files ?? []) {
                  const dest = path.join(projectDir, f.path.replace(/^app\/src\/main\/java\/.*\/agent\//, `app/src/main/java/${pkg.replace(/\./g, "/")}/agent/`));
                  fs.mkdirSync(path.dirname(dest), { recursive: true });
                  fs.writeFileSync(dest, f.content);
                }
                continue;
              }
              const out = await call(st.tool, st.args);
              if (st.tool === "generate_app_wiring") {
                // v15.0: a wiring failure must be LOUD — an app without its wiring silently runs on
                // the scaffold template's HomeStage (spec objects never spawn; the judge counts
                // template pins). That was the pre-v15 fleet state.
                if (!Array.isArray(out.files) || out.files.length === 0) {
                  rec.notes.push(`generate_app_wiring emitted NO files (${JSON.stringify(out).slice(0, 160)}) — aborting this brief instead of shipping a template-wired app`);
                  wiringFailed = true;
                  break;
                }
                for (const f of out.files) {
                  const fp = f.path.startsWith("/") ? f.path : path.join(projectDir, f.path);
                  fs.mkdirSync(path.dirname(fp), { recursive: true });
                  fs.writeFileSync(fp, f.content);
                }
                continue;
              }
              // v15.1b: bake_textured_model is an ASSET step, not a Kotlin emitter — success means
              // the bundle exists; anything else asset-gates the brief (never build against a
              // missing asset the composition references).
              if (st.tool === "bake_textured_model") {
                // success = the tool reported a bundle AND the file exists (bake returns {bundle,...}
                // with no status field; errors return {error})
                const bundlePath = typeof out?.bundle === "string" ? out.bundle : null;
                if (out?.error || !bundlePath || !fs.existsSync(bundlePath)) {
                  rec.notes.push(`asset-gated: bake_textured_model did not bake (${JSON.stringify(out).slice(0, 140)})`);
                  wiringFailed = true;
                  break;
                }
                continue;
              }
              // v15.1b: generate_home_env_proxy returns a room PLAN whose Kotlin comes from
              // chaining its colliderCall into generate_collider_kotlin (the executor previously
              // dropped it — atrium shipped with NO app content).
              if (st.tool === "generate_home_env_proxy") {
                const cc = out?.colliderCall;
                const col = cc?.args ? await call(cc.tool ?? "generate_collider_kotlin", { ...cc.args, packageName: (st.args as any).packageName }) : null;
                const kt2 = typeof col === "string" ? col : col?.kotlin;
                if (typeof kt2 !== "string" || !kt2.includes("package ")) {
                  rec.notes.push(`generate_home_env_proxy chain failed (${JSON.stringify(out).slice(0, 120)}) — aborting this brief`);
                  wiringFailed = true;
                  break;
                }
                // the chained emission declares `object SpatialColliders` — it must land in
                // SpatialColliders.kt, REPLACING the scaffold template's bundled copy (two files
                // declaring the same object = Kotlin redeclaration error).
                const t2raw = st.targetPath.startsWith("/") ? st.targetPath : path.join(projectDir, st.targetPath);
                const t2 = path.join(path.dirname(t2raw), "SpatialColliders.kt");
                fs.mkdirSync(path.dirname(t2), { recursive: true });
                fs.writeFileSync(t2, kt2);
                if (fs.existsSync(t2raw) && t2raw !== t2) fs.unlinkSync(t2raw); // stale HomeEnvProxy.kt from the pre-fix run
                continue;
              }
              // structured returns carry kotlin under {kotlin} or {file:{content|kotlin}}; plain returns are the Kotlin text
              const kotlin = typeof out === "string" ? out : out.kotlin ?? out.file?.content ?? out.file?.kotlin;
              if (typeof kotlin !== "string" || !kotlin.includes("package ")) {
                rec.notes.push(`${st.tool}: unexpected output (${typeof out === "string" ? out.slice(0, 100) : JSON.stringify(out).slice(0, 100)})`);
                continue;
              }
              const target = st.targetPath.startsWith("/") ? st.targetPath : path.join(projectDir, st.targetPath);
              fs.mkdirSync(path.dirname(target), { recursive: true });
              fs.writeFileSync(target, kotlin);
              if (typeof out === "object" && out.manifestEntry) patchManifest(projectDir, out.manifestEntry);
              if (st.tool === "generate_game_menu_kotlin" && fs.existsSync(MENU_BUNDLE)) {
                fs.mkdirSync(path.join(projectDir, "app/src/main/assets"), { recursive: true });
                fs.copyFileSync(MENU_BUNDLE, path.join(projectDir, "app/src/main/assets/menu.bundle"));
              }
            }
            if (wiringFailed) continue; // recorded above — do not build/judge a template-wired app
            // data briefs need the bundled catalog
            if (spec.data?.length) {
              // v15.1b: provision EVERY data node's declared asset (multi-scene briefs like atrium
              // declare data/lobby.json + data/hall.json — the old single items.json left every
              // other node loading EMPTY and its layout placing nothing).
              const assetsRoot = path.join(projectDir, "app/src/main/assets");
              for (const d of spec.data) {
                const rel = typeof d.asset === "string" && d.asset.trim() ? d.asset : "data/items.json";
                const boundObj = spec.objects?.find((o: any) => o.dataBindRef === d.id);
                const count = spec.layouts?.find((l: any) => l.id === boundObj?.layoutRef)?.count ?? spec.layouts?.[0]?.count ?? 6;
                const fp = path.join(assetsRoot, rel);
                fs.mkdirSync(path.dirname(fp), { recursive: true });
                const items = await provisionDataItems({
                  assetsRoot,
                  briefId: id,
                  dataId: d.id,
                  assetBasename: path.basename(rel),
                  boundObjectId: boundObj?.id,
                  count,
                  notes: rec.notes,
                });
                fs.writeFileSync(fp, JSON.stringify(items, null, 2));
              }
            }

            // 3. build + install + launch
            const envv = { ...process.env, JAVA_HOME: process.env.JAVA_HOME ?? JBR };
            await run("./gradlew", [":app:assembleDebug", "-q"], { cwd: projectDir, env: envv, timeout: 480_000, maxBuffer: 32 * 1024 * 1024 });
            rec.built = true;
            const apk = path.join(projectDir, "app/build/outputs/apk/debug/app-debug.apk");
            await run(ADB, ["-s", "emulator-5554", "install", "-r", apk], { timeout: 240_000 });
            rec.installed = true;
            const splatDelivery = await pushSplatAssets(splatPlan.assets, {
              adbPath: process.env.PICO_ADB ?? ADB,
              serial: "emulator-5554",
            });
            if (!splatDelivery.ok) {
              rec.notes.push(`splat delivery failed after install; launch/capture skipped: ${splatDelivery.errors.join("; ")}`);
              continue;
            }
            rec.splatAssets = splatDelivery.assets;
            for (const asset of splatDelivery.assets) {
              rec.notes.push(
                `splat delivered + remote-verified: ${asset.fileName} (${asset.remoteBytes} bytes, ` +
                `sha256 ${asset.remoteSha256}, ${asset.serial}:${asset.remotePath})`,
              );
            }
            // v15.1: force-stop → pause → PLAIN start. An immediate `am start -S` intermittently
            // trips Android's "activity kept for the user" and the app never reaches the stage
            // (observed live; the paused plain start worked every time).
            const launchApp = async () => {
              // v15.1b: sweep ALL fleet apps off the stage first — in corpus runs the previous
              // brief's app squats the stage and every chained launch needed blocker recovery.
              try {
                const pl = await run(ADB, ["-s", "emulator-5554", "shell", "pm", "list", "packages", "com.fleet"], { timeout: 15_000 });
                for (const m of String(pl.stdout).matchAll(/package:(com\.fleet\.[\w.]+)/g)) {
                  await run(ADB, ["-s", "emulator-5554", "shell", "am", "force-stop", m[1]], { timeout: 15_000 }).catch(() => {});
                }
              } catch { /* sweep is best-effort */ }
              await new Promise((r) => setTimeout(r, 2000));
              await run(ADB, ["-s", "emulator-5554", "shell", "am", "start", "-n", `${pkg}/.platform.LaunchActivity`], { timeout: 30_000 });
            };
            await launchApp();
            // v15.1: the stage handoff races a one-shot check (every corpus run escalated on
            // "not foreground at capture") — POLL for foreground up to 24s instead, and read the
            // blocker's name from the same dump if one is squatting.
            const foregroundState = async (): Promise<{ ours: boolean; blocker: string | null }> => {
              const d = await run(ADB, ["-s", "emulator-5554", "shell", "dumpsys", "activity", "activities"], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
              const ours = new RegExp(`topResumedActivity=ActivityRecord\\{\\S+ u0 ${pkg.replace(/\./g, "\\.")}[/]`).test(String(d.stdout));
              const m = String(d.stdout).match(/topResumedActivity=ActivityRecord\{\S+ u0 ([\w.]+)\//);
              return { ours, blocker: !ours && m && m[1] !== pkg ? m[1] : null };
            };
            const waitForeground = async (): Promise<boolean> => {
              for (let i = 0; i < 12; i++) {
                if ((await foregroundState()).ours) return true;
                await new Promise((r) => setTimeout(r, 2000));
              }
              return false;
            };
            if (!(await waitForeground())) {
              const { blocker } = await foregroundState();
              if (blocker) {
                await run(ADB, ["-s", "emulator-5554", "shell", "am", "force-stop", blocker], { timeout: 15_000 }).catch(() => {});
                rec.notes.push(`launch_blocked by ${blocker} — force-stopped + relaunched`);
              }
              await launchApp();
              if (!(await waitForeground())) {
                rec.notes.push("app not foreground at capture time — the frame shows whatever IS on stage");
              }
            }
            // v27.2 baked-in bridge: a menu app is clickable the moment it launches — auto-start
            // the detached mouse bridge so nobody pastes a pico-bridge command. Best-effort;
            // idempotent; opt out with PICO_MCP_NO_AUTOBRIDGE=1.
            const hasMenu = (entry.spec?.interactions ?? []).some((i: any) => i.trigger === "press");
            if (hasMenu && process.env.PICO_MCP_NO_AUTOBRIDGE !== "1") {
              const b = await startBridgeDetached().catch((e) => ({ status: "failed", pid: null, note: String(e?.message ?? e) }));
              rec.notes.push(`mouse bridge: ${b.status}${b.pid ? ` (pid ${b.pid})` : ""}${b.status === "permission-needed" ? ` — ${b.note}` : ""}`);
            }
            await new Promise((r) => setTimeout(r, settle));

            // 4. deterministic forward capture + the calibrated eye
            const shotDir = `/tmp/pico-render/fleet/${id}`;
            fs.mkdirSync(shotDir, { recursive: true });
            const shot = path.join(shotDir, "forward.png");
            const png = await run(ADB, ["-s", "emulator-5554", "exec-out", "screencap", "-p"], { timeout: 30_000, encoding: "buffer" as any, maxBuffer: 32 * 1024 * 1024 });
            fs.writeFileSync(shot, png.stdout as any);
            rec.artifact = shot;
            if (verificationRoute.mode !== "panel-structural") {
              const verificationNode = verificationRoute.stageEyeClaim;
              const derivedExpectation = deriveVisualExpectation(spec, verificationNode);
              const explicitMin = minObjects?.[id];
              // Preserve the public override exactly as the old fleet did (min with the judge's
              // default +1 slack). Without one, layout-derived expectations are intentionally exact.
              const expectation: VisualExpectation = explicitMin != null
                ? { minObjects: explicitMin, notMostlyBlack: true }
                : derivedExpectation;
              const layout = targetLayout(spec, verificationNode);
              const target = verificationNode?.targetRef ?? "scene";
              const measuredClaim = layout && explicitMin == null
                ? `${layout.count} foreground objects render for layout '${layout.id}'`
                : `${expectation.minObjects}+ foreground objects render for target '${target}'`;
              const judged = await call("visual_judge", {
                imagePath: shot,
                // The automated eye measures count + coverage. Do not let it auto-record the
                // broader brief claim (for example "colored by JSON") when it measured no colors.
                claim: `[fleet_build unattended] ${measuredClaim}`,
                expect: expectation,
                app: pkg,
                record: true,
                cClass: "C0_emulator",
              });
              rec.verdict = judged.verdict ?? judged.status ?? "unknown";
              rec.confidence = judged.confidence;
              rec.visualExpectation = expectation;
              rec.visualClaim = measuredClaim;
              if (rec.verdict !== "PASS") rec.notes.push("ESCALATE: a human must LOOK at the artifact");
            } else {
              rec.visualExpectation = null;
              rec.visualClaim = null;
              rec.notes.push(`stage eye not run: ${verificationRoute.reason}; panel readiness is structural evidence, not a visual verdict`);
            }

            // 5. Panels are independent 2D activities, not stage objects. Launch them only AFTER
            // the deterministic stage capture so their docked windows cannot contaminate its eye
            // verdict. list_spatial_panels proves WindowManager/container readiness structurally;
            // the later screencap is an unjudged artifact and does not upgrade that evidence.
            const panelPlan = generatedPanels(spec, pkg);
            if (panelPlan.activities.length) {
              const mappingMultiplicityMet = panelPlan.mappings.length === panelPlan.activities.length;
              if (!mappingMultiplicityMet) {
                rec.notes.push(
                  `panel mapping NOT independently provable: ${panelPlan.mappings.length} AppSpec nodes collapse to ${panelPlan.activities.length} generated activities`,
                );
              }
              const launchErrors: string[] = [];
              for (const activity of panelPlan.activities) {
                try {
                  await run(ADB, ["-s", "emulator-5554", "shell", "am", "start", "-n", `${pkg}/${activity}`], { timeout: 30_000 });
                } catch (e: any) {
                  launchErrors.push(`${activity}: ${String(e?.message ?? e)}`);
                }
              }

              let inventory: any = null;
              for (let attempt = 0; attempt < 10; attempt++) {
                const probed = await call("list_spatial_panels", {
                  packageFilter: pkg,
                  expectedActivities: panelPlan.activities,
                  serial: "emulator-5554",
                }).catch((e: any) => ({ status: "error", error: String(e?.message ?? e), panels: [] }));
                inventory = typeof probed === "object" && probed !== null
                  ? probed
                  : { status: "error", error: String(probed), panels: [] };
                if (inventory.status === "error" || inventory.expectationMet === true) break;
                await new Promise((r) => setTimeout(r, 1000));
              }

              const matchedActivities = Array.isArray(inventory?.matchedActivities) ? inventory.matchedActivities : [];
              const missingActivities = Array.isArray(inventory?.missingActivities)
                ? inventory.missingActivities
                : panelPlan.activities.filter((a) => !matchedActivities.includes(a));
              const inventoryExpectationMet = inventory?.status === "ok" && inventory?.expectationMet === true;
              const panelExpectationMet = inventoryExpectationMet && mappingMultiplicityMet;
              rec.panelEvidence = {
                evidenceType: "structural",
                status: inventory?.status === "ok" ? "ok" : "error",
                discovery: inventory,
                expectedActivities: panelPlan.activities,
                expectedPanelCount: panelPlan.mappings.length,
                nodeMappings: panelPlan.mappings,
                mappingMultiplicityMet,
                inventoryExpectationMet,
                matchedActivities,
                missingActivities,
                expectationMet: panelExpectationMet,
                runtimeReady: panelExpectationMet,
                panels: Array.isArray(inventory?.panels) ? inventory.panels : [],
                ...(inventory?.error ? { error: inventory.error } : {}),
                ...(launchErrors.length ? { launchErrors } : {}),
                proves: inventory?.proves ?? "WindowManager caption/container readiness only",
                doesNotProve: inventory?.doesNotProve ?? ["panel pixels", "panel content", "layout", "colors", "legibility", "camera framing"],
              };
              rec.notes.push(
                rec.panelEvidence.expectationMet
                  ? `panelReady structural: ${matchedActivities.join(", ")}`
                  : `panelReady structural NOT proven: ${missingActivities.join(", ") || inventory?.error || "inventory incomplete"}`,
              );

              try {
                await new Promise((r) => setTimeout(r, 800));
                const panelShot = path.join(shotDir, "panel-time.png");
                const panelPng = await run(ADB, ["-s", "emulator-5554", "exec-out", "screencap", "-p"], { timeout: 30_000, encoding: "buffer" as any, maxBuffer: 32 * 1024 * 1024 });
                const bytes = panelPng.stdout as any;
                if (bytes?.length >= 1000) {
                  fs.writeFileSync(panelShot, bytes);
                  rec.panelArtifact = panelShot;
                  rec.panelEvidence.artifactPath = panelShot;
                  rec.panelEvidence.artifactScope = "unjudged panel-time display capture — linked for inspection, NOT auto_judged or vision_verified";
                } else {
                  rec.notes.push(`panel-time capture failed (${bytes?.length ?? 0} bytes)`);
                }
              } catch (e: any) {
                rec.notes.push(`panel-time capture error: ${String(e?.message ?? e).slice(0, 180)}`);
              }
            }
          } catch (e: any) {
            rec.notes.push(`error: ${String(e?.message ?? e).slice(0, 300)}`);
          }
        }
      } finally {
        await client.close().catch(() => {});
      }
      const passed = results.filter((r) => r.verdict === "PASS").length;
      // A brief that never built cannot appear in `escalations`, which filters on r.installed. That
      // let the top level report status "ok" with an empty escalation list while NOTHING was built —
      // the caller had to dig into results[].notes to discover total failure. `status` now reflects
      // the outcome and unbuilt briefs are surfaced by name with the reason attached.
      const unbuilt = results.filter((r) => !r.built);
      return okJson({
        status: unbuilt.length === 0 ? "ok" : unbuilt.length === results.length ? "failed" : "partial",
        dashboard: {
          queued: briefIds.length,
          built: results.filter((r) => r.built).length,
          installed: results.filter((r) => r.installed).length,
          autoJudgedPass: passed,
          panelReadyStructural: results.filter((r) => r.panelEvidence?.expectationMet === true).length,
          notBuilt: unbuilt.map((r) => ({ id: r.id, why: r.notes?.[0] ?? "no reason recorded" })),
          escalations: results
            .filter((r) => r.installed && r.verificationRoute?.mode !== "panel-structural" && r.verdict !== "PASS")
            .map((r) => r.id),
        },
        results,
        honesty: "auto_judged is a DISTINCT evidence class — a fleet PASS is the stage eye's count, never human sight. Panel-only routes leave verdict unscored; panelEvidence/panelReadyStructural are WindowManager STRUCTURAL evidence only, and panelArtifact is unjudged. ESCALATEd visuals need a human LOOK.",
      });
    },
  );
}
