import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";

export interface SubwindowInput { packageName:string; primaryId:string; primaryContent:string; primaryContentImport?:string; secondaryId:string; stableTag:string; payloadKey:string; payloadValue:string; widthMeters:number; heightMeters:number; depthMeters:number; minWidthDp?:number; minHeightDp?:number; maxWidthDp?:number; maxHeightDp?:number; subwindowSide:"Left"|"Right"|"Default"; componentContent:string }

const KOTLIN_KEYWORDS = new Set([
  "as", "break", "class", "continue", "do", "else", "false", "for", "fun", "if", "in", "interface", "is",
  "null", "object", "package", "return", "super", "this", "throw", "true", "try", "typealias", "typeof", "val",
  "var", "when", "while", "by", "catch", "constructor", "delegate", "dynamic", "field", "file", "finally", "get",
  "import", "init", "param", "property", "receiver", "set", "setparam", "value", "where", "actual", "abstract",
  "annotation", "companion", "const", "crossinline", "data", "enum", "expect", "external", "final", "infix", "inline",
  "inner", "internal", "lateinit", "noinline", "open", "operator", "out", "override", "private", "protected", "public",
  "reified", "sealed", "suspend", "tailrec", "vararg",
]);
const IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const isSafeIdentifier = (value: string) => IDENTIFIER_RE.test(value) && !KOTLIN_KEYWORDS.has(value);
const isSafeQualifiedName = (value: string) => value.split(".").every(isSafeIdentifier);
const kotlinIdentifier = z.string().refine(isSafeIdentifier, "expected a non-keyword Kotlin identifier");
const kotlinPackage = z.string().refine(
  (value) => value.includes(".") && value.split(".").every((segment) => /^[a-z][a-z0-9_]*$/.test(segment) && !KOTLIN_KEYWORDS.has(segment)),
  "expected a non-keyword Kotlin package",
);
const namedComposable = z.string().refine(
  (value) => value.endsWith("()") && isSafeQualifiedName(value.slice(0, -2)),
  "expected a safe named zero-argument Composable call, for example HomeStage()",
);
const positiveMeters = z.number().finite().min(0.000001).max(10_000);
const depthMeters = z.number().finite().min(0).max(10_000).refine(
  (value) => value === 0 || value >= 0.000001,
  "depthMeters must be zero or at least 0.000001",
);
const constraintDp = z.number().finite().int().positive().max(100_000);
const subwindowFields = {
  packageName: kotlinPackage,
  primaryId: kotlinIdentifier,
  primaryContent: namedComposable.describe("Existing primary-scene Composable retained inside DefaultStage, for example HomeStage()"),
  primaryContentImport: z.string().refine((value) => value.includes(".") && isSafeQualifiedName(value), "expected a safe qualified Kotlin import").optional(),
  secondaryId: kotlinIdentifier,
  stableTag: z.string().min(1).max(256),
  payloadKey: z.string().min(1).max(256),
  payloadValue: z.string().max(4_096),
  widthMeters: positiveMeters,
  heightMeters: positiveMeters,
  depthMeters,
  minWidthDp: constraintDp.default(500),
  minHeightDp: constraintDp.default(400),
  maxWidthDp: constraintDp.default(1200),
  maxHeightDp: constraintDp.default(900),
  subwindowSide: z.enum(["Left", "Right", "Default"]),
  componentContent: namedComposable
    .describe("Safe named zero-argument Composable call placed in the secondary container; arbitrary Kotlin snippets are rejected"),
};
const subwindowInputSchema = z.object(subwindowFields).superRefine((value, ctx) => {
  if (value.minWidthDp > value.maxWidthDp) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["minWidthDp"], message: "must not exceed maxWidthDp" });
  if (value.minHeightDp > value.maxHeightDp) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["minHeightDp"], message: "must not exceed maxHeightDp" });
});

function kstr(value: string): string {
  let escaped = "";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === "\\") escaped += "\\\\";
    else if (char === '"') escaped += '\\"';
    else if (char === "$") escaped += "\\$";
    else if (char === "\b") escaped += "\\b";
    else if (char === "\t") escaped += "\\t";
    else if (char === "\n") escaped += "\\n";
    else if (char === "\r") escaped += "\\r";
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) escaped += `\\u${code.toString(16).padStart(4, "0")}`;
    else escaped += char;
  }
  return `"${escaped}"`;
}

export function generateSubwindowFiles(i: SubwindowInput) {
  const value = subwindowInputSchema.parse(i);
  const primaryComposable = `${value.primaryId.charAt(0).toUpperCase()}${value.primaryId.slice(1)}Workspace`;
  const kotlin = `package ${value.packageName}
${value.primaryContentImport ? `\nimport ${value.primaryContentImport}` : ""}

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.pico.spatial.ui.design.Button
import com.pico.spatial.ui.design.PicoTheme
import com.pico.spatial.ui.design.Text
import com.pico.spatial.ui.design.windows.Subwindow
import com.pico.spatial.ui.design.windows.SubwindowPlacement
import com.pico.spatial.ui.foundation.dsl.DefaultStage
import com.pico.spatial.ui.foundation.dsl.SpatialAppScope
import com.pico.spatial.ui.foundation.dsl.WindowContainer
import com.pico.spatial.ui.foundation.dsl.WindowContainerSize
import com.pico.spatial.ui.platform.LengthUnit
import com.pico.spatial.ui.platform.ViewPoint
import com.pico.spatial.ui.platform.containers.LocalSpatialNavigator
import com.pico.spatial.ui.platform.resize.ContainerResizeType
import androidx.core.os.bundleOf

@Composable
private fun ${primaryComposable}() {
    val navigator = LocalSpatialNavigator.current
    // This Bundle is an initial launch snapshot. Ongoing changes belong in app state or a command channel.
    val initialArgs = bundleOf(${kstr(value.payloadKey)} to ${kstr(value.payloadValue)})
    PicoTheme {
        ${value.primaryContent}
        Row {
            Button(onClick = { navigator.openWindowContainer(${kstr(value.secondaryId)}, ${kstr(value.stableTag)}, initialArgs) }) { Text(${kstr(`Open ${value.secondaryId}`)}) }
            Button(onClick = { navigator.closeWindowContainer(${kstr(value.secondaryId)}, ${kstr(value.stableTag)}) }) { Text(${kstr(`Close ${value.secondaryId}`)}) }
        }
    }
}

fun mainApp(scope: SpatialAppScope) = with(scope) {
    DefaultStage { ${primaryComposable}() }
    WindowContainer(id = ${kstr(value.secondaryId)},
        defaultSize = WindowContainerSize(${value.widthMeters}f, ${value.heightMeters}f, ${value.depthMeters}f, LengthUnit.Meters),
        resizeType = ContainerResizeType.ContentSize,
    ) {
        // bundle is the WindowContainerScope/SpatialContainerScope initial launch snapshot.
        val initialValue = bundle?.getString(${kstr(value.payloadKey)})
        Box(Modifier.windowConstraints(minWidth = ${value.minWidthDp}.dp, minHeight = ${value.minHeightDp}.dp, maxWidth = ${value.maxWidthDp}.dp, maxHeight = ${value.maxHeightDp}.dp)) {
            PicoTheme {
                ${value.componentContent}
                // The SDK owns the fixed 360.dp x MatchContainerHeight attached augment.
                //
                // CONTAINER-RELATIVE, NOT WORLD-SPACE — precise as of v35.5, from the 0.13.3 KDoc
                // (ui/design windows/Subwindow.kt:41-42), verbatim: "Subwindow is a component shown
                // at left or right side of the window container. and it's height always fill the
                // height of the window container."
                // So 'placement' picks a SIDE of this container, and 'offset: DpOffset3D' is an
                // offset FROM that side — it defaults to getGap(getLayoutDirection(placement)),
                // a gap measured off the container edge, not a world coordinate. 'rotation3D' is
                // likewise applied about the subwindow's own pivot relative to the container
                // (Rotation3D.pivot's z is ignored, per the same KDoc).
                // Consequence: a Subwindow moves when its container moves. It is not, and cannot be
                // made into, a world-locked panel. For content placed at a chosen position inside a
                // 3D scene use generate_attachment_panel_kotlin; for a pose fixed to the real room
                // you still need AnchorComponent, which remains deferred.
                Subwindow(
                    followViewpoints = ViewPoint.All,
                    placement = SubwindowPlacement.${value.subwindowSide},
                    content = { Text(text = initialValue ?: ${kstr(`No ${value.payloadKey} launch argument`)}) },
                )
            }
        }
    }
}`;
  return {
    files: { "Main.kt": kotlin },
    writeMode: "replace" as const,
    ownership: {
      path: "Main.kt",
      instruction: "Replace the existing app Main.kt with this file; do not add it alongside another file that declares mainApp.",
    },
    manifestNotes: [
      `Keep the launcher Activity on DefaultStage with stage style 1 (Mixed); do not replace its Stage metadata with WindowContainer metadata.`,
      `The mainApp DSL declaration is sufficient with the SDK default stub Activity for '${value.secondaryId}'.`,
      `If an optional custom/manifest Activity is used for '${value.secondaryId}', it must declare the same id as the DSL and remain separate from the launcher metadata.`,
    ],
    evidence:["SDK 0.13.3 source-grounded structure"],
    doesNotProve:[
      "Subwindow is CONTAINER-RELATIVE by definition (0.13.3 KDoc, Subwindow.kt:41-42: shown at the left or right side of the window container, height always filling it). placement picks a side; offset is measured from that side, defaulting to getGap(...); rotation3D is about its own pivot. It follows its container and can never be world-locked — that is a property of the component, not a limit of this generator.",
      "Generated structure does not prove compilation or pixel rendering.",
      "The generator does not write or verify AndroidManifest.xml; Mixed behavior depends on applying manifestNotes to the launcher.",
    ],
  };
}
export function registerSubwindowTools(server:McpServer) { server.registerTool("generate_subwindow_kotlin", { description:"Generate a replacement Main.kt that retains the caller's safe named primaryContent inside exactly one DefaultStage, plus one named secondary WindowContainer with initial Bundle launch args and an attached Subwindow. The generator does not edit AndroidManifest.xml: Mixed behavior is conditional on preserving launcher stage style 1 as required by manifestNotes. Replace the scaffold's existing Main.kt; never add this beside another mainApp. The SDK default stub needs no secondary manifest entry; any optional custom Activity must use the DSL id. Structural only; Subwindow does not prove arbitrary world lock or pixel rendering.", inputSchema:subwindowFields }, async input=>okJson(generateSubwindowFiles(input))); }
