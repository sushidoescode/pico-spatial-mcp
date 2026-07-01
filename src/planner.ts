import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { okJson } from "./util.js";
import { appSpecSchema, exampleSpec, type AppSpec, type CapabilityClass } from "./appspec.js";
import { CAPABILITY_MANIFEST } from "./capabilities.js";

/**
 * planner.ts — v5.0 `plan_app_spec` + `replan_spec`.
 *
 * The LLM agent is the PLANNER; these tools are the TYPECHECKER + FEASIBILITY LINTER + RECONCILER. Given a
 * draft AppSpec, plan_app_spec validates it, checks referential integrity, STAMPS each node's C1–C4
 * capability class (the honesty engine — decided at plan time), requires a forward-FOV pose for every C0/C2
 * visual claim, checks every node maps to a real tool in the manifest, flags budget overflow, and returns
 * the normalized spec + an honest emulator-vs-Swan preview. replan_spec mutates the spec in response to a
 * verification failure (move a slot out of the bed, downgrade a C3 interaction to broadcast, mark an env
 * asset for baking) and names the subtree to recompile. Side-effect-free — inspect/edit before compiling.
 */

// ── C-class inference (the plan-time honesty decision) ─────────────────────────────────────────────────
function interactionClass(trigger: string, driveChannel: string): CapabilityClass {
  if (trigger === "controller_ray" || trigger === "grab" || trigger === "press") return "C3";
  if (trigger === "gaze_dwell") return driveChannel === "broadcast" ? "C0_emulator" : "C3";
  return "C0_emulator"; // broadcast
}

function environmentClass(kind: string): CapabilityClass {
  if (kind === "homeEnvProxy") return "C1"; // real surfaces are Swan-only; floor y=0 is the only anchor
  return "C0_emulator";
}

const toolExists = (name: string) => CAPABILITY_MANIFEST.some((t) => t.tool === name);

type Lint = { errors: string[]; warnings: string[] };

export function lintSpec(spec: AppSpec): Lint {
  const errors: string[] = [];
  const warnings: string[] = [];
  const sceneIds = new Set(spec.scenes.map((s) => s.id));
  const layoutIds = new Set(spec.layouts.map((l) => l.id));
  const objectIds = new Set(spec.objects.map((o) => o.id));
  const dataIds = new Set(spec.data.map((d) => d.id));

  // referential integrity
  for (const l of spec.layouts) if (!sceneIds.has(l.sceneId)) errors.push(`layout '${l.id}' references unknown scene '${l.sceneId}'`);
  for (const o of spec.objects) {
    if (!sceneIds.has(o.sceneId)) errors.push(`object '${o.id}' references unknown scene '${o.sceneId}'`);
    if (o.layoutRef && !layoutIds.has(o.layoutRef)) errors.push(`object '${o.id}' references unknown layout '${o.layoutRef}'`);
    if (o.dataBindRef && !dataIds.has(o.dataBindRef)) errors.push(`object '${o.id}' references unknown data '${o.dataBindRef}'`);
  }
  for (const d of spec.data) for (const b of d.bindsTo) if (!objectIds.has(b)) errors.push(`data '${d.id}' binds to unknown object '${b}'`);
  for (const it of spec.interactions) if (!objectIds.has(it.target) && !layoutIds.has(it.target)) warnings.push(`interaction '${it.id}' target '${it.target}' is not a known object/layout id`);
  if (!sceneIds.has(spec.navigation.startScene)) errors.push(`navigation.startScene '${spec.navigation.startScene}' is not a scene`);
  for (const p of spec.navigation.portals) {
    if (!sceneIds.has(p.from)) errors.push(`portal from unknown scene '${p.from}'`);
    if (!sceneIds.has(p.to)) errors.push(`portal to unknown scene '${p.to}'`);
  }

  // tool availability
  if (spec.layouts.length && !toolExists("generate_layout_kotlin")) errors.push("layouts require generate_layout_kotlin (missing from manifest)");
  if (spec.interactions.length && !toolExists("generate_interaction_kotlin")) errors.push("interactions require generate_interaction_kotlin (missing from manifest)");
  if (spec.data.some((d) => d.source === "json") && !toolExists("generate_data_binding_kotlin")) errors.push("json data requires generate_data_binding_kotlin (missing from manifest)");

  // C2: every C0/C2 capture claim needs a forward-FOV pose (content outside the forward view can't be captured)
  for (const v of spec.verificationPlan) {
    const visualNow = v.capabilityClass === "C0_emulator" || v.capabilityClass === "C2";
    if (v.method === "capture" && visualNow && !v.forwardFOVpose)
      errors.push(`verification '${v.claim}' is a ${v.capabilityClass} capture but has no forwardFOVpose — it can't be honestly verified (C2). Add a pose or tag it Swan-only.`);
    if (v.targetRef && !sceneIds.has(v.targetRef) && !layoutIds.has(v.targetRef) && !objectIds.has(v.targetRef) && !spec.interactions.some((i) => i.id === v.targetRef))
      warnings.push(`verification '${v.claim}' targetRef '${v.targetRef}' resolves to no spec node`);
  }

  // gated api is network-flagged
  for (const d of spec.data) if (d.source === "gated_api") warnings.push(`data '${d.id}' is a gated_api node — network-gated; verify with one live call and flag it, don't fake it`);

  return { errors, warnings };
}

export function emulatorVsSwanPreview(spec: AppSpec) {
  const verifiableNow: string[] = [];
  const builtForSwan: string[] = [];
  for (const it of spec.interactions) {
    const cls = interactionClass(it.trigger, it.driveChannel);
    (cls === "C0_emulator" ? verifiableNow : builtForSwan).push(`interaction ${it.id} (${it.trigger}) → ${cls}`);
  }
  for (const s of spec.scenes) {
    const cls = environmentClass(s.environment.kind);
    (cls === "C0_emulator" ? verifiableNow : builtForSwan).push(`scene ${s.id} env ${s.environment.kind} → ${cls}`);
  }
  for (const v of spec.verificationPlan) {
    const now = v.capabilityClass === "C0_emulator" || v.capabilityClass === "C2";
    (now ? verifiableNow : builtForSwan).push(`verify "${v.claim}" → ${v.capabilityClass}`);
  }
  for (const h of spec.headsetLayer) builtForSwan.push(`headset: ${h.feature} → ${h.capabilityClass}`);
  return { verifiableNow, builtForSwan };
}

export function registerPlannerTools(server: McpServer) {
  server.registerTool(
    "plan_app_spec",
    {
      description:
        "Validate + feasibility-lint a draft AppSpec (the brief-to-app plan). You (the agent) author the AppSpec from the brief against list_capabilities; this tool zod-validates it, checks referential integrity (every scene/layout/object/data/interaction reference resolves), STAMPS each interaction & scene with its C1–C4 capability class, REQUIRES a forward-FOV camera pose for every C0/C2 visual capture claim (C2 honesty), verifies every node maps to a real tool, flags budget overflow, and returns the normalized spec + rationale + an honest emulator-vs-Swan preview. Side-effect-free: inspect/edit before compile_app_spec. Omit draftSpec to get a well-formed scaffold spec to fill in.",
      inputSchema: {
        brief: z.string().describe("The natural-language product brief."),
        draftSpec: z.any().optional().describe("Your candidate AppSpec (see appSpec shape). Omit to receive a scaffold to fill in."),
        budget: z
          .object({ iterations: z.number().int().optional(), timeMin: z.number().optional(), toolCalls: z.number().int().optional() })
          .optional()
          .describe("Optional soft budget."),
      },
    },
    async ({ brief, draftSpec, budget }) => {
      if (draftSpec === undefined) {
        return okJson({
          status: "scaffold",
          message: "No draftSpec supplied — here is a well-formed scaffold AppSpec to adapt to the brief. Author against list_capabilities, then call plan_app_spec again with draftSpec.",
          scaffold: exampleSpec(brief),
        });
      }
      const parsed = appSpecSchema.safeParse(draftSpec);
      if (!parsed.success) {
        return okJson({
          status: "invalid",
          message: "draftSpec failed schema validation — fix these and retry.",
          issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        });
      }
      const spec = parsed.data;
      if (budget) spec.meta.budget = { ...spec.meta.budget, ...budget };
      const lint = lintSpec(spec);

      // budget overflow (rough: each scene/layout/object/data/interaction/verify node ≈ one authoring step)
      const nodeCount = spec.scenes.length + spec.layouts.length + spec.objects.length + spec.data.length + spec.interactions.length;
      if (spec.meta.budget?.toolCalls && nodeCount > spec.meta.budget.toolCalls)
        lint.warnings.push(`plan has ~${nodeCount} authoring nodes but budget.toolCalls is ${spec.meta.budget.toolCalls} — likely to overflow`);

      const preview = emulatorVsSwanPreview(spec);
      return okJson({
        status: lint.errors.length ? "needs_fix" : "ok",
        spec,
        lint,
        emulatorVsSwanPreview: preview,
        rationale: [
          `Plan for "${spec.meta.appName}" (${spec.meta.packageName}): ${spec.scenes.length} scene(s), ${spec.layouts.length} layout(s), ${spec.objects.length} object(s), ${spec.data.length} data node(s), ${spec.interactions.length} interaction(s).`,
          `${preview.verifiableNow.length} node(s) emulator-verifiable now; ${preview.builtForSwan.length} built-for-Swan.`,
          lint.errors.length ? `${lint.errors.length} error(s) MUST be fixed before compile_app_spec.` : `No blocking errors — ready for compile_app_spec.`,
        ].join(" "),
      });
    },
  );

  server.registerTool(
    "replan_spec",
    {
      description:
        "Mutate an AppSpec in response to a verification failure and name the subtree to recompile. Pass the current spec + the failed claims (each with a symptom drawn from the diagnose vocabulary, e.g. 'slot_in_bed', 'texture_black', 'dim'/'unlit', 'no_hit'/'C3'/'dead_buttons'). Applies the retained-lesson fix (move a layout out of the bed, mark an env asset for baking, ensure a lighting rig, downgrade a controller/gaze interaction to a broadcast drive so it's emulator-verifiable) and returns the patched spec + the list of node ids to re-compile. Re-run plan_app_spec on the result to re-lint.",
      inputSchema: {
        spec: z.any().describe("The current AppSpec."),
        failures: z
          .array(z.object({ targetRef: z.string().optional(), claim: z.string().optional(), symptom: z.string().describe("diagnose-style symptom keyword") }))
          .describe("The failed verification nodes and their symptoms."),
      },
    },
    async ({ spec: raw, failures }) => {
      const parsed = appSpecSchema.safeParse(raw);
      if (!parsed.success) return okJson({ status: "invalid", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
      const spec = parsed.data;
      const recompile = new Set<string>();
      const changes: string[] = [];

      for (const f of failures) {
        const sym = f.symptom.toLowerCase();
        // placement: slot in the bed / bad position → push the layout further out & up
        if (sym.includes("bed") || sym.includes("slot") || sym.includes("sunk")) {
          for (const l of spec.layouts) {
            if (f.targetRef && l.id !== f.targetRef) continue;
            l.params = { ...(l.params ?? {}), centerZ: -3.0, centerY: 1.5 };
            recompile.add(l.id);
            changes.push(`layout '${l.id}': moved out of the bed (centerZ=-3.0, centerY=1.5)`);
          }
        }
        // dim/unlit clusters → ensure a lighting rig on the scene
        if (sym.includes("dim") || sym.includes("unlit") || sym.includes("dark")) {
          for (const s of spec.scenes) {
            if (s.lighting.rig === "none") { s.lighting.rig = "fullRig"; recompile.add(s.id); changes.push(`scene '${s.id}': lighting rig none→fullRig`); }
          }
        }
        // raw-GLB black → the env asset must be baked
        if (sym.includes("black") || sym.includes("texture")) {
          for (const s of spec.scenes) {
            if (s.environment.kind === "texturedMesh") {
              s.environment.baseColorImage = s.environment.baseColorImage ?? "REQUIRES_BAKE.png";
              recompile.add(s.id);
              changes.push(`scene '${s.id}': env must use a BAKED bundle (bake_textured_model), never a raw GLB`);
            }
          }
        }
        // C3 / no controller / dead buttons → downgrade to a broadcast-driven interaction (emulator-verifiable)
        if (sym.includes("c3") || sym.includes("controller") || sym.includes("no_hit") || sym.includes("dead")) {
          for (const it of spec.interactions) {
            if (f.targetRef && it.id !== f.targetRef && it.target !== f.targetRef) continue;
            if (it.driveChannel !== "broadcast") { it.driveChannel = "broadcast"; recompile.add(it.id); changes.push(`interaction '${it.id}': drive controller→broadcast (emulator-verifiable; keep the controller path in headsetLayer)`); }
          }
        }
        // nothing rendered → ensure a lighting rig + flag the main-thread/camera checks (v5.2 critique symptom)
        if (sym.includes("not_render") || sym.includes("empty") || sym.includes("blank")) {
          for (const s of spec.scenes) {
            if (s.lighting.rig === "none") { s.lighting.rig = "sun"; recompile.add(s.id); changes.push(`scene '${s.id}': lighting rig none→sun`); }
          }
          changes.push("not_rendering: confirm entities are added on the MAIN thread (broadcast handlers arrive off-main) and lie in the forward FOV before re-capture");
        }
        // occlusion / crowding → widen the layout spacing
        if (sym.includes("placement") || sym.includes("occlud") || sym.includes("overlap") || sym.includes("crowd")) {
          for (const l of spec.layouts) {
            if (f.targetRef && l.id !== f.targetRef) continue;
            const cur = Number((l.params ?? {}).spacing ?? 0.6);
            l.params = { ...(l.params ?? {}), spacing: Math.round((cur + 0.2) * 100) / 100 };
            recompile.add(l.id);
            changes.push(`layout '${l.id}': spacing ${cur}→${(l.params as any).spacing} to reduce occlusion`);
          }
        }
        // wrong forward view / off-screen → snap the verification node's camera pose forward (C2)
        if (sym.includes("camera") || sym.includes("offscreen") || sym.includes("off_screen") || sym.includes("away")) {
          for (const v of spec.verificationPlan) {
            if (f.claim && v.claim !== f.claim) continue;
            if (v.method === "capture") { v.forwardFOVpose = { yawDeg: 0, pitchDeg: 0, targetZ: -2.0 }; changes.push(`verification '${v.claim}': camera pose snapped to forward (yaw0/pitch0/z-2.0)`); }
          }
        }
        // data-bound color mismatch → can't auto-fix a JSON, flag it
        if (sym.includes("color") || sym.includes("mismatch")) {
          changes.push(`color mismatch${f.targetRef ? ` on '${f.targetRef}'` : ""}: verify the JSON color entry + the RGB(0..1) order in the data node — manual check`);
        }
      }

      if (!changes.length) changes.push("no automatic mutation matched the symptoms — needs manual triage (see diagnose).");
      return okJson({ status: changes.length ? "patched" : "unchanged", spec, changes, recompileSubtree: Array.from(recompile) });
    },
  );
}
