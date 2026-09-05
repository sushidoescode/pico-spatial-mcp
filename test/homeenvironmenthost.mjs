import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import * as homeEnvironmentHost from "../dist/homeenvironmenthost.js";

const { executeGuardedHostSelection } = homeEnvironmentHost;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const selectedPng = Buffer.from("selected-dialog-png");
const wrongPng = Buffer.from("stale-dialog-png");

const picker = {
  dialogTitle: "Environment Preview",
  logicalDialogBounds: { x: 209, y: 276, width: 552, height: 440 },
  contactSheet: "all-six-selected-contact-sheet.png",
  contactSheetSha256: "4".repeat(64),
  selectionLog: "selection-scene-source.log",
  selectionLogSha256: "6".repeat(64),
  accessibleLabels: [
    "Bedroom Day",
    "Bedroom Night",
    "Livingroom Day",
    "Livingroom Night",
    "Mesume Day",
    "Mesume Night",
  ],
  measuredTileCenterPoints: {
    "Bedroom Day": [102, 121],
    "Bedroom Night": [276, 121],
    "Livingroom Day": [450, 121],
    "Livingroom Night": [102, 246],
    "Mesume Day": [276, 246],
    "Mesume Night": [450, 246],
  },
  measuredTileCenterPointsProvenance: {
    derivation: "derived_from_committed_552x440_dialog_contact_sheet_and_ax_layout",
    exactEmittedCgEventCoordinatesSeparatelyRecorded: false,
    note: "CP1 recorded that target centers were derived from the AX layout; it did not separately record the exact emitted CGEvent coordinates.",
  },
};

const target = {
  serial: "emulator-5554",
  tile: "Livingroom Day",
  selectedDialogSha256: sha256(selectedPng),
  measuredClickPoint: [450, 121],
};

const binding = {
  discoveryFile: "/tmp/pico-emulator/pid_93013.ini",
  discoveredSerial: "emulator-5554",
  qemuPid: 93013,
  address: "127.0.0.1:8554",
  tokenPresent: true,
  tokenFingerprint: "a".repeat(64),
  onlineEmulatorSerials: ["emulator-5554"],
  qemuWindowOwnerPid: 93013,
  qemuWindowId: 7,
  bindingMethod: "discovery-pid-window",
};

const frame = { x: 209, y: 276, width: 552, height: 440 };
const labels = picker.accessibleLabels.map((label) => ({
  label,
  center: [
    frame.x + picker.measuredTileCenterPoints[label][0],
    frame.y + picker.measuredTileCenterPoints[label][1],
  ],
}));
const dialog = {
  ownerPid: 93013,
  windowId: 91,
  correlatedWindowCount: 1,
  headingFound: true,
  title: "Environment Preview",
  frame,
  labels,
  closeControlId: "ax-close-91",
};

function happyDeps(overrides = {}) {
  const calls = [];
  const args = { focus: [], click: [], capture: [], close: [], present: [] };
  let focusAttempt = 0;
  const deps = {
    platform: overrides.platform ?? "darwin",
    bindQemuWindow: async (serial) => {
      calls.push(`bind:${serial}`);
      return overrides.bindingResult ?? { ok: true, binding };
    },
    focusQemu: async (bound) => {
      focusAttempt++;
      calls.push(`focus:${bound.qemuWindowOwnerPid}`);
      args.focus.push(bound);
      if (overrides.focusThrowsAt === focusAttempt) throw new Error(`focus attempt ${focusAttempt} failed`);
      return overrides.focusError ?? null;
    },
    openPicker: async (bound) => {
      calls.push(`open:${bound.qemuWindowOwnerPid}`);
      return overrides.openResult ?? {
        ok: true,
        matchedAttribute: "AXIdentifier",
        matchedScope: "bound_window_descendants",
      };
    },
    listPickerDialogs: async (bound) => {
      calls.push(`probe:${bound.qemuWindowOwnerPid}`);
      if (overrides.dialogProbeError) throw overrides.dialogProbeError;
      return Object.hasOwn(overrides, "dialogsPayload") ? overrides.dialogsPayload : (overrides.dialogs ?? [dialog]);
    },
    preflightCapture: async (storedDialog) => {
      calls.push(`capture-preflight:${storedDialog.windowId}`);
      args.capture.push(storedDialog);
      return overrides.preflightResult ?? { ok: true };
    },
    click: async (bound, storedDialog, absolutePoint) => {
      calls.push(`click:${bound.qemuWindowOwnerPid}:${absolutePoint.join(",")}`);
      args.click.push({ bound, storedDialog, absolutePoint });
      return overrides.clickError ?? null;
    },
    capture: async (storedDialog) => {
      calls.push(`capture-after:${storedDialog.windowId}`);
      args.capture.push(storedDialog);
      if (overrides.captureError) throw overrides.captureError;
      return overrides.afterBytes ?? selectedPng;
    },
    hash: overrides.hash ?? sha256,
    close: async (bound, storedDialog) => {
      calls.push(`close:${bound.qemuWindowOwnerPid}:${storedDialog.windowId}`);
      args.close.push({ bound, storedDialog });
      if (overrides.closeError) throw overrides.closeError;
      return overrides.closeResult ?? { ok: true };
    },
    isDialogPresent: async (bound, storedDialog) => {
      calls.push(`present:${bound.qemuWindowOwnerPid}:${storedDialog.windowId}`);
      args.present.push({ bound, storedDialog });
      if (overrides.presentError) throw overrides.presentError;
      return Object.hasOwn(overrides, "presentValue") ? overrides.presentValue : (overrides.stillPresent ?? false);
    },
  };
  return { ...deps, calls, args };
}

function actionCount(deps, prefix) {
  return deps.calls.filter((entry) => entry.startsWith(prefix)).length;
}

function runFakeAxTreeMatcher() {
  const sharedMatcher = homeEnvironmentHost.AX_SCENE_PICKER_MATCHER_SWIFT;
  assert.equal(typeof sharedMatcher, "string", "production must export the Swift matcher used by the AX helper");
  const fixture = String.raw`import Foundation
${sharedMatcher}

struct FakeAxNode {
  let name: String
  let attributes: [String: String]
}

func node(_ name: String, _ attributes: [String: String]) -> FakeAxNode {
  return FakeAxNode(name: name, attributes: attributes)
}

func runFixture(_ name: String, _ windowNodes: [FakeAxNode], _ applicationNodes: [FakeAxNode]) -> [String: Any] {
  var applicationTreeReadCount = 0
  let scopes: [ScenePickerSearchScope<FakeAxNode>] = [
    ScenePickerSearchScope(name: "bound_window_descendants", nodes: { windowNodes }),
    ScenePickerSearchScope(name: "application_tree", nodes: {
      applicationTreeReadCount += 1
      return applicationNodes
    }),
  ]
  let matched = exactScenePickerControlMatch(scopes: scopes) { candidate, attribute in
    candidate.attributes[attribute]
  }
  if let matched {
    return [
      "name": name,
      "node": matched.node.name,
      "matchedAttribute": matched.matchedAttribute,
      "matchedScope": matched.matchedScope,
      "applicationTreeReadCount": applicationTreeReadCount,
    ]
  }
  return [
    "name": name,
    "node": NSNull(),
    "matchedAttribute": NSNull(),
    "matchedScope": NSNull(),
    "applicationTreeReadCount": applicationTreeReadCount,
    "detail": scenePickerControlNotFoundDetail,
  ]
}

let fixtures: [[String: Any]] = [
  runFixture("identifier_only", [node("identifier", ["AXIdentifier": "select_scene_button"])], []),
  runFixture("title_only", [node("title", ["AXTitle": "select_scene_button"])], []),
  runFixture("description_only", [node("description", ["AXDescription": "PICO OS Emulator Scene"])], []),
  runFixture("attribute_priority", [
    node("title-first", ["AXTitle": "select_scene_button"]),
    node("identifier-second", ["AXIdentifier": "select_scene_button"]),
  ], []),
  runFixture("title_over_description", [
    node("description-first", ["AXDescription": "PICO OS Emulator Scene"]),
    node("title-second", ["AXTitle": "select_scene_button"]),
  ], []),
  runFixture("application_fallback", [node("unrelated", ["AXTitle": "home_button"])], [
    node("application-title", ["AXTitle": "select_scene_button"]),
  ]),
  runFixture("window_scope_priority", [
    node("window-description", ["AXDescription": "PICO OS Emulator Scene"]),
  ], [
    node("application-identifier", ["AXIdentifier": "select_scene_button"]),
  ]),
  runFixture("longer_description", [
    node("longer-description", ["AXDescription": "PICO OS Emulator Scene Preview"]),
  ], []),
  runFixture("wrong_description_value", [
    node("internal-name-description", ["AXDescription": "select_scene_button"]),
  ], []),
  runFixture("identifier_and_title_near_matches", [
    node("identifier-prefix", ["AXIdentifier": "select_scene_button_extended"]),
    node("title-prefix", ["AXTitle": "select_scene_button (Scene)"]),
  ], []),
  runFixture("nowhere", [node("home", ["AXTitle": "home_button"])], [
    node("settings", ["AXDescription": "Setting"]),
  ]),
]

let data = try! JSONSerialization.data(withJSONObject: fixtures, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
`;
  const result = spawnSync("swift", ["-"], {
    encoding: "utf8",
    input: fixture,
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  return JSON.parse(result.stdout);
}

test("the shared Swift matcher searches exact AX attributes and bound-window scope in strict order", {
  skip: process.platform !== "darwin" && "Swift AX matcher regression requires macOS",
}, () => {
  const fixtures = Object.fromEntries(runFakeAxTreeMatcher().map((entry) => [entry.name, entry]));
  assert.deepEqual(fixtures.identifier_only, {
    name: "identifier_only",
    node: "identifier",
    matchedAttribute: "AXIdentifier",
    matchedScope: "bound_window_descendants",
    applicationTreeReadCount: 0,
  });
  assert.deepEqual(fixtures.title_only, {
    name: "title_only",
    node: "title",
    matchedAttribute: "AXTitle",
    matchedScope: "bound_window_descendants",
    applicationTreeReadCount: 0,
  });
  assert.deepEqual(fixtures.description_only, {
    name: "description_only",
    node: "description",
    matchedAttribute: "AXDescription",
    matchedScope: "bound_window_descendants",
    applicationTreeReadCount: 0,
  });
  assert.equal(fixtures.attribute_priority.node, "identifier-second");
  assert.equal(fixtures.attribute_priority.matchedAttribute, "AXIdentifier");
  assert.equal(fixtures.title_over_description.node, "title-second");
  assert.equal(fixtures.title_over_description.matchedAttribute, "AXTitle");
  assert.equal(fixtures.application_fallback.node, "application-title");
  assert.equal(fixtures.application_fallback.matchedScope, "application_tree");
  assert.equal(fixtures.application_fallback.applicationTreeReadCount, 1);
  assert.equal(fixtures.window_scope_priority.node, "window-description");
  assert.equal(fixtures.window_scope_priority.matchedAttribute, "AXDescription");
  assert.equal(fixtures.window_scope_priority.matchedScope, "bound_window_descendants");
  assert.equal(fixtures.window_scope_priority.applicationTreeReadCount, 0);
  const expectedNotFoundDetail = "select_scene_button was not found by exact match; searched AXIdentifier, AXTitle, and AXDescription in bound_window_descendants, then application_tree";
  for (const name of ["longer_description", "wrong_description_value", "identifier_and_title_near_matches", "nowhere"]) {
    assert.equal(fixtures[name].node, null, `${name} must fail closed`);
    assert.equal(fixtures[name].detail, expectedNotFoundDetail);
  }
});

test("the complete macOS AX helper typechecks with the shared matcher", {
  skip: process.platform !== "darwin" && "macOS AX helper requires ApplicationServices",
}, () => {
  const helperSource = homeEnvironmentHost.AX_SCENE_PICKER_HELPER_SWIFT;
  assert.equal(typeof helperSource, "string", "production must expose the complete generated AX helper to its native compile gate");
  const result = spawnSync("swiftc", ["-typecheck", "-"], {
    encoding: "utf8",
    input: helperSource,
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
});

test("non-macOS returns a baseline-safe manual result before any host action", async () => {
  const deps = happyDeps({ platform: "linux" });
  const result = await executeGuardedHostSelection(target, picker, deps);
  assert.deepEqual(result, {
    status: "manual_switch_required",
    targetTile: "Livingroom Day",
    detail: "guarded host selection requires macOS",
    baselineSafe: true,
  });
  assert.deepEqual(deps.calls, []);
});

test("offline serial and ambiguous qemu bindings refuse before focus or AX actions", async (t) => {
  for (const [name, bindingResult] of [
    ["offline", { ok: false, code: "binding_failed", detail: "requested adb serial 'emulator-5554' is not online" }],
    ["ambiguous", { ok: false, code: "ambiguous_host_window", detail: "two matching qemu windows" }],
  ]) {
    await t.test(name, async () => {
      const deps = happyDeps({ bindingResult });
      const result = await executeGuardedHostSelection(target, picker, deps);
      assert.equal(result.status, "manual_switch_required");
      assert.equal(result.baselineSafe, true);
      assert.deepEqual(deps.calls, ["bind:emulator-5554"]);
    });
  }
});

test("successful binding payloads must still prove exact requested serial and discovery PID identity", async (t) => {
  const cases = [
    ["wrong discovered serial", { ...binding, discoveredSerial: "emulator-5556" }],
    ["requested serial offline", { ...binding, onlineEmulatorSerials: ["emulator-5556"] }],
    ["null discovery PID", { ...binding, qemuPid: null, bindingMethod: "single-online-serial-plus-matching-discovery-plus-single-window" }],
    ["mismatched discovery PID", { ...binding, qemuPid: 93014 }],
  ];
  for (const [name, unsafeBinding] of cases) {
    await t.test(name, async () => {
      const deps = happyDeps({ bindingResult: { ok: true, binding: unsafeBinding } });
      const result = await executeGuardedHostSelection(target, picker, deps);
      assert.equal(result.status, "manual_switch_required");
      assert.equal(result.baselineSafe, true);
      assert.match(result.detail, /exact.*binding|binding.*identity/i);
      assert.deepEqual(deps.calls, ["bind:emulator-5554"]);
      assert.equal(actionCount(deps, "open:"), 0);
      assert.equal(actionCount(deps, "click:"), 0);
    });
  }
});

test("single-window fallback is refused even when serial and positive discovery/window PIDs agree", async () => {
  const fallbackBinding = {
    ...binding,
    discoveredSerial: "emulator-5554",
    onlineEmulatorSerials: ["emulator-5554"],
    qemuPid: 93013,
    qemuWindowOwnerPid: 93013,
    bindingMethod: "single-online-serial-plus-matching-discovery-plus-single-window",
  };
  const deps = happyDeps({ bindingResult: { ok: true, binding: fallbackBinding } });
  const result = await executeGuardedHostSelection(target, picker, deps);
  assert.equal(result.status, "manual_switch_required");
  assert.equal(result.baselineSafe, true);
  assert.match(result.detail, /binding method.*did not use discovery PID correlation/i);
  assert.deepEqual(deps.calls, ["bind:emulator-5554"]);
  assert.equal(actionCount(deps, "focus:"), 0);
  assert.equal(actionCount(deps, "open:"), 0);
  assert.equal(actionCount(deps, "click:"), 0);
});

test("Accessibility denial and a missing select_scene_button refuse before dialog probe or click", async (t) => {
  for (const [name, detail] of [
    ["denied", "Accessibility permission denied"],
    ["missing control", "select_scene_button was not found by exact match; searched AXIdentifier, AXTitle, and AXDescription in bound_window_descendants, then application_tree"],
  ]) {
    await t.test(name, async () => {
      const deps = happyDeps({ openResult: { ok: false, detail } });
      const result = await executeGuardedHostSelection(target, picker, deps);
      assert.equal(result.status, "manual_switch_required");
      assert.equal(result.baselineSafe, true);
      if (name === "missing control") {
        assert.match(result.detail, /AXIdentifier/);
        assert.match(result.detail, /AXTitle/);
        assert.match(result.detail, /AXDescription/);
      }
      assert.deepEqual(deps.calls, ["bind:emulator-5554", "focus:93013", "open:93013"]);
      assert.equal(actionCount(deps, "click:"), 0);
    });
  }
});

test("successful picker openings record the exact AX attribute and search scope", async (t) => {
  for (const [matchedAttribute, matchedScope] of [
    ["AXIdentifier", "bound_window_descendants"],
    ["AXTitle", "bound_window_descendants"],
    ["AXDescription", "application_tree"],
  ]) {
    await t.test(`${matchedScope}/${matchedAttribute}`, async () => {
      const deps = happyDeps({ openResult: { ok: true, matchedAttribute, matchedScope } });
      const result = await executeGuardedHostSelection(target, picker, deps);
      assert.equal(result.status, "host_selection_observed");
      assert.deepEqual(result.receipts.find((receipt) => receipt.action === "open_picker"), {
        action: "open_picker",
        status: "ok",
        detail: `pressed Accessibility select_scene_button via ${matchedAttribute} in ${matchedScope}`,
      });
      assert.equal(actionCount(deps, "open:"), 1);
      assert.equal(actionCount(deps, "click:"), 1);
      assert.deepEqual(deps.args.click[0].absolutePoint, [659, 397]);
    });
  }
});

test("malformed pre-click helper payloads return manual without a click", async (t) => {
  const malformedDialogs = [
    ["non-array dialog list", {}],
    ["non-numeric frame", [{ ...dialog, frame: { ...frame, x: "209" } }]],
    ["non-numeric label center", [{ ...dialog, labels: labels.map((entry, index) => index === 0 ? { ...entry, center: entry.center.map(String) } : entry) }]],
    ["non-string close control", [{ ...dialog, closeControlId: 91 }]],
  ];

  await t.test("malformed open result", async () => {
    const deps = happyDeps({ openResult: {} });
    const result = await executeGuardedHostSelection(target, picker, deps);
    assert.equal(result.status, "manual_switch_required");
    assert.equal(result.baselineSafe, true);
    assert.match(result.detail, /invalid.*helper payload/i);
    assert.equal(actionCount(deps, "probe:"), 0);
    assert.equal(actionCount(deps, "click:"), 0);
  });

  for (const [name, openResult] of [
    ["successful open missing match provenance", { ok: true }],
    ["successful open with unknown attribute", { ok: true, matchedAttribute: "AXValue", matchedScope: "bound_window_descendants" }],
    ["successful open with unknown scope", { ok: true, matchedAttribute: "AXTitle", matchedScope: "menu_bar" }],
  ]) {
    await t.test(name, async () => {
      const deps = happyDeps({ openResult });
      const result = await executeGuardedHostSelection(target, picker, deps);
      assert.equal(result.status, "manual_switch_required");
      assert.equal(result.baselineSafe, true);
      assert.match(result.detail, /invalid.*picker.*payload/i);
      assert.equal(actionCount(deps, "probe:"), 0);
      assert.equal(actionCount(deps, "click:"), 0);
    });
  }

  await t.test("dialog probe query failure", async () => {
    const deps = happyDeps({ dialogProbeError: new Error("AX windows query failed") });
    const result = await executeGuardedHostSelection(target, picker, deps);
    assert.equal(result.status, "manual_switch_required");
    assert.equal(result.baselineSafe, true);
    assert.match(result.detail, /AX windows query failed/);
    assert.equal(actionCount(deps, "click:"), 0);
  });

  for (const [name, dialogsPayload] of malformedDialogs) {
    await t.test(name, async () => {
      const deps = happyDeps({ dialogsPayload });
      const result = await executeGuardedHostSelection(target, picker, deps);
      assert.equal(result.status, "manual_switch_required");
      assert.equal(result.baselineSafe, true);
      assert.match(result.detail, /invalid.*dialog.*payload/i);
      assert.equal(actionCount(deps, "click:"), 0);
      assert.equal(actionCount(deps, "capture"), 0);
    });
  }
});

test("focus exceptions return baseline-safe manual results before any click", async (t) => {
  for (const focusThrowsAt of [1, 2]) {
    await t.test(`attempt ${focusThrowsAt}`, async () => {
      const deps = happyDeps({ focusThrowsAt });
      const result = await executeGuardedHostSelection(target, picker, deps);
      assert.equal(result.status, "manual_switch_required");
      assert.equal(result.baselineSafe, true);
      assert.match(result.detail, new RegExp(`focus attempt ${focusThrowsAt} failed`));
      assert.equal(actionCount(deps, "click:"), 0);
      assert.equal(actionCount(deps, "capture-after:"), 0);
      assert.equal(actionCount(deps, "close:"), 0);
    });
  }
});

test("a focus verification error stops before openPicker", async () => {
  const deps = happyDeps({ focusError: "frontmost PID readback mismatch: expected 93013, observed 416" });
  const result = await executeGuardedHostSelection(target, picker, deps);
  assert.equal(result.status, "manual_switch_required");
  assert.equal(result.baselineSafe, true);
  assert.equal(result.detail, "frontmost PID readback mismatch: expected 93013, observed 416");
  assert.deepEqual(deps.calls, ["bind:emulator-5554", "focus:93013"]);
  assert.equal(actionCount(deps, "open:"), 0);
  assert.equal(actionCount(deps, "click:"), 0);
});

test("wrong dialog PID, title, or geometry refuses before capture and click", async (t) => {
  const cases = [
    ["pid", { ...dialog, ownerPid: 93014 }],
    ["title", { ...dialog, title: "Scene Preview" }],
    ["width", { ...dialog, frame: { ...frame, width: 551 } }],
    ["height", { ...dialog, frame: { ...frame, height: 441 } }],
  ];
  for (const [name, candidate] of cases) {
    await t.test(name, async () => {
      const deps = happyDeps({ dialogs: [candidate] });
      const result = await executeGuardedHostSelection(target, picker, deps);
      assert.equal(result.status, "manual_switch_required");
      assert.equal(result.baselineSafe, true);
      assert.deepEqual(deps.calls, ["bind:emulator-5554", "focus:93013", "open:93013", "probe:93013"]);
      assert.equal(actionCount(deps, "capture"), 0);
      assert.equal(actionCount(deps, "click:"), 0);
    });
  }
});

test("missing, duplicate, or misplaced accessible labels refuse before capture and click", async (t) => {
  const cases = [
    ["missing", labels.slice(0, -1)],
    ["duplicate", [...labels.slice(0, -1), labels[0]]],
    ["misplaced", labels.map((entry, index) => index === 2 ? { ...entry, center: [entry.center[0] + 1, entry.center[1]] } : entry)],
  ];
  for (const [name, candidateLabels] of cases) {
    await t.test(name, async () => {
      const deps = happyDeps({ dialogs: [{ ...dialog, labels: candidateLabels }] });
      const result = await executeGuardedHostSelection(target, picker, deps);
      assert.equal(result.status, "manual_switch_required");
      assert.equal(result.baselineSafe, true);
      assert.equal(actionCount(deps, "capture"), 0);
      assert.equal(actionCount(deps, "click:"), 0);
    });
  }
});

test("raw AX enumeration ignores an unrelated main window and retains the one exact dialog", async () => {
  const mainWindow = {
    ...dialog,
    windowId: 7,
    correlatedWindowCount: 1,
    title: "PICO Emulator - 6.0.0",
    headingFound: false,
    frame: { x: 100, y: 100, width: 1440, height: 900 },
    labels: [],
    closeControlId: "",
  };
  const deps = happyDeps({ dialogs: [mainWindow, dialog] });
  const result = await executeGuardedHostSelection(target, picker, deps);
  assert.equal(result.status, "host_selection_observed");
  assert.equal(actionCount(deps, "click:"), 1);
  assert.equal(deps.args.click[0].storedDialog, dialog);
});

test("capture preflight failure refuses before the CGEvent click", async () => {
  const deps = happyDeps({ preflightResult: { ok: false, detail: "Screen Recording denied" } });
  const result = await executeGuardedHostSelection(target, picker, deps);
  assert.equal(result.status, "manual_switch_required");
  assert.equal(result.baselineSafe, true);
  assert.equal(actionCount(deps, "capture-preflight:"), 1);
  assert.equal(actionCount(deps, "click:"), 0);
  assert.equal(actionCount(deps, "capture-after:"), 0);
  assert.equal(actionCount(deps, "close:"), 0);
});

test("the proven path clicks the dataset-relative center on the exact PID and closes the stored dialog", async () => {
  const deps = happyDeps();
  const selected = await executeGuardedHostSelection(target, picker, deps);
  assert.equal(selected.status, "host_selection_observed");
  assert.equal(selected.afterDialogSha256, target.selectedDialogSha256);
  assert.equal(selected.close.closed, true);
  assert.deepEqual(deps.calls, [
    "bind:emulator-5554",
    "focus:93013",
    "open:93013",
    "probe:93013",
    "capture-preflight:91",
    "focus:93013",
    "click:93013:659,397",
    "capture-after:91",
    "close:93013:91",
    "present:93013:91",
  ]);
  assert.equal(deps.args.focus.length, 2);
  assert.ok(deps.args.focus.every((focused) => focused === binding));
  assert.deepEqual(deps.args.click[0], { bound: binding, storedDialog: dialog, absolutePoint: [659, 397] });
  assert.equal(deps.args.close[0].storedDialog, dialog);
  assert.equal(deps.args.present[0].storedDialog, dialog);
  assert.equal(actionCount(deps, "click:"), 1);
});

test("a stale selected-dialog hash never reports an observed selection", async () => {
  const deps = happyDeps({ afterBytes: wrongPng });
  const stale = await executeGuardedHostSelection(target, picker, deps);
  assert.equal(stale.status, "host_selection_not_observed");
  assert.equal(stale.selectedTile, null);
  assert.match(stale.detail, /hash/i);
  assert.equal(actionCount(deps, "click:"), 1);
  assert.equal(actionCount(deps, "close:"), 1);
  assert.equal(actionCount(deps, "present:"), 1);
});

test("post-click capture and close failures never report an observed selection", async (t) => {
  await t.test("capture", async () => {
    const deps = happyDeps({ captureError: new Error("screencapture failed") });
    const result = await executeGuardedHostSelection(target, picker, deps);
    assert.equal(result.status, "host_selection_not_observed");
    assert.equal(result.selectedTile, null);
    assert.equal(actionCount(deps, "click:"), 1);
    assert.equal(actionCount(deps, "close:"), 1);
    assert.equal(actionCount(deps, "present:"), 1);
  });
  await t.test("AX close", async () => {
    const deps = happyDeps({ closeResult: { ok: false, detail: "close control disappeared" } });
    const result = await executeGuardedHostSelection(target, picker, deps);
    assert.equal(result.status, "host_selection_not_observed");
    assert.equal(result.selectedTile, null);
    assert.equal(actionCount(deps, "click:"), 1);
    assert.equal(actionCount(deps, "close:"), 1);
    assert.equal(actionCount(deps, "present:"), 0);
  });
  await t.test("dialog remains", async () => {
    const deps = happyDeps({ stillPresent: true });
    const result = await executeGuardedHostSelection(target, picker, deps);
    assert.equal(result.status, "host_selection_not_observed");
    assert.equal(result.selectedTile, null);
    assert.equal(actionCount(deps, "present:"), 1);
  });
  await t.test("malformed AX close result", async () => {
    const deps = happyDeps({ closeResult: {} });
    const result = await executeGuardedHostSelection(target, picker, deps);
    assert.equal(result.status, "host_selection_not_observed");
    assert.equal(result.selectedTile, null);
    assert.match(result.detail, /invalid.*helper payload/i);
    assert.equal(actionCount(deps, "present:"), 0);
  });
  await t.test("malformed disappearance result", async () => {
    const deps = happyDeps({ presentValue: undefined });
    const result = await executeGuardedHostSelection(target, picker, deps);
    assert.equal(result.status, "host_selection_not_observed");
    assert.equal(result.selectedTile, null);
    assert.match(result.detail, /invalid.*disappearance.*payload/i);
    assert.equal(actionCount(deps, "present:"), 1);
  });
  await t.test("AX close query failure", async () => {
    const deps = happyDeps({ closeError: new Error("AX close query failed") });
    const result = await executeGuardedHostSelection(target, picker, deps);
    assert.equal(result.status, "host_selection_not_observed");
    assert.equal(result.selectedTile, null);
    assert.match(result.detail, /AX close query failed/);
    assert.equal(actionCount(deps, "present:"), 0);
  });
  await t.test("disappearance query failure", async () => {
    const deps = happyDeps({ presentError: new Error("CoreGraphics enumeration failed") });
    const result = await executeGuardedHostSelection(target, picker, deps);
    assert.equal(result.status, "host_selection_not_observed");
    assert.equal(result.selectedTile, null);
    assert.match(result.detail, /CoreGraphics enumeration failed/);
    assert.equal(actionCount(deps, "present:"), 1);
  });
});
