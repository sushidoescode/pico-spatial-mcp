import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bindMacQemuWindow,
  frontmostQemu,
  type BoundQemuWindow,
  type QemuWindowBindingResult,
} from "./cameradrive.js";
import { resolveAdb } from "./emulatorlook.js";
import type { HomeEnvironment, HomeEnvironmentDataset } from "./homeenvironmentcatalog.js";
import { run } from "./util.js";

export interface HostDialogLabel {
  label: string;
  center: [number, number];
}

export interface HostPickerDialog {
  ownerPid: number;
  windowId: number;
  correlatedWindowCount: number;
  title: string;
  headingFound: boolean;
  frame: { x: number; y: number; width: number; height: number };
  labels: HostDialogLabel[];
  closeControlId: string;
}

export type HostReceipt = {
  action: "bind" | "focus" | "open_picker" | "dialog_guard" | "capture_preflight" | "click" | "capture" | "close" | "close_verify";
  status: "ok" | "failed";
  detail: string;
};

export type HostSelectionResult =
  | { status: "manual_switch_required"; targetTile: string; detail: string; baselineSafe: true }
  | { status: "host_selection_not_observed"; targetTile: string; selectedTile: null; detail: string; receipts: HostReceipt[] }
  | { status: "host_selection_observed"; targetTile: string; afterDialogSha256: string; receipts: HostReceipt[]; close: { closed: true } };

export type HostSelectionTarget = Pick<HomeEnvironment, "tile" | "selectedDialogSha256" | "measuredClickPoint"> & {
  serial: string;
};
export type HostEnvironmentPicker = HomeEnvironmentDataset["picker"];

type GuardResult = { ok: true } | { ok: false; detail: string };
export type ScenePickerMatchAttribute = "AXIdentifier" | "AXTitle" | "AXDescription";
export type ScenePickerMatchScope = "bound_window_descendants" | "application_tree";
type OpenPickerResult =
  | { ok: true; matchedAttribute: ScenePickerMatchAttribute; matchedScope: ScenePickerMatchScope }
  | { ok: false; detail: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseGuardResult(value: unknown): GuardResult {
  if (isRecord(value) && value.ok === true) return { ok: true };
  if (isRecord(value) && value.ok === false && typeof value.detail === "string" && value.detail.length > 0) {
    return { ok: false, detail: value.detail };
  }
  throw new Error("invalid helper payload: expected {ok:true} or {ok:false,detail:string}");
}

function parseOpenPickerResult(value: unknown): OpenPickerResult {
  if (isRecord(value) && value.ok === true
    && (value.matchedAttribute === "AXIdentifier" || value.matchedAttribute === "AXTitle" || value.matchedAttribute === "AXDescription")
    && (value.matchedScope === "bound_window_descendants" || value.matchedScope === "application_tree")) {
    return {
      ok: true,
      matchedAttribute: value.matchedAttribute,
      matchedScope: value.matchedScope,
    };
  }
  if (isRecord(value) && value.ok === false && typeof value.detail === "string" && value.detail.length > 0) {
    return { ok: false, detail: value.detail };
  }
  throw new Error("invalid picker helper payload: expected match attribute and scope on success, or a non-empty failure detail");
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseDialogList(value: unknown): HostPickerDialog[] {
  if (!Array.isArray(value)) throw new Error("invalid dialog helper payload: expected an array");
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`invalid dialog helper payload at index ${index}: expected an object`);
    const candidate = entry as Record<string, unknown>;
    const rawFrame = candidate.frame;
    const rawLabels = candidate.labels;
    if (!Number.isInteger(candidate.ownerPid) || (candidate.ownerPid as number) <= 0
      || !Number.isInteger(candidate.windowId) || (candidate.windowId as number) < 0
      || !Number.isInteger(candidate.correlatedWindowCount) || (candidate.correlatedWindowCount as number) < 0
      || typeof candidate.title !== "string"
      || typeof candidate.headingFound !== "boolean"
      || typeof candidate.closeControlId !== "string"
      || !isRecord(rawFrame)
      || !finiteNumber(rawFrame.x) || !finiteNumber(rawFrame.y)
      || !finiteNumber(rawFrame.width) || rawFrame.width <= 0
      || !finiteNumber(rawFrame.height) || rawFrame.height <= 0
      || !Array.isArray(rawLabels)) {
      throw new Error(`invalid dialog helper payload at index ${index}: malformed identity, frame, labels, or close control`);
    }
    rawLabels.forEach((label, labelIndex) => {
      if (!isRecord(label) || typeof label.label !== "string" || !Array.isArray(label.center)
        || label.center.length !== 2 || !finiteNumber(label.center[0]) || !finiteNumber(label.center[1])) {
        throw new Error(`invalid dialog helper payload at index ${index}, label ${labelIndex}`);
      }
    });
    return entry as unknown as HostPickerDialog;
  });
}

function parseDisappearanceResult(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("invalid disappearance helper payload: expected a boolean");
  return value;
}

function parsePresencePayload(value: unknown): boolean {
  if (!isRecord(value) || typeof value.present !== "boolean") {
    throw new Error("invalid disappearance helper payload: expected {present:boolean}");
  }
  return value.present;
}

export interface HomeEnvironmentHostDependencies {
  platform: string;
  bindQemuWindow(serial: string): Promise<QemuWindowBindingResult>;
  focusQemu(binding: BoundQemuWindow): Promise<string | null>;
  openPicker(binding: BoundQemuWindow): Promise<OpenPickerResult>;
  listPickerDialogs(binding: BoundQemuWindow): Promise<HostPickerDialog[]>;
  preflightCapture(dialog: HostPickerDialog): Promise<GuardResult>;
  click(binding: BoundQemuWindow, dialog: HostPickerDialog, absolutePoint: [number, number]): Promise<string | null>;
  capture(dialog: HostPickerDialog): Promise<Buffer>;
  hash(bytes: Buffer): string;
  close(binding: BoundQemuWindow, dialog: HostPickerDialog): Promise<GuardResult>;
  isDialogPresent(binding: BoundQemuWindow, dialog: HostPickerDialog): Promise<boolean>;
}

function manual(targetTile: string, detail: string): HostSelectionResult {
  return { status: "manual_switch_required", targetTile, detail, baselineSafe: true };
}

function notObserved(targetTile: string, detail: string, receipts: HostReceipt[]): HostSelectionResult {
  return { status: "host_selection_not_observed", targetTile, selectedTile: null, detail, receipts };
}

function samePoint(left: readonly number[], right: readonly number[]): boolean {
  return left.length === 2 && right.length === 2 && left[0] === right[0] && left[1] === right[1];
}

function exactBindingFailure(requestedSerial: string, binding: BoundQemuWindow): string | null {
  if (!Array.isArray(binding.onlineEmulatorSerials) || !binding.onlineEmulatorSerials.includes(requestedSerial)) {
    return `exact binding identity rejected: requested serial '${requestedSerial}' is not in the online emulator set`;
  }
  if (binding.discoveredSerial !== requestedSerial) {
    return `exact binding identity rejected: requested serial '${requestedSerial}' does not equal discovered serial '${binding.discoveredSerial}'`;
  }
  if (!Number.isInteger(binding.qemuPid) || (binding.qemuPid ?? 0) <= 0) {
    return `exact binding identity rejected: discovery did not provide a positive qemu PID`;
  }
  if (!Number.isInteger(binding.qemuWindowOwnerPid) || binding.qemuWindowOwnerPid <= 0 || binding.qemuPid !== binding.qemuWindowOwnerPid) {
    return `exact binding identity rejected: discovery qemu PID ${binding.qemuPid} does not equal bound window owner PID ${binding.qemuWindowOwnerPid}`;
  }
  if (binding.bindingMethod !== "discovery-pid-window") {
    return `exact binding identity rejected: binding method '${binding.bindingMethod}' did not use discovery PID correlation`;
  }
  return null;
}

function validateDialog(
  dialog: HostPickerDialog,
  binding: BoundQemuWindow,
  picker: HostEnvironmentPicker,
): string | null {
  if (dialog.ownerPid !== binding.qemuWindowOwnerPid) {
    return `Environment Preview dialog PID ${dialog.ownerPid} does not match bound qemu PID ${binding.qemuWindowOwnerPid}`;
  }
  if (dialog.correlatedWindowCount !== 1 || !Number.isInteger(dialog.windowId) || dialog.windowId <= 0) {
    return `Environment Preview dialog did not correlate to exactly one CoreGraphics window`;
  }
  if (!dialog.headingFound || dialog.title !== picker.dialogTitle) {
    return `expected exact dialog heading '${picker.dialogTitle}'`;
  }
  if (dialog.frame.width !== picker.logicalDialogBounds.width || dialog.frame.height !== picker.logicalDialogBounds.height) {
    return `expected exact ${picker.logicalDialogBounds.width}x${picker.logicalDialogBounds.height} dialog geometry`;
  }
  if (!dialog.closeControlId) return "Environment Preview AX close control was not found";
  if (dialog.labels.length !== picker.accessibleLabels.length) {
    return `expected ${picker.accessibleLabels.length} accessible environment labels, found ${dialog.labels.length}`;
  }
  const counts = new Map<string, number>();
  for (const label of dialog.labels) counts.set(label.label, (counts.get(label.label) ?? 0) + 1);
  for (const expected of picker.accessibleLabels) {
    if (counts.get(expected) !== 1) return `accessible label '${expected}' must appear exactly once`;
    const actual = dialog.labels.find((entry) => entry.label === expected)!;
    const expectedRelative = picker.measuredTileCenterPoints[expected];
    const actualRelative: [number, number] = [actual.center[0] - dialog.frame.x, actual.center[1] - dialog.frame.y];
    if (!expectedRelative || !samePoint(actualRelative, expectedRelative)) {
      return `accessible label '${expected}' is not at its measured dataset-relative position`;
    }
  }
  if ([...counts.keys()].some((label) => !picker.accessibleLabels.includes(label as typeof picker.accessibleLabels[number]))) {
    return "Environment Preview contains an unexpected accessible label";
  }
  return null;
}

function isPickerDialogCandidate(
  dialog: HostPickerDialog,
  binding: BoundQemuWindow,
  picker: HostEnvironmentPicker,
): boolean {
  return dialog.ownerPid === binding.qemuWindowOwnerPid
    && dialog.correlatedWindowCount === 1
    && Number.isInteger(dialog.windowId)
    && dialog.windowId > 0
    && dialog.headingFound
    && dialog.title === picker.dialogTitle
    && dialog.frame.width === picker.logicalDialogBounds.width
    && dialog.frame.height === picker.logicalDialogBounds.height;
}

async function focusFailure(
  deps: HomeEnvironmentHostDependencies,
  binding: BoundQemuWindow,
): Promise<string | null> {
  try {
    return await deps.focusQemu(binding);
  } catch (error: any) {
    return `qemu focus failed: ${error?.message ?? String(error)}`;
  }
}

async function closeStoredDialog(
  binding: BoundQemuWindow,
  dialog: HostPickerDialog,
  deps: HomeEnvironmentHostDependencies,
  receipts: HostReceipt[],
): Promise<string | null> {
  let closed: GuardResult;
  try {
    closed = parseGuardResult(await deps.close(binding, dialog));
  } catch (error: any) {
    closed = { ok: false, detail: error?.message ?? String(error) };
  }
  receipts.push({ action: "close", status: closed.ok ? "ok" : "failed", detail: closed.ok ? `pressed AX close for window ${dialog.windowId}` : closed.detail });
  if (!closed.ok) return `failed to close stored Environment Preview dialog: ${closed.detail}`;
  let present: boolean;
  try {
    present = parseDisappearanceResult(await deps.isDialogPresent(binding, dialog));
  } catch (error: any) {
    const detail = error?.message ?? String(error);
    receipts.push({ action: "close_verify", status: "failed", detail });
    return `could not verify stored Environment Preview dialog disappearance: ${detail}`;
  }
  receipts.push({ action: "close_verify", status: present ? "failed" : "ok", detail: present ? `window ${dialog.windowId} remains present` : `window ${dialog.windowId} disappeared` });
  return present ? `stored Environment Preview dialog ${dialog.windowId} did not disappear` : null;
}

/** Guarded host action only. A matching screenshot hash is a receipt, never environment identity. */
export async function executeGuardedHostSelection(
  target: HostSelectionTarget,
  picker: HostEnvironmentPicker,
  deps: HomeEnvironmentHostDependencies = defaultHomeEnvironmentHostDependencies(),
): Promise<HostSelectionResult> {
  if (deps.platform !== "darwin") return manual(target.tile, "guarded host selection requires macOS");
  const datasetPoint = picker.measuredTileCenterPoints[target.tile];
  if (!datasetPoint || !samePoint(datasetPoint, target.measuredClickPoint)) {
    return manual(target.tile, `target '${target.tile}' does not have one consistent packaged picker point`);
  }

  const receipts: HostReceipt[] = [];
  let selected: QemuWindowBindingResult;
  try {
    selected = await deps.bindQemuWindow(target.serial);
  } catch (error: any) {
    return manual(target.tile, `qemu binding failed: ${error?.message ?? String(error)}`);
  }
  if (!selected.ok) return manual(target.tile, `${selected.code}: ${selected.detail}`);
  const binding = selected.binding;
  const bindingFailure = exactBindingFailure(target.serial, binding);
  if (bindingFailure) return manual(target.tile, bindingFailure);
  receipts.push({ action: "bind", status: "ok", detail: `serial ${target.serial} -> PID ${binding.qemuWindowOwnerPid} -> main window ${binding.qemuWindowId}` });

  const firstFocus = await focusFailure(deps, binding);
  if (firstFocus) return manual(target.tile, firstFocus);
  receipts.push({ action: "focus", status: "ok", detail: `focused PID ${binding.qemuWindowOwnerPid}` });

  let opened: OpenPickerResult;
  try {
    opened = parseOpenPickerResult(await deps.openPicker(binding));
  } catch (error: any) {
    opened = { ok: false, detail: error?.message ?? String(error) };
  }
  if (!opened.ok) return manual(target.tile, opened.detail);
  receipts.push({
    action: "open_picker",
    status: "ok",
    detail: `pressed Accessibility select_scene_button via ${opened.matchedAttribute} in ${opened.matchedScope}`,
  });

  let dialogs: HostPickerDialog[];
  try {
    dialogs = parseDialogList(await deps.listPickerDialogs(binding));
  } catch (error: any) {
    return manual(target.tile, `Environment Preview inspection failed: ${error?.message ?? String(error)}`);
  }
  const candidates = dialogs.filter((dialog) => isPickerDialogCandidate(dialog, binding, picker));
  if (candidates.length !== 1) return manual(target.tile, `expected exactly one bound Environment Preview dialog, found ${candidates.length}`);
  const dialog = candidates[0];
  const invalidDialog = validateDialog(dialog, binding, picker);
  if (invalidDialog) return manual(target.tile, invalidDialog);
  receipts.push({ action: "dialog_guard", status: "ok", detail: `PID ${dialog.ownerPid} window ${dialog.windowId}; exact title, geometry, close control, labels, and positions` });

  let preflight: GuardResult;
  try {
    preflight = parseGuardResult(await deps.preflightCapture(dialog));
  } catch (error: any) {
    preflight = { ok: false, detail: error?.message ?? String(error) };
  }
  if (!preflight.ok) return manual(target.tile, `bound-window capture preflight failed: ${preflight.detail}`);
  receipts.push({ action: "capture_preflight", status: "ok", detail: `captured exact bound dialog window ${dialog.windowId} before click` });

  const secondFocus = await focusFailure(deps, binding);
  if (secondFocus) return manual(target.tile, secondFocus);
  receipts.push({ action: "focus", status: "ok", detail: `refocused PID ${binding.qemuWindowOwnerPid}` });

  const absolutePoint: [number, number] = [dialog.frame.x + datasetPoint[0], dialog.frame.y + datasetPoint[1]];
  let clickError: string | null;
  try {
    clickError = await deps.click(binding, dialog, absolutePoint);
  } catch (error: any) {
    clickError = error?.message ?? String(error);
  }
  receipts.push({ action: "click", status: clickError ? "failed" : "ok", detail: clickError ?? `one click at relative [${datasetPoint.join(",")}] / absolute [${absolutePoint.join(",")}]` });

  let observationFailure = clickError ? `CGEvent click was not acknowledged: ${clickError}` : null;
  let afterDialogSha256: string | null = null;
  if (!observationFailure) {
    try {
      const bytes = await deps.capture(dialog);
      afterDialogSha256 = deps.hash(bytes);
      const hashMatches = afterDialogSha256 === target.selectedDialogSha256;
      receipts.push({ action: "capture", status: hashMatches ? "ok" : "failed", detail: `window ${dialog.windowId} sha256 ${afterDialogSha256}` });
      if (!hashMatches) observationFailure = `selected-dialog hash mismatch: expected ${target.selectedDialogSha256}, observed ${afterDialogSha256}`;
    } catch (error: any) {
      const detail = error?.message ?? String(error);
      receipts.push({ action: "capture", status: "failed", detail });
      observationFailure = `post-click bound-window capture failed: ${detail}`;
    }
  }

  const closeFailure = await closeStoredDialog(binding, dialog, deps, receipts);
  if (observationFailure || closeFailure || afterDialogSha256 === null) {
    return notObserved(target.tile, [observationFailure, closeFailure].filter(Boolean).join("; "), receipts);
  }
  return {
    status: "host_selection_observed",
    targetTile: target.tile,
    afterDialogSha256,
    receipts,
    close: { closed: true },
  };
}

export const AX_SCENE_PICKER_MATCHER_SWIFT = String.raw`struct ScenePickerAttributeNeedle {
  let attribute: String
  let exactValue: String
}

struct ScenePickerSearchScope<Node> {
  let name: String
  let nodes: () -> [Node]
}

struct ScenePickerControlMatch<Node> {
  let node: Node
  let matchedAttribute: String
  let matchedScope: String
}

let scenePickerAttributeNeedles = [
  ScenePickerAttributeNeedle(attribute: "AXIdentifier", exactValue: "select_scene_button"),
  ScenePickerAttributeNeedle(attribute: "AXTitle", exactValue: "select_scene_button"),
  ScenePickerAttributeNeedle(attribute: "AXDescription", exactValue: "PICO OS Emulator Scene"),
]

let scenePickerControlNotFoundDetail = "select_scene_button was not found by exact match; searched AXIdentifier, AXTitle, and AXDescription in bound_window_descendants, then application_tree"

func exactScenePickerControlMatch<Node>(
  scopes: [ScenePickerSearchScope<Node>],
  readStringAttribute: (Node, String) -> String?
) -> ScenePickerControlMatch<Node>? {
  for scope in scopes {
    let nodes = scope.nodes()
    for needle in scenePickerAttributeNeedles {
      if let node = nodes.first(where: { candidate in
        guard let value = readStringAttribute(candidate, needle.attribute) else { return false }
        return value == needle.exactValue
      }) {
        return ScenePickerControlMatch(
          node: node,
          matchedAttribute: needle.attribute,
          matchedScope: scope.name)
      }
    }
  }
  return nil
}
`;

export const AX_SCENE_PICKER_HELPER_SWIFT = String.raw`import ApplicationServices
import CoreGraphics
import Foundation

${AX_SCENE_PICKER_MATCHER_SWIFT}

let args = CommandLine.arguments
let action = args[1]
let pid = pid_t(Int(args[2])!)
var helperFailure: String? = nil

func emit(_ object: Any) {
  let data = try! JSONSerialization.data(withJSONObject: object, options: [])
  print(String(data: data, encoding: .utf8)!)
}

guard AXIsProcessTrusted() else {
  emit(["ok": false, "detail": "Accessibility permission denied"])
  exit(2)
}

func recordHelperFailure(_ detail: String) {
  if helperFailure == nil { helperFailure = detail }
}

func exitIfHelperFailed(_ code: Int32) {
  if let detail = helperFailure {
    emit(["ok": false, "detail": detail] as [String: Any])
    exit(code)
  }
}

func attribute(_ element: AXUIElement, _ name: String, required: Bool = false) -> CFTypeRef? {
  var value: CFTypeRef?
  let result = AXUIElementCopyAttributeValue(element, name as CFString, &value)
  if result == .success { return value }
  if required || (result != .noValue && result != .attributeUnsupported) {
    recordHelperFailure("AX attribute '\(name)' query failed: \(result.rawValue)")
  }
  return nil
}

func stringAttribute(_ element: AXUIElement, _ name: String) -> String? {
  return attribute(element, name) as? String
}

func children(_ element: AXUIElement) -> [AXUIElement] {
  guard let raw = attribute(element, kAXChildrenAttribute) else { return [] }
  guard let result = raw as? [AXUIElement] else {
    recordHelperFailure("AX children attribute returned a non-array value")
    return []
  }
  return result
}

func appWindows(_ app: AXUIElement) -> [AXUIElement] {
  guard let raw = attribute(app, kAXWindowsAttribute, required: true) else { return [] }
  guard let result = raw as? [AXUIElement] else {
    recordHelperFailure("AX windows attribute returned a non-array value")
    return []
  }
  return result
}

func descendants(_ root: AXUIElement) -> [AXUIElement] {
  var result: [AXUIElement] = []
  var queue = [root]
  var visited = Set<CFHashCode>()
  while !queue.isEmpty && result.count < 5000 {
    let next = queue.removeFirst()
    let key = CFHash(next)
    if visited.contains(key) { continue }
    visited.insert(key)
    result.append(next)
    queue.append(contentsOf: children(next))
  }
  return result
}

func frame(_ element: AXUIElement) -> CGRect? {
  guard let positionValue = attribute(element, kAXPositionAttribute),
        let sizeValue = attribute(element, kAXSizeAttribute),
        CFGetTypeID(positionValue) == AXValueGetTypeID(),
        CFGetTypeID(sizeValue) == AXValueGetTypeID() else { return nil }
  let position = positionValue as! AXValue
  let size = sizeValue as! AXValue
  var point = CGPoint.zero
  var dimensions = CGSize.zero
  guard AXValueGetValue(position, .cgPoint, &point), AXValueGetValue(size, .cgSize, &dimensions) else { return nil }
  return CGRect(origin: point, size: dimensions)
}

func text(_ element: AXUIElement) -> String? {
  return stringAttribute(element, kAXValueAttribute)
    ?? stringAttribute(element, kAXTitleAttribute)
    ?? stringAttribute(element, kAXDescriptionAttribute)
}

func cgWindows() -> [[String: Any]] {
  guard let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) else {
    recordHelperFailure("CoreGraphics window enumeration returned nil")
    return []
  }
  guard let result = raw as? [[String: Any]] else {
    recordHelperFailure("CoreGraphics window enumeration returned a malformed value")
    return []
  }
  return result
}

func matchingCgWindowIds(_ targetFrame: CGRect) -> [Int] {
  return cgWindows().compactMap { window in
    guard (window[kCGWindowOwnerPID as String] as? Int) == Int(pid),
          let id = window[kCGWindowNumber as String] as? Int,
          let bounds = window[kCGWindowBounds as String] as? [String: Any] else { return nil }
    let candidate = CGRect(
      x: bounds["X"] as? Double ?? -1,
      y: bounds["Y"] as? Double ?? -1,
      width: bounds["Width"] as? Double ?? -1,
      height: bounds["Height"] as? Double ?? -1)
    return candidate.equalTo(targetFrame) ? id : nil
  }
}

let app = AXUIElementCreateApplication(pid)

if action == "open" {
  let boundWindowId = Int(args[3])!
  let boundWindows = appWindows(app).filter { window in
    guard let windowFrame = frame(window) else { return false }
    return matchingCgWindowIds(windowFrame) == [boundWindowId]
  }
  let boundWindowNodes = boundWindows.flatMap { descendants($0) }
  exitIfHelperFailed(9)
  let control = exactScenePickerControlMatch(scopes: [
    ScenePickerSearchScope(name: "bound_window_descendants", nodes: { boundWindowNodes }),
    ScenePickerSearchScope(name: "application_tree", nodes: { descendants(app) }),
  ]) { element, attributeName in
    stringAttribute(element, attributeName)
  }
  exitIfHelperFailed(9)
  guard let control else {
    emit(["ok": false, "detail": scenePickerControlNotFoundDetail])
    exit(3)
  }
  let result = AXUIElementPerformAction(control.node, kAXPressAction as CFString)
  if result == .success {
    emit([
      "ok": true,
      "matchedAttribute": control.matchedAttribute,
      "matchedScope": control.matchedScope,
    ] as [String: Any])
  } else {
    emit([
      "ok": false,
      "detail": "AX press select_scene_button via \(control.matchedAttribute) in \(control.matchedScope) failed: \(result.rawValue)",
    ] as [String: Any])
  }
  exit(result == .success ? 0 : 4)
}

if action == "list" {
  let expectedTitle = args[3]
  let expectedLabels = try! JSONSerialization.jsonObject(with: Data(args[4].utf8)) as! [String]
  let windows = appWindows(app)
  exitIfHelperFailed(10)
  var rows: [[String: Any]] = []
  for window in windows {
    guard let windowFrame = frame(window) else { continue }
    let nodes = descendants(window)
    let headingFound = nodes.contains { text($0) == expectedTitle }
    let close = nodes.first {
      stringAttribute($0, kAXSubroleAttribute) == kAXCloseButtonSubrole
        || (stringAttribute($0, kAXRoleAttribute) == kAXButtonRole && (text($0) ?? "").lowercased() == "close")
    }
    var labels: [[String: Any]] = []
    for expected in expectedLabels {
      for node in nodes where stringAttribute(node, kAXRoleAttribute) == kAXStaticTextRole && text(node) == expected {
        if let labelFrame = frame(node) {
          labels.append(["label": expected, "center": [labelFrame.midX, labelFrame.midY]])
        }
      }
    }
    let ids = matchingCgWindowIds(windowFrame)
    rows.append([
      "ownerPid": Int(pid),
      "windowId": ids.count == 1 ? ids[0] : 0,
      "correlatedWindowCount": ids.count,
      "title": headingFound ? expectedTitle : (stringAttribute(window, kAXTitleAttribute) ?? ""),
      "headingFound": headingFound,
      "frame": ["x": windowFrame.origin.x, "y": windowFrame.origin.y, "width": windowFrame.width, "height": windowFrame.height],
      "labels": labels,
      "closeControlId": close == nil ? "" : "pid:\(pid):window:\(ids.first ?? 0):close",
    ])
  }
  exitIfHelperFailed(10)
  emit(rows)
  exit(0)
}

let windowId = Int(args[3])!
let expectedTitle = args[4]
let expectedFrame = CGRect(x: Double(args[5])!, y: Double(args[6])!, width: Double(args[7])!, height: Double(args[8])!)

func storedWindow() -> AXUIElement? {
  let windows = appWindows(app)
  return windows.first { window in
    guard let candidateFrame = frame(window), candidateFrame.equalTo(expectedFrame) else { return false }
    let nodes = descendants(window)
    return nodes.contains { text($0) == expectedTitle } && matchingCgWindowIds(candidateFrame) == [windowId]
  }
}

if action == "close" {
  let stored = storedWindow()
  exitIfHelperFailed(11)
  guard let window = stored else {
    emit(["ok": false, "detail": "stored dialog identity is no longer uniquely present"])
    exit(5)
  }
  let close = descendants(window).first {
    stringAttribute($0, kAXSubroleAttribute) == kAXCloseButtonSubrole
      || (stringAttribute($0, kAXRoleAttribute) == kAXButtonRole && (text($0) ?? "").lowercased() == "close")
  }
  exitIfHelperFailed(11)
  guard let close else {
    emit(["ok": false, "detail": "stored dialog AX close control was not found"])
    exit(6)
  }
  let result = AXUIElementPerformAction(close, kAXPressAction as CFString)
  if result == .success {
    emit(["ok": true])
  } else {
    emit(["ok": false, "detail": "AX close press failed: \(result.rawValue)"] as [String: Any])
  }
  exit(result == .success ? 0 : 7)
}

if action == "present" {
  let stored = storedWindow()
  exitIfHelperFailed(12)
  emit(["present": stored != nil])
  exit(0)
}

emit(["ok": false, "detail": "unsupported helper action"])
exit(8)
`;

const CLICK_SWIFT = String.raw`import ApplicationServices
import CoreGraphics
import Foundation
let args = CommandLine.arguments
let pid = Int(args[1])!, windowId = Int(args[2])!
let point = CGPoint(x: Double(args[3])!, y: Double(args[4])!)
let expected = CGRect(x: Double(args[5])!, y: Double(args[6])!, width: Double(args[7])!, height: Double(args[8])!)
guard AXIsProcessTrusted() else { print("ACCESSIBILITY_DENIED"); exit(2) }
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
let matches = windows.filter { window in
  guard (window[kCGWindowOwnerPID as String] as? Int) == pid,
        (window[kCGWindowNumber as String] as? Int) == windowId,
        let bounds = window[kCGWindowBounds as String] as? [String: Any] else { return false }
  let candidate = CGRect(x: bounds["X"] as? Double ?? -1, y: bounds["Y"] as? Double ?? -1, width: bounds["Width"] as? Double ?? -1, height: bounds["Height"] as? Double ?? -1)
  return candidate.equalTo(expected)
}
guard matches.count == 1, expected.contains(point) else { print("STORED_DIALOG_MISMATCH"); exit(3) }
guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
      let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else { exit(4) }
down.post(tap: .cghidEventTap)
usleep(20000)
up.post(tap: .cghidEventTap)
print("ok")
`;

async function runTemporarySwift(source: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pico-homeenvironment-"));
  const script = path.join(scratch, "helper.swift");
  fs.writeFileSync(script, source);
  try {
    const result = await run("swift", [script, ...args], { timeoutMs: 30_000, maxOutputBytes: 1_000_000 });
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("macOS helper returned no JSON");
  return JSON.parse(trimmed);
}

function dialogArgs(dialog: HostPickerDialog): string[] {
  return [
    String(dialog.windowId),
    dialog.title,
    String(dialog.frame.x),
    String(dialog.frame.y),
    String(dialog.frame.width),
    String(dialog.frame.height),
  ];
}

async function captureExactWindow(dialog: HostPickerDialog): Promise<Buffer> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pico-homeenvironment-capture-"));
  const output = path.join(scratch, "dialog.png");
  try {
    const captured = await run("screencapture", ["-o", "-x", `-l${dialog.windowId}`, output], { timeoutMs: 30_000 });
    if (captured.code !== 0 || captured.timedOut || !fs.existsSync(output)) {
      throw new Error(captured.stderr || captured.stdout || "screencapture produced no file");
    }
    const bytes = fs.readFileSync(output);
    if (bytes.length === 0) throw new Error("screencapture produced an empty PNG");
    return bytes;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** Bind the injected state machine to macOS Accessibility, CoreGraphics, and screencapture. */
export function defaultHomeEnvironmentHostDependencies(): HomeEnvironmentHostDependencies {
  return {
    platform: process.platform,
    bindQemuWindow: (serial) => bindMacQemuWindow(resolveAdb(), serial),
    focusQemu: (binding) => frontmostQemu(binding),
    openPicker: async (binding) => {
      const result = await runTemporarySwift(AX_SCENE_PICKER_HELPER_SWIFT, [
        "open",
        String(binding.qemuWindowOwnerPid),
        String(binding.qemuWindowId),
      ]);
      const parsed = parseOpenPickerResult(parseJsonOutput(result.stdout));
      return result.code === 0 && parsed.ok ? parsed : { ok: false, detail: !parsed.ok ? parsed.detail : (result.stderr || "Accessibility helper failed") };
    },
    listPickerDialogs: async (binding) => {
      const packaged = (await import("./homeenvironmentcatalog.js")).loadPackagedHomeEnvironmentDataset().picker;
      const result = await runTemporarySwift(AX_SCENE_PICKER_HELPER_SWIFT, [
        "list",
        String(binding.qemuWindowOwnerPid),
        packaged.dialogTitle,
        JSON.stringify(packaged.accessibleLabels),
      ]);
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Accessibility dialog inspection failed");
      return parseDialogList(parseJsonOutput(result.stdout));
    },
    preflightCapture: async (dialog) => {
      try {
        await captureExactWindow(dialog);
        return { ok: true };
      } catch (error: any) {
        return { ok: false, detail: error?.message ?? String(error) };
      }
    },
    click: async (binding, dialog, absolutePoint) => {
      const result = await runTemporarySwift(CLICK_SWIFT, [
        String(binding.qemuWindowOwnerPid),
        String(dialog.windowId),
        String(absolutePoint[0]),
        String(absolutePoint[1]),
        String(dialog.frame.x),
        String(dialog.frame.y),
        String(dialog.frame.width),
        String(dialog.frame.height),
      ]);
      return result.code === 0 ? null : result.stderr || result.stdout || "CGEvent click failed";
    },
    capture: captureExactWindow,
    hash: (bytes) => createHash("sha256").update(bytes).digest("hex"),
    close: async (binding, dialog) => {
      const result = await runTemporarySwift(AX_SCENE_PICKER_HELPER_SWIFT, ["close", String(binding.qemuWindowOwnerPid), ...dialogArgs(dialog)]);
      const parsed = parseGuardResult(parseJsonOutput(result.stdout));
      return result.code === 0 && parsed.ok ? parsed : { ok: false, detail: !parsed.ok ? parsed.detail : (result.stderr || "AX close failed") };
    },
    isDialogPresent: async (binding, dialog) => {
      const result = await runTemporarySwift(AX_SCENE_PICKER_HELPER_SWIFT, ["present", String(binding.qemuWindowOwnerPid), ...dialogArgs(dialog)]);
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || "dialog disappearance probe failed");
      return parsePresencePayload(parseJsonOutput(result.stdout));
    },
  };
}
