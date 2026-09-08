import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { run } from "./util.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const packageSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/);
const stageStyleSchema = z.enum(["1", "3"]);
const apkPathSchema = z.string().min(1).refine(
  (value) => path.isAbsolute(value) && path.normalize(value) === value,
  "imported APK path must be normalized and absolute",
);

/** Caller-supplied identity; validation always reads the APK, never a project source manifest. */
export const importedApkProvenanceSchema = z.object({
  kind: z.literal("imported_apk"),
  apkPath: apkPathSchema,
  apkSha256: sha256Schema,
  packageName: packageSchema,
  declaredStageStyle: stageStyleSchema,
  inventoryObservedAt: z.string().datetime({ offset: true }).optional(),
}).strict();
export type ImportedApkProvenance = z.infer<typeof importedApkProvenanceSchema>;

export const importedApkReceiptSchema = importedApkProvenanceSchema.extend({
  evidenceCeiling: z.literal("structural"),
  manifestInspection: z.object({
    tool: z.literal("aapt2"),
    manifestPath: z.literal("AndroidManifest.xml"),
    packageName: packageSchema,
    declaredStageStyle: stageStyleSchema,
    launchComponent: z.string().min(1).nullable(),
    stageStyleSource: z.enum(["activity", "activity_alias", "application"]),
    manifestDumpSha256: sha256Schema,
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.packageName !== value.manifestInspection.packageName
    || value.declaredStageStyle !== value.manifestInspection.declaredStageStyle) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "imported APK manifest inspection contradicts its provenance" });
  }
});
export type ImportedApkReceipt = z.infer<typeof importedApkReceiptSchema>;

function hashApk(apkPath: string): string {
  const before = fs.lstatSync(apkPath);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > 2 * 1024 ** 3) {
    throw new Error("imported APK must be a nonempty regular file no larger than 2 GiB");
  }
  const fd = fs.openSync(apkPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("imported APK changed while opening");
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let bytes = 0;
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      bytes += count;
      if (bytes > before.size) throw new Error("imported APK grew during hashing");
      hash.update(buffer.subarray(0, count));
    }
    const after = fs.fstatSync(fd);
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs) throw new Error("imported APK changed during hashing");
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

function resolveAapt2(): string {
  const configured = [process.env.ANDROID_SDK_ROOT, process.env.ANDROID_HOME].filter((value): value is string => !!value);
  const roots = configured.length ? configured : [
    path.join(os.homedir(), "Library", "Android", "sdk"),
    path.join(os.homedir(), "Android", "Sdk"),
    ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, "Android", "Sdk")] : []),
  ];
  for (const root of roots) {
    const directory = path.join(root, "build-tools");
    let versions: string[];
    try {
      versions = fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory())
        .map((entry) => entry.name).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    } catch { continue; }
    for (const version of versions) {
      const candidate = path.join(directory, version, process.platform === "win32" ? "aapt2.exe" : "aapt2");
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* try the next installed version */ }
    }
  }
  throw new Error("imported APK manifest inspection requires Android SDK build-tools/aapt2; set ANDROID_SDK_ROOT or ANDROID_HOME");
}

export function canonicalApkComponent(packageName: string, value: string): string {
  const pieces = value.split("/");
  if (pieces.length > 2 || (pieces.length === 2 && pieces[0] !== packageName)) throw new Error("imported APK launch component package mismatch");
  const activity = pieces.at(-1)!;
  const qualified = activity.startsWith(".") ? `${packageName}${activity}`
    : activity.includes(".") ? activity : `${packageName}.${activity}`;
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/.test(qualified)) {
    throw new Error("imported APK manifest activity name is invalid");
  }
  return `${packageName}/${qualified.startsWith(`${packageName}.`) ? qualified.slice(packageName.length) : qualified}`;
}

/** Inspect the requested activity (or one manifest launcher), with application metadata fallback. */
export function parseImportedApkManifestDump(output: string, expected?: { packageName?: string; launchComponent?: string }): {
  packageName: string;
  declaredStageStyle: "1" | "3";
  launchComponent: string | null;
  stageStyleSource: "activity" | "activity_alias" | "application";
} {
  type Element = { depth: number; name: string; attributes: Map<string, string>; parent: Element | null };
  const elements: Element[] = [];
  const stack: Element[] = [];
  for (const line of output.split(/\r?\n/)) {
    const element = /^(\s*)E: ([A-Za-z][A-Za-z0-9_-]*)(?:\s|$)/.exec(line);
    if (element) {
      const depth = element[1].length;
      while (stack.length && stack.at(-1)!.depth >= depth) stack.pop();
      const node = { depth, name: element[2], attributes: new Map<string, string>(), parent: stack.at(-1) ?? null };
      elements.push(node);
      stack.push(node);
      continue;
    }
    const attribute = /^\s*A: ([^=]+)=(.*)$/.exec(line);
    if (!attribute || !stack.length) continue;
    const key = attribute[1].replace(/\(0x[a-f0-9]+\)$/, "");
    const value = attribute[2].trim();
    const node = stack.at(-1)!;
    if (node.attributes.has(key)) throw new Error("imported APK manifest contains duplicate attributes");
    node.attributes.set(key, value);
  }
  const manifests = elements.filter((element) => element.name === "manifest" && element.parent === null);
  if (manifests.length !== 1) throw new Error("imported APK manifest must contain one manifest root");
  const text = (value: string | undefined): string | null => value === undefined ? null
    : /^"([^"\r\n]*)"(?:\s+\(Raw: "[^"\r\n]*"\))?$/.exec(value)?.[1] ?? null;
  const android = (element: Element, name: string) => element.attributes.get(`http://schemas.android.com/apk/res/android:${name}`)
    ?? element.attributes.get(`android:${name}`);
  const packageName = text(manifests[0].attributes.get("package"));
  if (!packageName || !packageSchema.safeParse(packageName).success) throw new Error("imported APK manifest package is missing or invalid");
  if (expected?.packageName && packageName !== expected.packageName) throw new Error("imported APK manifest package mismatch");
  const expectedLaunchComponent = expected?.launchComponent;
  const applications = elements.filter((element) => element.name === "application" && element.parent === manifests[0]);
  if (applications.length !== 1) throw new Error("imported APK manifest must contain one application");
  const application = applications[0];
  if (android(application, "enabled") === "false") throw new Error("imported APK manifest application is disabled");
  const activities = elements.filter((element) => ["activity", "activity-alias"].includes(element.name) && element.parent === application);
  const componentFor = (element: Element): string => {
    const name = text(android(element, "name"));
    if (!name) throw new Error("imported APK manifest activity requires a literal name");
    return canonicalApkComponent(packageName, name);
  };
  let selected: Element | null = null;
  if (expectedLaunchComponent) {
    const expected = canonicalApkComponent(packageName, expectedLaunchComponent);
    const matches = activities.filter((element) => componentFor(element) === expected);
    if (matches.length !== 1) throw new Error("imported APK manifest does not uniquely declare the requested launch component");
    selected = matches[0];
  } else {
    const launchers = activities.filter((activity) => android(activity, "enabled") !== "false"
      && elements.some((filter) => filter.name === "intent-filter" && filter.parent === activity
        && elements.some((item) => item.parent === filter && item.name === "action" && text(android(item, "name")) === "android.intent.action.MAIN")
        && elements.some((item) => item.parent === filter && item.name === "category"
          && ["android.intent.category.LAUNCHER", "android.intent.category.INFO"].includes(text(android(item, "name")) ?? ""))));
    if (launchers.length > 1) throw new Error("imported APK manifest has ambiguous launch activities");
    if (launchers.length === 0) throw new Error("imported APK manifest has no launcher; an explicit launch component is required");
    selected = launchers[0];
  }
  if (selected && android(selected, "enabled") === "false") throw new Error("imported APK manifest launch activity is disabled");
  const styleDeclaration = (owner: Element | null): Element | null => {
    if (!owner) return null;
    const metadata = elements.filter((element) => element.name === "meta-data" && element.parent === owner);
    if (metadata.some((element) => text(android(element, "name")) === null)) {
      throw new Error("imported APK manifest metadata names must be literal; resource references are unsupported in the selected scope");
    }
    const declarations = metadata.filter((element) => text(android(element, "name")) === "pico.spatial.stage.style");
    if (declarations.length > 1) throw new Error("imported APK manifest stage style is ambiguous within its owning component");
    return declarations[0] ?? null;
  };
  const activityDeclaration = styleDeclaration(selected);
  const declaration = activityDeclaration ?? styleDeclaration(application);
  if (!declaration) throw new Error("imported APK manifest stage style is absent from the launch activity and application");
  if (android(declaration, "resource") !== undefined) {
    throw new Error("imported APK manifest stage style resource attributes are unsupported, including alongside a literal value");
  }
  const raw = android(declaration, "value");
  let declaredStageStyle = text(raw) ?? raw;
  if (declaredStageStyle && /^(?:\(type 0x10\))?0x[0-9a-f]+$/i.test(declaredStageStyle)) {
    declaredStageStyle = String(Number.parseInt(declaredStageStyle.replace(/^\(type 0x10\)/, ""), 16));
  }
  if (!stageStyleSchema.safeParse(declaredStageStyle).success) throw new Error("imported APK manifest stage style must be the literal 1 or 3; resource references are unsupported");
  return {
    packageName,
    declaredStageStyle: declaredStageStyle as "1" | "3",
    launchComponent: selected ? componentFor(selected) : null,
    stageStyleSource: activityDeclaration ? (selected!.name === "activity-alias" ? "activity_alias" : "activity") : "application",
  };
}

export async function validateImportedApk(
  raw: ImportedApkProvenance,
  expected: { packageName: string; declaredStageStyle: "1" | "3"; launchComponent?: string },
): Promise<ImportedApkReceipt> {
  const provenance = importedApkProvenanceSchema.parse(raw);
  if (provenance.packageName !== expected.packageName) throw new Error("imported APK provenance package mismatch");
  if (provenance.declaredStageStyle !== expected.declaredStageStyle) throw new Error("imported APK provenance stage style mismatch");
  if (hashApk(provenance.apkPath) !== provenance.apkSha256) throw new Error("imported APK sha256 mismatch");
  const inspected = await run(resolveAapt2(), ["dump", "xmltree", "--file", "AndroidManifest.xml", provenance.apkPath], {
    timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024,
  });
  if (inspected.code !== 0 || inspected.timedOut) throw new Error(`imported APK manifest inspection failed: ${inspected.stderr || inspected.stdout}`);
  const manifest = parseImportedApkManifestDump(inspected.stdout, expected);
  if (hashApk(provenance.apkPath) !== provenance.apkSha256) throw new Error("imported APK sha256 changed during manifest inspection");
  if (manifest.packageName !== expected.packageName) throw new Error("imported APK manifest package mismatch");
  if (manifest.declaredStageStyle !== expected.declaredStageStyle) throw new Error("imported APK manifest stage style mismatch");
  return importedApkReceiptSchema.parse({
    ...provenance,
    evidenceCeiling: "structural",
    manifestInspection: {
      tool: "aapt2", manifestPath: "AndroidManifest.xml", ...manifest,
      manifestDumpSha256: crypto.createHash("sha256").update(inspected.stdout).digest("hex"),
    },
  });
}
