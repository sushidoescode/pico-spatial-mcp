// v27.6 scaffold-archetype test: pickArchetype steers a brief-only plan_app_spec call toward the
// pipeline's proven patterns (display/game/data-panel) instead of one generic showcase scaffold.
// v32 adds the MR-first pivot contract: every scaffold defaults to Mixed ("1"), the game archetype
// is the mrtable-style tabletop (not a floating Full-Space lane), stage-mode IBL under Mixed fails
// closed, and the per-template stage decisions hold.
// Run: npm run test:archetype
import { pickArchetype, matchArchetype, archetypeScaffold, SCAFFOLD_STAGE_NOTE } from "../dist/planner.js";
import { appSpecSchema } from "../dist/appspec.js";
import { buildTemplateDraft } from "../dist/templates.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures++; };

const CASES = [
  { brief: "a bowling knockdown game", want: "game" },
  { brief: "a live stats dashboard panel", want: "datapanel" },
  { brief: "three spinning crystals over a floor", want: "display" },
  { brief: "something abstract", want: "generic" },
  // v31.3 detection extensions: museum/gallery briefs are display; monitor is datapanel; a bare
  // "game" word (no bowling vocabulary) still steers game.
  { brief: "a museum hall of ancient relics on pedestals", want: "display" },
  { brief: "a system monitor for the build farm", want: "datapanel" },
  { brief: "target practice game", want: "game" },
];

for (const { brief, want } of CASES) {
  const got = pickArchetype(brief);
  if (got === want) ok(`pickArchetype("${brief}") -> ${got}`);
  else fail(`pickArchetype("${brief}") -> ${got}, expected ${want}`);

  const scaffold = archetypeScaffold(brief, got);
  const parsed = appSpecSchema.safeParse(scaffold);
  if (parsed.success) ok(`${got} scaffold for "${brief}" parses through appSpecSchema with zero issues`);
  else fail(`${got} scaffold for "${brief}" failed schema: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);

  // v32 MR default: every archetype scaffold ships Mixed ("1"); Full ("3") is an explicit opt-in.
  if (parsed.success && parsed.data.meta.stageStyle === "1") ok(`${got} scaffold defaults to Mixed (stageStyle "1")`);
  else if (parsed.success) fail(`${got} scaffold stageStyle is "${parsed.data.meta.stageStyle}", expected "1" (the MR default)`);
}

// Priority: a "bowling game dashboard" is a game — physics/interaction pattern dominates a HUD word.
const mixed = pickArchetype("a bowling game dashboard");
if (mixed === "game") ok(`pickArchetype("a bowling game dashboard") -> game (priority holds over datapanel words)`);
else fail(`priority broken: "a bowling game dashboard" -> ${mixed}, expected game`);

// display archetype's data node is named from a shape word in the brief (v27.1 procedural provisioning
// hook), not the generic "items" fallback.
{
  const spec = archetypeScaffold("three spinning crystals over a floor", "display");
  const hasGrid = spec.layouts.some((l) => l.pattern === "grid");
  const hasAnim = spec.objects.some((o) => o.anim && o.anim.property === "rotation");
  const dataId = spec.data[0]?.id;
  if (hasGrid) ok("display scaffold has a grid layout");
  else fail("display scaffold missing a grid layout");
  if (hasAnim) ok("display scaffold has a rotation tween anim");
  else fail("display scaffold missing a rotation tween anim");
  if (dataId === "crystal") ok(`display scaffold data node named from the brief's shape word ("${dataId}")`);
  else fail(`display scaffold data node id "${dataId}" not derived from the brief's shape word (expected "crystal")`);
  // v32 MR placement is explicit: eye-level content in front of the user, the room as backdrop
  // (the values are the proven layout-generator defaults, now named in the scaffold).
  const grid = spec.layouts[0];
  if (grid?.params?.centerY === 1.4 && grid?.params?.centerZ === -2.5) ok("display grid names its MR placement (centerY 1.4 eye level, centerZ -2.5 in front)");
  else fail(`display grid MR placement params missing: ${JSON.stringify(grid?.params)}`);
}

// game archetype (v32 MR restructure): a TABLETOP knockdown in the user's room modeled on
// briefs/mrtable.json — one static table + one dynamic ball + 3 dynamic pins racked ON the tabletop
// + press-menu + a 2-field HUD panel. No floating Full-Space lane.
{
  const spec = archetypeScaffold("a bowling knockdown game", "game");
  const statics = spec.objects.filter((o) => o.body?.mode === "static");
  const dynamics = spec.objects.filter((o) => o.body?.mode === "dynamic");
  const presses = spec.interactions.filter((i) => i.trigger === "press");
  const actions = presses.map((i) => i.action).sort();
  if (statics.length === 1) ok("game scaffold has one static table object");
  else fail(`game scaffold has ${statics.length} static objects, expected 1`);
  if (dynamics.length === 4) ok("game scaffold has 1 dynamic ball + 3 dynamic pins (4 dynamic bodies)");
  else fail(`game scaffold has ${dynamics.length} dynamic objects, expected 4`);
  if (JSON.stringify(actions) === JSON.stringify(["launch:ball", "resetWorld"])) ok("game scaffold wires launch:ball + resetWorld press interactions");
  else fail(`game scaffold interactions mismatch: ${JSON.stringify(actions)}`);
  if (spec.panels.length === 1 && spec.panels[0].fields.length === 2) ok("game scaffold has a 2-field HUD panel");
  else fail(`game scaffold panels mismatch: ${JSON.stringify(spec.panels)}`);

  // mrtable geometry contract: the table's base sits at y=0.4 (the emulator room's measured FLOOR
  // plane height) so it reads as standing in the room, and every dynamic body starts above the
  // tabletop surface inside its footprint (they settle on the table, not on a void lane).
  const table = spec.objects.find((o) => o.id === "tableTop");
  if (table && table.body?.mode === "static" && table.body?.shape === "box") ok("game scaffold's static object is the mrtable-style tableTop box");
  else fail(`game scaffold missing static tableTop box: ${JSON.stringify(spec.objects.map((o) => o.id))}`);
  if (table) {
    const [tx, ty, tz] = table.transform.position;
    const [dx, dy, dz] = table.body.dims;
    const base = ty - dy / 2;
    if (Math.abs(base - 0.4) < 1e-9) ok("table base sits at y=0.4 (the measured floor-plane height — standing in the room)");
    else fail(`table base at y=${base}, expected 0.4`);
    const topY = ty + dy / 2;
    const offTable = dynamics.filter((o) => {
      const [x, y, z] = o.transform.position;
      return !(y > topY && Math.abs(x - tx) <= dx / 2 && Math.abs(z - tz) <= dz / 2);
    });
    if (offTable.length === 0) ok("all dynamic bodies start above the tabletop surface, inside its footprint");
    else fail(`dynamic bodies off the tabletop: ${offTable.map((o) => o.id).join(", ")}`);
  }
}

// datapanel archetype: a HUD panel with 3 fields + a data node + one modest display object.
{
  const spec = archetypeScaffold("a live stats dashboard panel", "datapanel");
  if (spec.panels.length === 1 && spec.panels[0].fields.length === 3) ok("datapanel scaffold has a 3-field HUD panel");
  else fail(`datapanel scaffold panels mismatch: ${JSON.stringify(spec.panels)}`);
  if (spec.data.length === 1) ok("datapanel scaffold has a data node");
  else fail(`datapanel scaffold has ${spec.data.length} data nodes, expected 1`);
  if (spec.objects.length === 1) ok("datapanel scaffold has one modest display object");
  else fail(`datapanel scaffold has ${spec.objects.length} objects, expected 1`);
}

// v31.3: matchArchetype names WHY (the matched keywords) so the scaffold response can surface the
// steer and the author can override it; the fallback matches nothing.
{
  const m = matchArchetype("a museum gallery of relics on pedestals");
  if (m.archetype === "display" && m.matched.includes("museum") && m.matched.includes("gallery") && m.matched.includes("pedestal"))
    ok(`matchArchetype names the matched keywords (${m.matched.join(", ")})`);
  else fail(`matchArchetype why broken: ${JSON.stringify(m)}`);
  const g = matchArchetype("something abstract");
  if (g.archetype === "generic" && g.matched.length === 0) ok("fallback stays generic with zero matched keywords");
  else fail(`generic fallback broken: ${JSON.stringify(g)}`);
}

// v31.3: museum/gallery briefs get the corpus exhibition variant of display — an ARC layout
// (briefs/gallery.json) + a gaze-dwell showDetail inspect interaction (briefs/museum.json,
// broadcast-driven so it stays C0) and NO spin tween; crystal-style briefs keep grid+spin (asserted
// above), so the doors crystals contract is unchanged.
{
  const spec = archetypeScaffold("a museum hall of ancient relics on pedestals", "display");
  if (spec.layouts.length === 1 && spec.layouts[0].pattern === "arc") ok("museum display variant lays out in an arc");
  else fail(`museum variant layout mismatch: ${JSON.stringify(spec.layouts)}`);
  const inspect = spec.interactions[0];
  if (spec.interactions.length === 1 && inspect.trigger === "gaze_dwell" && inspect.action === "showDetail" && inspect.driveChannel === "broadcast")
    ok("museum display variant carries the gaze-dwell showDetail inspect interaction (broadcast-driven)");
  else fail(`museum variant interactions mismatch: ${JSON.stringify(spec.interactions)}`);
  if (spec.objects.every((o) => !o.anim)) ok("museum display variant exhibits sit still (no spin tween)");
  else fail(`museum variant unexpectedly animates: ${JSON.stringify(spec.objects)}`);
  const parsed = appSpecSchema.safeParse(spec);
  if (parsed.success) ok("museum display variant parses through appSpecSchema");
  else fail(`museum variant schema: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
}

// v32 schema-level MR default: an omitted meta.stageStyle parses as Mixed ("1"), and stage-mode IBL
// (explicit OR the implicit default) under Mixed fails closed naming mode 'local' — the capabilities
// boundary records StageEnvironmentLighting inactive in a MIXED stage. 'stage' stays valid for "3".
{
  const iblSpec = (mode, stageStyle) => ({
    meta: { appName: "X", packageName: "com.x.y", brief: "b", ...(stageStyle ? { stageStyle } : {}) },
    scenes: [{
      id: "main",
      environment: { kind: "procedural" },
      lighting: { rig: "ibl", params: { ktxAssetPath: "ibl/studio.ktx", intensityExponent: 6, ...(mode ? { mode } : {}) } },
      colliders: { props: [] },
    }],
    navigation: { startScene: "main" },
  });

  const defaulted = appSpecSchema.parse({ ...iblSpec("local", undefined) });
  if (defaulted.meta.stageStyle === "1") ok('omitted meta.stageStyle parses as Mixed ("1") — the MR default');
  else fail(`omitted stageStyle parsed as "${defaulted.meta.stageStyle}", expected "1"`);

  const implicitStage = appSpecSchema.safeParse(iblSpec(undefined, undefined));
  if (!implicitStage.success && /local/.test(implicitStage.error.issues.map((i) => i.message).join(" ")))
    ok("implicit stage-mode IBL under the Mixed default fails closed, naming mode 'local'");
  else fail(`implicit stage-mode IBL under Mixed did not fail closed: ${JSON.stringify(implicitStage.success ? "parsed" : implicitStage.error.issues)}`);

  const explicitStage = appSpecSchema.safeParse(iblSpec("stage", "1"));
  if (!explicitStage.success) ok("explicit mode 'stage' IBL under stageStyle \"1\" fails closed");
  else fail("explicit stage-mode IBL under Mixed parsed — it would silently light nothing");

  const fullStage = appSpecSchema.safeParse(iblSpec("stage", "3"));
  if (fullStage.success) ok("mode 'stage' IBL stays valid for stageStyle \"3\" (Full opt-in)");
  else fail(`stage-mode IBL under "3" wrongly rejected: ${fullStage.error.issues.map((i) => i.message).join("; ")}`);

  const localMixed = appSpecSchema.safeParse(iblSpec("local", "1"));
  if (localMixed.success) ok("mode 'local' IBL parses under Mixed");
  else fail(`local-mode IBL under Mixed wrongly rejected: ${localMixed.error.issues.map((i) => i.message).join("; ")}`);
}

// v32 per-template stage decisions: gallery/inspection/dashboard/showcase/studio flip to Mixed ("1");
// knockdown deliberately stays Full ("3" — the verified Full-Space physics proof-path, not yet
// re-captured in Mixed); ambient/constellation keep Progressive ("2") intentionally.
{
  const WANT_STAGE = { gallery: "1", inspection: "1", dashboard: "1", showcase: "1", studio: "1", knockdown: "3", ambient: "2", constellation: "2" };
  for (const [name, want] of Object.entries(WANT_STAGE)) {
    const draft = buildTemplateDraft(name, { appName: "T", packageName: "com.t.t", brief: "template stage check" });
    if (draft?.meta?.stageStyle === want) ok(`template '${name}' stageStyle "${want}"`);
    else fail(`template '${name}' stageStyle "${draft?.meta?.stageStyle}", expected "${want}"`);
    const parsed = appSpecSchema.safeParse(draft);
    if (parsed.success) ok(`template '${name}' still parses through appSpecSchema`);
    else fail(`template '${name}' schema: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  // gallery's env is procedural now — a texturedMesh env under Mixed would occlude the passthrough room.
  const gallery = buildTemplateDraft("gallery", { appName: "T", packageName: "com.t.t", brief: "b" });
  if (gallery.scenes[0].environment.kind === "procedural") ok("gallery template env is procedural (the room is the hall — no env mesh occluding passthrough)");
  else fail(`gallery template env is ${gallery.scenes[0].environment.kind}, expected procedural under Mixed`);
}

// v32: the scaffold response names the stage choice + the Full opt-in, with the Guardian caveat
// PARTNER-STATED (never presented as measured by us).
if (/'1'/.test(SCAFFOLD_STAGE_NOTE) && /Mixed/.test(SCAFFOLD_STAGE_NOTE) && /'3'/.test(SCAFFOLD_STAGE_NOTE) && /opt/i.test(SCAFFOLD_STAGE_NOTE) && /partner-stated/i.test(SCAFFOLD_STAGE_NOTE))
  ok("SCAFFOLD_STAGE_NOTE names Mixed default + the '3' opt-in + the partner-stated caveat");
else fail(`SCAFFOLD_STAGE_NOTE incomplete: ${SCAFFOLD_STAGE_NOTE}`);

// Aug 9 runbook finding: weak hosts can stringify either the whole MCP arguments record or just
// its nested AppSpec. Both shapes must fail precisely; neither may be parsed or silently planned.
{
  const brief = "three spinning crystals over a stone floor";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: { ...process.env, PICO_MCP_SURFACE: "full" },
  });
  const client = new Client({ name: "planner-stringified-params-test", version: "1" });
  try {
    await client.connect(transport);
    const scaffoldCall = await client.callTool({ name: "plan_app_spec", arguments: { brief } });
    const scaffold = JSON.parse(scaffoldCall.content[0].text).scaffold;

    let protocolError = "";
    try {
      await client.callTool({ name: "plan_app_spec", arguments: JSON.stringify({ brief }) });
    } catch (error) {
      protocolError = error instanceof Error ? error.message : String(error);
    }
    if (/params[\s\S]*arguments/.test(protocolError) && /expected record, received string/i.test(protocolError))
      ok("a stringified MCP arguments record is rejected at the protocol boundary with record/string types");
    else fail(`stringified MCP arguments rejection was not precise: ${protocolError}`);

    const nestedCall = await client.callTool({
      name: "plan_app_spec",
      arguments: { brief, draftSpec: JSON.stringify(scaffold) },
    });
    const nested = JSON.parse(nestedCall.content[0].text);
    const nestedIssue = nested.issues?.[0];
    if (nested.status === "invalid" && /draftSpec/.test(nested.message ?? "")
        && /expected object, received string/i.test(nestedIssue?.problem ?? ""))
      ok("plan_app_spec rejects a stringified draftSpec and names the field plus object/string types");
    else fail(`plan_app_spec silently planned or imprecisely rejected stringified draftSpec: ${JSON.stringify(nested)}`);

    const doorCall = await client.callTool({
      name: "pico_build_app",
      arguments: { brief, draftSpec: JSON.stringify(scaffold) },
    });
    const door = JSON.parse(doorCall.content[0].text);
    const doorIssue = door.detail?.issues?.[0];
    if (door.status === "plan-failed" && /draftSpec/.test(door.detail?.message ?? "")
        && /expected object, received string/i.test(doorIssue?.problem ?? ""))
      ok("pico_build_app stops at planning and preserves the precise stringified-draftSpec error");
    else fail(`pico_build_app silently planned or imprecisely rejected stringified draftSpec: ${JSON.stringify(door)}`);
  } finally {
    await client.close().catch(() => {});
  }
}

console.log(`\nArchetype test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
