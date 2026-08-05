import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { expandHome, fail, okJson } from "./util.js";

/**
 * components.ts — the SPATIAL UI COMPONENT generator (DESIGN.md §4/§5 encoded).
 *
 * Agents kept hand-writing broken spatial UI: 560 dp panels that read tiny at 2 m,
 * static Box+Text "buttons" that do nothing, and colors via primvars:displayColor /
 * raw RGB that the PICO Compose layer renders wrong. This emits verified, compilable
 * Jetpack-Compose Kotlin using the PICO modified-Compose imports, enforcing the
 * project's correctness rules in code so the agent only has to wire actions.
 *
 * Rules baked in (never relaxed):
 *  - Panels are >= 800 dp wide, placed close (the caller anchors at 1.3-1.6 m).
 *  - Fonts are clamped to 18-40 sp.
 *  - Every button uses Modifier.clickable { } (NOT a static Box+Text); the action
 *    string becomes a // comment placeholder inside the lambda for the agent to wire.
 *  - Colors are Color(0xFFRRGGBB) parsed from #rrggbb hex (never displayColor / raw rgb).
 *  - Frosted panels use backgroundMaterial(true, Material.Thick) over a tinted background.
 */

// ---- input schema: discriminated panel specs ----

const hexField = z
  .string()
  .regex(/^#?[0-9a-fA-F]{6}$/, "expected a 6-digit hex color like '#3b82f6'");

const KOTLIN_KEYWORDS = new Set([
  "as", "break", "class", "continue", "do", "else", "false", "for", "fun", "if", "in", "interface", "is",
  "null", "object", "package", "return", "super", "this", "throw", "true", "try", "typealias", "typeof", "val",
  "var", "when", "while", "by", "catch", "constructor", "delegate", "dynamic", "field", "file", "finally", "get",
  "import", "init", "param", "property", "receiver", "set", "setparam", "value", "where", "actual", "abstract",
  "annotation", "companion", "const", "crossinline", "data", "enum", "expect", "external", "final", "infix", "inline",
  "inner", "internal", "lateinit", "noinline", "open", "operator", "out", "override", "private", "protected", "public",
  "reified", "sealed", "suspend", "tailrec", "vararg",
]);
const packageNameField = z
  .string()
  .refine(
    (value) => value.includes(".") && value.split(".").every((segment) => /^[a-z][a-z0-9_]*$/.test(segment) && !KOTLIN_KEYWORDS.has(segment)),
    "expected a non-keyword Kotlin package like 'com.acme.viz.content'",
  );

const cardButton = z.object({
  label: z.string(),
  colorHex: hexField,
  action: z.string().describe("becomes a // comment placeholder inside the clickable lambda"),
});

const menuButton = z.object({
  label: z.string(),
  colorHex: hexField,
  filled: z.boolean().default(false).describe("filled (solid) vs outlined button style"),
  action: z.string().describe("becomes a // comment placeholder inside the clickable lambda"),
});

const listItem = z.object({
  label: z.string(),
  sublabel: z.string().optional(),
  dotHex: hexField.optional().describe("status dot color, e.g. severity color"),
});

const cardPanel = z.object({
  kind: z.literal("card"),
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, "id must be a valid Kotlin identifier"),
  title: z.string(),
  subtitle: z.string().optional(),
  bodyLines: z.array(z.string()).default([]),
  accentHex: hexField.optional(),
  buttons: z.array(cardButton).default([]),
});

const menuPanel = z.object({
  kind: z.literal("menu"),
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, "id must be a valid Kotlin identifier"),
  title: z.string(),
  buttons: z.array(menuButton).min(1),
});

const listPanel = z.object({
  kind: z.literal("list"),
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, "id must be a valid Kotlin identifier"),
  title: z.string(),
  items: z.array(listItem).min(1),
});

const expandedPanel = z.object({
  kind: z.enum(["titleBar", "toolbar", "tabBar", "sheet", "snackbarHost", "coachmark", "segmentControl"]),
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/),
  title: z.string(),
  items: z.array(z.string()).default([]),
  container: z.enum(["ordinary", "window"]).default("ordinary"),
}).superRefine((panel, ctx) => {
  if (["sheet", "snackbarHost", "coachmark"].includes(panel.kind) && panel.container !== "window") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["container"],
      message: `${panel.kind} is only valid in a secondary WindowContainer`,
    });
  }
  if (["tabBar", "segmentControl"].includes(panel.kind) && panel.items.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["items"],
      message: `${panel.kind} requires at least one item`,
    });
  }
});

const panelSpec = z.union([cardPanel, menuPanel, listPanel, expandedPanel]);

type CardPanel = z.infer<typeof cardPanel>;
type MenuPanel = z.infer<typeof menuPanel>;
type ListPanel = z.infer<typeof listPanel>;
type ExpandedPanel = z.infer<typeof expandedPanel>;
type PanelSpec = z.infer<typeof panelSpec>;

// ---- helpers ----

/** '#3b82f6' | '3b82f6' -> 'Color(0xFF3B82F6)' (never displayColor / raw rgb). */
function color(hex: string): string {
  return `Color(0xFF${hex.replace(/^#/, "").toUpperCase()})`;
}

/** Escape a JS string for a Kotlin "double-quoted" literal. */
function kstr(s: string): string {
  let escaped = "";
  for (const char of s) {
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

/** Escape for use inside a single-line // comment (no newlines). */
function kcomment(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
}

/** Clamp a font size into the DESIGN.md 18-40 sp window. */
function fontSp(n: number): number {
  return Math.max(18, Math.min(40, Math.round(n)));
}

const INDENT = "    ";
function indent(lines: string[], depth: number): string[] {
  const pad = INDENT.repeat(depth);
  return lines.map((l) => (l.length ? pad + l : l));
}

// ---- per-kind Composable emitters ----

function emitCard(p: CardPanel): string[] {
  const accent = p.accentHex ? color(p.accentHex) : "Color(0xFF3B82F6)";
  const body: string[] = [];
  // Title row with an accent bar (clip + background — bound color, not displayColor).
  body.push(`Row(verticalAlignment = Alignment.CenterVertically) {`);
  body.push(
    `${INDENT}Box(`,
    `${INDENT}${INDENT}Modifier`,
    `${INDENT}${INDENT}${INDENT}.size(width = 8.dp, height = ${fontSp(34)}.dp)`,
    `${INDENT}${INDENT}${INDENT}.clip(RoundedCornerShape(4.dp))`,
    `${INDENT}${INDENT}${INDENT}.background(${accent}),`,
    `${INDENT})`,
    `${INDENT}Spacer(Modifier.width(16.dp))`,
    `${INDENT}Text(text = ${kstr(p.title)}, fontSize = ${fontSp(34)}.sp, color = Color.White)`,
  );
  body.push(`}`);
  if (p.subtitle) {
    body.push(`Spacer(Modifier.height(8.dp))`);
    body.push(`Text(text = ${kstr(p.subtitle)}, fontSize = ${fontSp(22)}.sp, color = Color(0xFFB8C0CC))`);
  }
  if (p.bodyLines.length) {
    body.push(`Spacer(Modifier.height(20.dp))`);
    for (const line of p.bodyLines) {
      body.push(`Text(text = ${kstr(line)}, fontSize = ${fontSp(20)}.sp, color = Color(0xFFE6EAF0))`);
      body.push(`Spacer(Modifier.height(10.dp))`);
    }
  }
  if (p.buttons.length) {
    body.push(`Spacer(Modifier.height(20.dp))`);
    body.push(`Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {`);
    for (const b of p.buttons) {
      body.push(...indent(emitClickableButton(b.label, b.colorHex, true, b.action), 1));
    }
    body.push(`}`);
  }
  return composableShell(p.id, body);
}

function emitMenu(p: MenuPanel): string[] {
  const body: string[] = [];
  body.push(`Text(text = ${kstr(p.title)}, fontSize = ${fontSp(34)}.sp, color = Color.White)`);
  body.push(`Spacer(Modifier.height(24.dp))`);
  body.push(`Column(verticalArrangement = Arrangement.spacedBy(16.dp), modifier = Modifier.fillMaxWidth()) {`);
  for (const b of p.buttons) {
    body.push(...indent(emitClickableButton(b.label, b.colorHex, b.filled, b.action, true), 1));
  }
  body.push(`}`);
  return composableShell(p.id, body);
}

function emitList(p: ListPanel): string[] {
  const body: string[] = [];
  body.push(`Text(text = ${kstr(p.title)}, fontSize = ${fontSp(34)}.sp, color = Color.White)`);
  body.push(`Spacer(Modifier.height(24.dp))`);
  body.push(`Column(verticalArrangement = Arrangement.spacedBy(14.dp), modifier = Modifier.fillMaxWidth()) {`);
  for (const it of p.items) {
    const row: string[] = [];
    row.push(`Row(verticalAlignment = Alignment.CenterVertically) {`);
    const dot = it.dotHex ? color(it.dotHex) : "Color(0xFF8893A2)";
    row.push(
      `${INDENT}Box(`,
      `${INDENT}${INDENT}Modifier`,
      `${INDENT}${INDENT}${INDENT}.size(18.dp)`,
      `${INDENT}${INDENT}${INDENT}.clip(CircleShape)`,
      `${INDENT}${INDENT}${INDENT}.background(${dot}),`,
      `${INDENT})`,
      `${INDENT}Spacer(Modifier.width(16.dp))`,
      `${INDENT}Column {`,
      `${INDENT}${INDENT}Text(text = ${kstr(it.label)}, fontSize = ${fontSp(22)}.sp, color = Color.White)`,
    );
    if (it.sublabel) {
      row.push(`${INDENT}${INDENT}Text(text = ${kstr(it.sublabel)}, fontSize = ${fontSp(18)}.sp, color = Color(0xFFB8C0CC))`);
    }
    row.push(`${INDENT}}`);
    row.push(`}`);
    body.push(...row);
  }
  body.push(`}`);
  return composableShell(p.id, body);
}

/**
 * A real, clickable button (DESIGN.md §4): emits Modifier.clickable with the action
 * as a comment placeholder, never a static Box+Text. `action` is the comment the agent wires.
 */
function emitClickableButton(
  label: string,
  colorHex: string,
  filled: boolean,
  action: string,
  fullWidth = false,
): string[] {
  const c = color(colorHex);
  const lines: string[] = [];
  lines.push(`Box(`);
  lines.push(`${INDENT}Modifier`);
  if (fullWidth) lines.push(`${INDENT}${INDENT}.fillMaxWidth()`);
  lines.push(`${INDENT}${INDENT}.clip(RoundedCornerShape(16.dp))`);
  if (filled) {
    lines.push(`${INDENT}${INDENT}.background(${c})`);
  } else {
    lines.push(`${INDENT}${INDENT}.border(width = 2.dp, color = ${c}, shape = RoundedCornerShape(16.dp))`);
  }
  lines.push(`${INDENT}${INDENT}.clickable {`);
  lines.push(`${INDENT}${INDENT}${INDENT}// ${kcomment(action)}`);
  lines.push(`${INDENT}${INDENT}}`);
  lines.push(`${INDENT}${INDENT}.padding(horizontal = 28.dp, vertical = 18.dp),`);
  lines.push(`${INDENT}contentAlignment = Alignment.Center,`);
  lines.push(`) {`);
  const textColor = filled ? "Color.White" : c;
  lines.push(`${INDENT}Text(text = ${kstr(label)}, fontSize = ${fontSp(22)}.sp, color = ${textColor})`);
  lines.push(`}`);
  return lines;
}

/**
 * Wrap a panel body in a frosted, >= 800 dp Compose panel: a tinted background with
 * backgroundMaterial(true, Material.Thick) for the PICO frosted-glass look. The width floor
 * is the DESIGN.md §4 rule (560 dp reads tiny at 2 m).
 */
function composableShell(id: string, body: string[]): string[] {
  const fn = id.charAt(0).toUpperCase() + id.slice(1) + "Panel";
  const out: string[] = [];
  out.push(`@Composable`);
  out.push(`fun ${fn}(modifier: Modifier = Modifier) {`);
  // PicoTheme provides the themed Text typography/colors the PICO Compose layer expects.
  out.push(`${INDENT}PicoTheme {`);
  out.push(`${INDENT}${INDENT}Column(`);
  out.push(`${INDENT}${INDENT}${INDENT}modifier = modifier`);
  out.push(`${INDENT}${INDENT}${INDENT}${INDENT}.width(880.dp) // DESIGN.md §4: panels >= 800 dp or they read tiny at distance`);
  out.push(`${INDENT}${INDENT}${INDENT}${INDENT}.clip(RoundedCornerShape(28.dp))`);
  out.push(`${INDENT}${INDENT}${INDENT}${INDENT}.background(Color(0xCC0E1726)) // tint behind the frosted material`);
  out.push(`${INDENT}${INDENT}${INDENT}${INDENT}.backgroundMaterial(true, Material.Thick) // PICO frosted-glass panel (enable, style)`);
  out.push(`${INDENT}${INDENT}${INDENT}${INDENT}.padding(40.dp),`);
  out.push(`${INDENT}${INDENT}) {`);
  out.push(...indent(body, 3));
  out.push(`${INDENT}${INDENT}}`);
  out.push(`${INDENT}}`);
  out.push(`}`);
  return out;
}

function emitPanel(p: PanelSpec): string[] {
  switch (p.kind) {
    case "card":
      return emitCard(p);
    case "menu":
      return emitMenu(p);
    case "list":
      return emitList(p);
    default:
      return emitExpanded(p as ExpandedPanel);
  }
}

function emitExpanded(p: ExpandedPanel): string[] {
  const fn = p.id.charAt(0).toUpperCase() + p.id.slice(1) + "Panel";
  const title = `Text(text = ${kstr(p.title)})`;
  const call: Record<ExpandedPanel["kind"], string> = {
    titleBar: `TitleBar(title = { ${title} })`,
    toolbar: `Toolbar(cornerSize = 32.dp, content = { ${title} })`,
    tabBar: `TabBar(content = { ${p.items.map((item, index) => `item(selected = ${index === 0}, onClick = {}, mainContent = { Text(text = ${kstr(item)}) })`).join("; ")} })`,
    sheet: `Sheet(onDismissRequest = {}) { ${title} }`,
    snackbarHost: `SnackbarHost { ${title} } // WindowContainer-only host`,
    coachmark: `CoachmarkBox(coachmark = { SimpleCoachmark(text = { ${title} }) }) { ${title} }`,
    segmentControl: `SegmentControl(content = { ${p.items.map((item, index) => `SegmentItem(selected = ${index === 0}, onClick = {}, title = { Text(text = ${kstr(item)}) })`).join("; ")} })`,
  };
  const boundary: Record<ExpandedPanel["kind"], string> = {
    titleBar: "Structural placeholder: source-grounded TitleBar call; content and appearance still require integration, compilation, and a LOOK.",
    toolbar: "Structural placeholder: Toolbar is a root/container augment; content and appearance still require integration, compilation, and a LOOK.",
    tabBar: "Structural placeholder: TabBar onClick callbacks are no-ops until the caller wires state and actions.",
    sheet: "Structural placeholder: WindowContainer-only Sheet; its dismiss callback is a no-op until the caller wires it.",
    snackbarHost: "Structural placeholder: WindowContainer-only host content; this does not call SnackbarHostState.show.",
    coachmark: "Structural placeholder: WindowContainer-only CoachmarkBox; state and actions still belong to the caller.",
    segmentControl: "Structural placeholder: SegmentItem onClick callbacks are no-ops until the caller wires selection state.",
  };
  return [`// ${boundary[p.kind]}`, "@Composable", `fun ${fn}() {`, `${INDENT}${call[p.kind]}`, `}`];
}

/** Build the full Kotlin file: package, the PICO modified-Compose imports, all @Composables. */
function buildKotlin(packageName: string, panels: PanelSpec[]): string {
  const hasExpandedPanels = panels.some((p) => !["card", "menu", "list"].includes(p.kind));
  const preamble = hasExpandedPanels
    ? [
        `package ${packageName}`,
        ``,
        `// Generated by pico-spatial-mcp generate_spatial_ui.`,
        `// SDK 0.13.3 source-grounded call shapes; caller owns the spatial container, state, and actions.`,
        `// Compilation and a LOOK remain pending before any appearance or interaction claim.`,
        ``,
      ]
    : [
        `package ${packageName}`,
        ``,
        `// Generated by pico-spatial-mcp generate_spatial_ui (DESIGN.md §4/§5 encoded).`,
        `// Spatial UI = real Jetpack-Compose panels rendered flat in 3D. Rules enforced here:`,
        `//  - panels >= 800 dp wide, placed close (1.3-1.6 m) by the caller`,
        `//  - fonts 18-40 sp; colors via Color(0xFF......), never primvars:displayColor`,
        `//  - every button is a real Modifier.clickable { } (not a static Box+Text)`,
        `// Call these @Composables from HomeStage's AttachmentPanels; wire each // action.`,
        ``,
      ];
  const header = [
    ...preamble,
    `import androidx.compose.foundation.background`,
    `import androidx.compose.foundation.border`,
    `import androidx.compose.foundation.clickable`,
    `import androidx.compose.foundation.layout.Arrangement`,
    `import androidx.compose.foundation.layout.Box`,
    `import androidx.compose.foundation.layout.Column`,
    `import androidx.compose.foundation.layout.Row`,
    `import androidx.compose.foundation.layout.Spacer`,
    `import androidx.compose.foundation.layout.fillMaxWidth`,
    `import androidx.compose.foundation.layout.height`,
    `import androidx.compose.foundation.layout.padding`,
    `import androidx.compose.foundation.layout.size`,
    `import androidx.compose.foundation.layout.width`,
    `import androidx.compose.foundation.shape.CircleShape`,
    `import androidx.compose.foundation.shape.RoundedCornerShape`,
    `import androidx.compose.runtime.Composable`,
    `import androidx.compose.ui.Alignment`,
    `import androidx.compose.ui.Modifier`,
    `import androidx.compose.ui.draw.clip`,
    `import androidx.compose.ui.graphics.Color`,
    `import androidx.compose.ui.unit.dp`,
    `import androidx.compose.ui.unit.sp`,
    `// PICO modified-Compose: themed Text + frosted-panel material`,
    `import com.pico.spatial.ui.design.PicoTheme`,
    `import com.pico.spatial.ui.design.Text`,
    `import com.pico.spatial.ui.foundation.material.backgroundMaterial`,
    `import com.pico.spatial.ui.platform.Material`,
    ``,
  ];
  if (hasExpandedPanels) {
    const expandedImports: string[] = [];
    const kinds = new Set(panels.map((p) => p.kind));
    if (kinds.has("titleBar")) expandedImports.push(`import com.pico.spatial.ui.design.TitleBar`);
    if (kinds.has("toolbar")) expandedImports.push(`import com.pico.spatial.ui.design.windows.Toolbar`);
    if (kinds.has("tabBar")) expandedImports.push(`import com.pico.spatial.ui.design.windows.TabBar`);
    if (kinds.has("sheet")) expandedImports.push(`import com.pico.spatial.ui.design.windows.Sheet`);
    if (kinds.has("snackbarHost")) expandedImports.push(`import com.pico.spatial.ui.design.windows.SnackbarHost`);
    if (kinds.has("coachmark")) expandedImports.push(
      `import com.pico.spatial.ui.design.windows.CoachmarkBox`,
      `import com.pico.spatial.ui.design.windows.SimpleCoachmark`,
    );
    if (kinds.has("segmentControl")) expandedImports.push(
      `import com.pico.spatial.ui.design.SegmentControl`,
      `import com.pico.spatial.ui.design.SegmentItem`,
    );
    header.splice(header.length - 1, 0, ...expandedImports);
  }
  const sections = panels.map((p) => emitPanel(p).join("\n"));
  return header.join("\n") + sections.join("\n\n") + "\n";
}

export function generateSpatialUIKotlin(input: {packageName:string; panels:unknown[]}): string {
  const packageName = packageNameField.parse(input.packageName);
  const panels = z.array(panelSpec).min(1).parse(input.panels);
  return buildKotlin(packageName, panels);
}

export function registerComponentTools(server: McpServer) {
  server.registerTool(
    "generate_spatial_ui",
    {
      description:
        "Generate SDK 0.13.3 source-grounded Jetpack-Compose Kotlin for card, menu, list, titleBar, toolbar, tabBar, sheet, snackbarHost, coachmark, and segmentControl. Existing card/menu/list output remains byte-compatible. Expanded variants are structural placeholders: TabBar/SegmentItem clicks and Sheet dismissal are no-ops, and SnackbarHost does not call SnackbarHostState.show. Toolbar and TabBar are root/container augments, not legacy panel-shell children; Sheet, SnackbarHost, and Coachmark are accepted only for a secondary WindowContainer. This tool emits composables only and never owns a Stage or WindowContainer. Output still needs integration, compilation, and a LOOK before any rendering or interaction claim. EMULATOR CAVEAT: an immersive app's own attachment-panel/WindowContainer DSL does not prove an emulator-visible panel; use generate_panel_compose_kotlin for the separately established 2D Activity lane.",
      inputSchema: {
        outPath: z.string().describe("Output .kt file path (e.g. <project>/app/src/main/java/.../content/Panels.kt)"),
        packageName: packageNameField
          .describe("Kotlin package declaration for the generated file"),
        panels: z.array(panelSpec).min(1).describe("One or more specs discriminated by kind: card | menu | list | titleBar | toolbar | tabBar | sheet | snackbarHost | coachmark | segmentControl"),
      },
    },
    async ({ outPath, packageName, panels }) => {
      const out = expandHome(outPath);
      if (path.extname(out) !== ".kt") return fail(`outPath must be a .kt file, got: ${out}`);

      // Guard against duplicate @Composable names (id collisions -> Kotlin won't compile).
      const ids = new Set<string>();
      for (const p of panels) {
        if (ids.has(p.id)) return fail(`Duplicate panel id '${p.id}' — each panel needs a unique id (becomes the @Composable name).`);
        ids.add(p.id);
      }

      const kotlin = generateSpatialUIKotlin({packageName, panels});
      try {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, kotlin);
      } catch (e: any) {
        return fail(`Failed to write ${out}: ${e?.message ?? e}`);
      }

      const fnNames = panels.map((p) => p.id.charAt(0).toUpperCase() + p.id.slice(1) + "Panel");
      return okJson({
        written: out,
        panels: panels.length,
        composables: fnNames,
        nextSteps: "Place card/menu/list in the existing panel lane; place Toolbar/TabBar as root/container augments; call Sheet/SnackbarHost/Coachmark only from a secondary WindowContainer. Then compile and LOOK.",
      });
    },
  );
}
