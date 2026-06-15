import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, okJson, fail } from "./util.js";

/**
 * author_editor_component — emit editor-format SpatialComponent/USD blocks (Collision / Audio /
 * Timeline) to attach onto a prim, so an agent can author editor-grade content as USD text.
 *
 * Grounding (NOT invented):
 *  - Collision BOX = the EXACT instance format the editor wrote in a real scene (claimsight
 *    MyScene.usda: SpatialComponent info:id/typeId + nested SpatialStruct shapes0 + mesh, with the
 *    editor's magic typeIds). HONEST: text-authored collision does NOT register physics on the
 *    device without the editor BAKE — for working runtime rayCast use generate_collider_kotlin.
 *  - Audio/Timeline = conformant to the editor's authoritative schema.usda
 *    (spatialbundle/usd/spatialAudio|spatialTimeline/resources/schema.usda). Round-trip-verified by
 *    packing through `spatialbundle` (the editor's own packer).
 */

const v3 = (a?: number[], d: [number, number, number] = [0, 0, 0]) => {
  const t = (a && a.length === 3 ? a : d) as number[];
  return `(${t.map((n) => Number(n)).join(", ")})`;
};
const v4 = (a?: number[], d: [number, number, number, number] = [1, 0, 0, 0]) => {
  const t = (a && a.length === 4 ? a : d) as number[];
  return `(${t.map((n) => Number(n)).join(", ")})`;
};

function collisionBox(name: string, p: any): string {
  return [
    `def SpatialComponent "${name}"`,
    `{`,
    `    uniform token info:id = "CollisionComponent"`,
    `    uint64 info:typeId = 10170138008305910195`,
    ``,
    `    def SpatialStruct "shapes0"`,
    `    {`,
    `        float3 center = ${v3(p.center)}`,
    `        uint64 id = ${Math.trunc(p.id ?? 1)}`,
    `        uint64 info:typeId = 4878244361267076049`,
    `        bool isConvexMesh = 1`,
    `        quatf rotation = ${v4(p.rotation)}`,
    `        float3 size = ${v3(p.size, [1, 1, 1])}`,
    `        token type = "BOX"`,
    ``,
    `        def SpatialStruct "mesh"`,
    `        {`,
    `            uint64 info:typeId = 7578755580861454209`,
    `            uint64 parent_resource_id = 0`,
    `            uint64 resource_id = 0`,
    `        }`,
    `    }`,
    `}`,
  ].join("\n");
}

function audioFile(name: string, p: any): string {
  const lines = [
    `def SpatialAudioFile "${name}"`,
    `{`,
    `    uniform asset file = @${p.file ?? "../Assets/audio.wav"}@`,
    `    uniform token loadingStrategy = "${p.loadingStrategy ?? "preload"}"`,
    `    uniform token normalization = "${p.normalization ?? "none"}"`,
    `    uniform token calibrationMode = "${p.calibrationMode ?? "absolute"}"`,
    `    uniform token playMode = "${p.playMode ?? "forward"}"`,
    `    uniform bool shouldLoop = ${p.shouldLoop ? 1 : 0}`,
    `    uniform bool shouldRandomizeStartTime = ${p.shouldRandomizeStartTime ? 1 : 0}`,
  ];
  if (p.mixerGroupPath) lines.push(`    rel mixerGroup = <${p.mixerGroupPath}>`);
  lines.push(`}`);
  return lines.join("\n");
}

function audioMixer(name: string, p: any): string {
  return [
    `def SpatialAudioMixerGroup "${name}"`,
    `{`,
    `    float gain = ${Number(p.gain ?? 0)}`,
    `    float speed = ${Number(p.speed ?? 1)}`,
    `    bool mute = ${p.mute ? 1 : 0}`,
    `}`,
  ].join("\n");
}

function timeline(name: string, p: any): string {
  const action = [
    `        def SpatialTimelineAction "Action0"`,
    `        {`,
    `            uniform token info:id = "${p.infoId ?? "action"}"`,
    `            string actionKind = "${p.actionKind ?? "play"}"`,
    `            double startTime = ${Number(p.startTime ?? 0)}`,
    p.targetPath ? `            rel target = <${p.targetPath}>` : `            rel target`,
    `        }`,
  ].join("\n");
  return [
    `def SpatialTimeline "${name}"`,
    `{`,
    `    int order = 0`,
    `    def SpatialTimelineTrack "Track0"`,
    `    {`,
    `        int order = 0`,
    action,
    `    }`,
    `}`,
  ].join("\n");
}

export function registerEditorComponentTools(server: McpServer) {
  server.registerTool(
    "author_editor_component",
    {
      description:
        "Emit an editor-format USD component block (Collision BOX / Audio file / Audio mixer / Timeline) to nest under a prim in a Spatial-Editor scene (.usda). Collision uses the exact instance format the editor wrote (verified) — NOTE: text collision needs the editor BAKE to register physics (use generate_collider_kotlin for working runtime rayCast). Audio/Timeline conform to the editor's authoritative schema.usda and are round-trip-checked by packing through spatialbundle. Returns the USD text + where to attach it.",
      inputSchema: {
        component: z.enum(["collision_box", "audio_file", "audio_mixer", "timeline"]).describe("Which editor component to emit."),
        name: z.string().optional().describe("Prim name for the emitted def (default per component)."),
        // collision_box
        center: z.array(z.number()).optional().describe("collision_box: BOX center [x,y,z]."),
        size: z.array(z.number()).optional().describe("collision_box: BOX full extents [x,y,z]."),
        rotation: z.array(z.number()).optional().describe("collision_box: quatf [w,x,y,z] (default identity)."),
        id: z.number().optional().describe("collision_box: shape id (default 1)."),
        // audio_file
        file: z.string().optional().describe("audio_file: asset path, e.g. ../Assets/clip.wav"),
        loadingStrategy: z.enum(["preload", "stream"]).optional(),
        normalization: z.enum(["none", "dynamic"]).optional(),
        calibrationMode: z.enum(["none", "absolute", "relative"]).optional(),
        playMode: z.enum(["random", "forward", "backward"]).optional(),
        shouldLoop: z.boolean().optional(),
        shouldRandomizeStartTime: z.boolean().optional(),
        mixerGroupPath: z.string().optional().describe("audio_file: prim path of a SpatialAudioMixerGroup."),
        // audio_mixer
        gain: z.number().optional(),
        speed: z.number().optional(),
        mute: z.boolean().optional(),
        // timeline
        actionKind: z.string().optional().describe("timeline: action kind, e.g. play|pause."),
        startTime: z.number().optional(),
        targetPath: z.string().optional().describe("timeline: prim path the action targets."),
        infoId: z.string().optional(),
        asJson: z.boolean().optional().describe("Return JSON {usd, attachUnder, note} instead of raw USD."),
      },
    },
    async (args) => {
      const { component } = args;
      let usd: string;
      let defaultName: string;
      let caveat = "";
      switch (component) {
        case "collision_box":
          defaultName = "CollisionComponent";
          usd = collisionBox(args.name ?? defaultName, args);
          caveat = "Text collision does NOT register physics on-device without the editor BAKE — use generate_collider_kotlin for working runtime rayCast. This block is for editor round-trip / authoring.";
          break;
        case "audio_file":
          defaultName = "AudioFile";
          usd = audioFile(args.name ?? defaultName, args);
          caveat = "Conformant to spatialAudio/schema.usda; round-trip-verify by packing through spatialbundle.";
          break;
        case "audio_mixer":
          defaultName = "MixerGroup";
          usd = audioMixer(args.name ?? defaultName, args);
          caveat = "Conformant to spatialAudio/schema.usda.";
          break;
        case "timeline":
          defaultName = "Timeline";
          usd = timeline(args.name ?? defaultName, args);
          caveat = "Conformant to spatialTimeline/schema.usda.";
          break;
        default:
          return fail(`unknown component: ${component}`);
      }
      const attachUnder = "Nest this def under your target prim in Sources/Scenes/*.usda (e.g. inside the entity's Xform), then re-pack the bundle.";
      if (args.asJson) return okJson({ component, usd, attachUnder, caveat });
      return ok(`# ${component} — ${caveat}\n# ${attachUnder}\n\n${usd}\n`);
    },
  );
}
