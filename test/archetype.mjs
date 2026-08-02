// v27.6 scaffold-archetype test: pickArchetype steers a brief-only plan_app_spec call toward the
// pipeline's proven patterns (display/game/data-panel) instead of one generic showcase scaffold.
// Run: npm run test:archetype
import { pickArchetype, matchArchetype, archetypeScaffold } from "../dist/planner.js";
import { appSpecSchema } from "../dist/appspec.js";

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
}

// game archetype: static lane box + one dynamic ball + 3 dynamic pins + press-menu + a 2-field HUD panel.
{
  const spec = archetypeScaffold("a bowling knockdown game", "game");
  const statics = spec.objects.filter((o) => o.body?.mode === "static");
  const dynamics = spec.objects.filter((o) => o.body?.mode === "dynamic");
  const presses = spec.interactions.filter((i) => i.trigger === "press");
  const actions = presses.map((i) => i.action).sort();
  if (statics.length === 1) ok("game scaffold has one static lane object");
  else fail(`game scaffold has ${statics.length} static objects, expected 1`);
  if (dynamics.length === 4) ok("game scaffold has 1 dynamic ball + 3 dynamic pins (4 dynamic bodies)");
  else fail(`game scaffold has ${dynamics.length} dynamic objects, expected 4`);
  if (JSON.stringify(actions) === JSON.stringify(["launch:ball", "resetWorld"])) ok("game scaffold wires launch:ball + resetWorld press interactions");
  else fail(`game scaffold interactions mismatch: ${JSON.stringify(actions)}`);
  if (spec.panels.length === 1 && spec.panels[0].fields.length === 2) ok("game scaffold has a 2-field HUD panel");
  else fail(`game scaffold panels mismatch: ${JSON.stringify(spec.panels)}`);
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

console.log(`\nArchetype test done. Failures: ${failures}`);
process.exit(failures ? 1 : 0);
