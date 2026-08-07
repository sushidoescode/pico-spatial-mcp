import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, fail } from "./util.js";

/**
 * events.ts — v35.16 the EVENT BUS: content.subscribe(...) -> Cancellable.
 *
 * THE GAP. Grep for CollisionEvents, content.subscribe, AudioEvents or AnimationEvents across all of
 * src/ before this file and you get nothing. Our generated apps could SIMULATE but not REACT: "ball
 * hits pin -> score" had to be polled from the agent bridge instead of handled in-app. This is one
 * generator that serves physics, audio AND animation, because they share one bus.
 *
 * Every symbol is cited from the 0.13.3 jars; the shape follows PICO's 0.13.3 samples.
 *
 *   core `container/SpatialViewEventManager.kt:45-52`
 *       @MainThread fun <T : Event> subscribe(
 *           eventType: Class<T>,
 *           on: EventSource? = null,
 *           componentType: Class<out Component>? = null,
 *           subscriber: EventSubscriber<T>,
 *       ): Cancellable
 *     SpatialViewContent gets it by delegation (SpatialViewContent.kt:24-28); Scene has the twin at
 *     `ecs/Scene.kt:343-352`.
 *   `ecs/event/EventSubscriber.kt:21-29`  fun interface EventSubscriber<T : Event> — a FUN
 *     interface, so a trailing lambda SAM-converts and no object expression is needed.
 *   foundation `core/lifecycle/Cancellable.kt:22-28`  interface Cancellable { fun cancel() }
 *
 * FIVE THINGS THIS ENCODES:
 *
 *  1. SUBSCRIPTIONS ARE HELD IN A LIST AND ALL CANCELLED. SpatialAudio's shape
 *     (EventManager.kt:24,41-44), not Physics' single nullable field — an app subscribing to three
 *     event types with one `Cancellable?` silently leaks two. Note PICO's own SpatialMesh sample
 *     never cancels its collision subscription at all (GameScene.kt:216-225), which is exactly the
 *     kind of thing our subscription-never-cancelled rule exists to catch. We follow the sample that
 *     gets it right, not the one that ships.
 *
 *  2. THE CONCRETE-CLASS-LITERAL IDIOM, deliberately. Physics and Animation both wrap subscribe in a
 *     generic `fun <T : Event> subscribeX(event: Class<T>)` guarded by
 *     `when (event) { CollisionEvents.Enter::class.java -> ... }`. That only compiles because
 *     Kotlin's equality-based smart cast narrows `Class<T>` to `Class<Enter>` inside the branch —
 *     delete the `when` and it stops compiling. It is a trap for a generator and buys nothing here,
 *     so we emit the direct `content.subscribe(CollisionEvents.Enter::class.java) { ... }` form.
 *
 *  3. CollisionEvents.Exit CARRIES ONLY entityA/entityB (CollisionEvents.kt:260-287). No position,
 *     no impulse, no contacts — unlike Enter and Update, which carry all six. Emitting a handler
 *     that reads `event.position` on Exit does not compile, so the per-event payloads are generated
 *     from a table rather than assumed uniform.
 *
 *  4. THE REPORTING PRECONDITION. "By default, collision events are reported only for collision
 *     pairs where at least one rigid body is dynamic. Contacts involving only kinematic/static
 *     bodies may not trigger CollisionEvents unless kinematic collision reporting is explicitly
 *     enabled" (CollisionEvents.kt:35-40, repeated at CollisionComponent.kt:161-164 and
 *     RigidBodyMode.kt:32-37). Two static colliders touching fire NOTHING, silently. The escape
 *     hatch is PhysicsWorldComponent.kinematicCollisionReportMode (PhysicsWorldComponent.kt:155),
 *     default NONE. We say so in the emitted file, because "my collision handler never fires" is
 *     otherwise unsearchable.
 *
 *  5. DETAIL LEVEL DECIDES THE PAYLOAD. CollisionInfoDetailLevel.BRIEF (the default) gives averaged
 *     position, accumulated impulse and max penetration, and NO per-contact list
 *     (CollisionInfoDetailLevel.kt:28-43). DETAILED is what populates `contacts`. A handler reading
 *     per-contact normals under BRIEF gets an empty list, not an error.
 */

const COLLISION = ["Enter", "Update", "Exit"] as const;
const ANIMATION = ["Started", "Terminated", "Paused", "Resumed", "Looped", "Completed"] as const;
const AUDIO = ["PlaybackStarted", "PlaybackPaused", "PlaybackCompleted", "PlaybackStopped", "PlaybackSeekCompleted"] as const;

type Family = "collision" | "animation" | "audio";

/** Per-event payload, from the jar. Exit is deliberately NOT the same as Enter/Update. */
function payloadLines(family: Family, event: string, indent: string): string[] {
  const i = indent;
  if (family === "collision") {
    if (event === "Exit") {
      return [
        `${i}// CollisionEvents.Exit carries ONLY entityA/entityB (CollisionEvents.kt:260-287) —`,
        `${i}// no position, impulse, penetrationDistance or contacts. Reading those does not compile.`,
        `${i}val a = event.entityA ?: return@subscribe`,
        `${i}val b = event.entityB ?: return@subscribe`,
        `${i}Log.i(TAG, "collision Exit " + a.getName() + " <-> " + b.getName())`,
        `${i}onCollisionExit?.invoke(a, b)`,
      ];
    }
    return [
      `${i}// entityA/entityB are NULLABLE (CollisionEvents.kt:59-72). position is the AVERAGED contact`,
      `${i}// point and impulse the ACCUMULATED impulse under the default BRIEF detail level;`,
      `${i}// event.contacts is EMPTY unless the CollisionComponent asked for DETAILED.`,
      `${i}val a = event.entityA ?: return@subscribe`,
      `${i}val b = event.entityB ?: return@subscribe`,
      `${i}Log.i(TAG, "collision ${event} " + a.getName() + " <-> " + b.getName() + " at " + event.position)`,
      `${i}onCollision${event}?.invoke(a, b, event.position)`,
    ];
  }
  if (family === "animation") {
    return [
      `${i}// AnimationEvents.${event} carries the playbackController (AnimationEvents.kt:61-64).`,
      `${i}Log.i(TAG, "animation ${event}")`,
      `${i}onAnimation${event}?.invoke(event.playbackController)`,
    ];
  }
  return [
    `${i}// AudioEvents.${event} carries the playbackController (AudioEvents.kt:35-38).`,
    `${i}Log.i(TAG, "audio ${event}")`,
    `${i}onAudio${event}?.invoke(event.playbackController)`,
  ];
}

export interface EventArgs {
  packageName: string;
  collision?: string[];
  animation?: string[];
  audio?: string[];
}

/** Pure generator, exported so the conformance gate can drive it without spawning the server. */
export function generateEventSubscriptionKotlin(args: EventArgs): string {
  const { packageName } = args;
  const collision = (args.collision ?? ["Enter"]).filter((e) => (COLLISION as readonly string[]).includes(e));
  const animation = (args.animation ?? []).filter((e) => (ANIMATION as readonly string[]).includes(e));
  const audio = (args.audio ?? []).filter((e) => (AUDIO as readonly string[]).includes(e));
  if (!collision.length && !animation.length && !audio.length) {
    throw new Error("pick at least one event: collision (Enter|Update|Exit), animation, or audio");
  }

  const subs: string[] = [];
  const push = (family: Family, cls: string, event: string) => {
    subs.push(
      `        // ${cls}.${event}`,
      `        subscriptions.add(`,
      `            content.subscribe(${cls}.${event}::class.java) { event ->`,
      ...payloadLines(family, event, "                "),
      `            },`,
      `        )`,
      ``,
    );
  };
  collision.forEach((e) => push("collision", "CollisionEvents", e));
  animation.forEach((e) => push("animation", "AnimationEvents", e));
  audio.forEach((e) => push("audio", "AudioEvents", e));

  const callbacks: string[] = [
    ...collision.flatMap((e) =>
      e === "Exit"
        ? [`    /** entityA, entityB. Exit carries no contact data. */`, `    var onCollisionExit: ((Entity, Entity) -> Unit)? = null`]
        : [`    /** entityA, entityB, averaged contact position (metres). */`, `    var onCollision${e}: ((Entity, Entity, Vector3) -> Unit)? = null`],
    ),
    ...animation.map((e) => `    var onAnimation${e}: ((AnimationPlaybackController) -> Unit)? = null`),
    ...audio.map((e) => `    var onAudio${e}: ((AudioPlayerController) -> Unit)? = null`),
  ];

  return [
    `package ${packageName}`,
    ``,
    `import android.util.Log`,
    `import com.pico.spatial.core.container.SpatialViewContent`,
    `import com.pico.spatial.core.ecs.Entity`,
    ...(animation.length ? [`import com.pico.spatial.core.ecs.animation.AnimationPlaybackController`] : []),
    ...(audio.length ? [`import com.pico.spatial.core.ecs.audio.AudioPlayerController`] : []),
    ...(animation.length ? [`import com.pico.spatial.core.ecs.event.AnimationEvents`] : []),
    ...(audio.length ? [`import com.pico.spatial.core.ecs.event.AudioEvents`] : []),
    ...(collision.length ? [`import com.pico.spatial.core.ecs.event.CollisionEvents`] : []),
    ...(collision.some((e) => e !== "Exit") ? [`import com.pico.spatial.core.math.Vector3`] : []),
    `import com.pico.spatial.core.lifecycle.Cancellable`,
    ``,
    `/**`,
    ` * Generated by generate_event_subscription_kotlin — the SDK event bus.`,
    ` *`,
    ` * content.subscribe(eventType, subscriber): Cancellable is ONE bus shared by physics, audio and`,
    ` * animation (SpatialViewEventManager.kt:45-52). This is how a generated app REACTS rather than`,
    ` * polls: "ball hits pin -> score" becomes a handler instead of an agent-bridge poll.`,
    ` *`,
    ` * Wire it inside SpatialView's initial block, and tear it down with the composition:`,
    ` *   initial = { content, _ ->`,
    ` *       SceneEvents.onCollisionEnter = { a, b, at -> ... }`,
    ` *       SceneEvents.subscribe(content)`,
    ` *   }`,
    ` *   // and in the hosting composable:`,
    ` *   DisposableEffect(Unit) { onDispose { SceneEvents.unsubscribeAll() } }`,
    ` *`,
    ...(collision.length
      ? [
          ` * WHY YOUR COLLISION HANDLER MIGHT NEVER FIRE — read this before debugging:`,
          ` *   "By default, collision events are reported only for collision pairs where at least one`,
          ` *    rigid body is dynamic. Contacts involving only kinematic/static bodies may not trigger`,
          ` *    CollisionEvents unless kinematic collision reporting is explicitly enabled"`,
          ` *   (CollisionEvents.kt:35-40). Two STATIC colliders touching fire NOTHING, silently. The`,
          ` *   escape hatch is PhysicsWorldComponent.kinematicCollisionReportMode (kt:155), default NONE.`,
          ` *`,
          ` * AND WHY event.contacts MIGHT BE EMPTY: CollisionInfoDetailLevel.BRIEF (the default) gives an`,
          ` * averaged position, an accumulated impulse and max penetration, but NO per-contact list`,
          ` * (CollisionInfoDetailLevel.kt:28-43). Pass DETAILED to the CollisionComponent for contacts.`,
        ]
      : []),
    ` */`,
    `object SceneEvents {`,
    `    private const val TAG = "SceneEvents"`,
    ``,
    `    // A LIST, not a single Cancellable?. Subscribing to N event types and holding one nullable`,
    `    // field silently leaks N-1 of them. This is SpatialAudio's shape (EventManager.kt:24,41-44);`,
    `    // PICO's SpatialMesh sample never cancels its collision subscription at all.`,
    `    private val subscriptions = mutableListOf<Cancellable>()`,
    ``,
    ...callbacks,
    ``,
    `    /** Subscribe every configured event. @MainThread — call from SpatialView's initial block. */`,
    `    fun subscribe(content: SpatialViewContent) {`,
    `        if (subscriptions.isNotEmpty()) {`,
    `            Log.w(TAG, "already subscribed (" + subscriptions.size + ") — unsubscribeAll() first")`,
    `            return`,
    `        }`,
    `        runCatching {`,
    ...subs,
    `            Log.i(TAG, "subscribed " + subscriptions.size + " event types")`,
    `        }.onFailure { Log.e(TAG, "subscribe failed: " + it.message) }`,
    `    }`,
    ``,
    `    /** MANDATORY paired teardown — onDispose / ON_PAUSE / onCleared. */`,
    `    fun unsubscribeAll() {`,
    `        subscriptions.forEach { runCatching { it.cancel() } }`,
    `        subscriptions.clear()`,
    `        Log.i(TAG, "unsubscribed")`,
    `    }`,
    `}`,
    ``,
  ].join("\n");
}

export function registerEventTools(server: McpServer) {
  server.registerTool(
    "generate_event_subscription_kotlin",
    {
      description:
        "Emit SceneEvents.kt — the SDK EVENT BUS (content.subscribe(eventType, subscriber): Cancellable), covering collision, animation and audio events in ONE generator because they share one bus. WHY IT EXISTS: before this, grep for CollisionEvents / content.subscribe / AudioEvents / AnimationEvents across our whole codegen returned nothing — generated apps could SIMULATE but not REACT, so 'ball hits pin -> score' had to be polled from the agent bridge instead of handled in-app. FIVE THINGS IT ENCODES, all jar-cited: (1) subscriptions are held in a LIST and all cancelled — an app subscribing to three event types with one Cancellable? silently leaks two, and PICO's own SpatialMesh sample never cancels its collision subscription at all, so we follow the sample that gets it right; (2) it emits the direct concrete-class-literal form rather than the samples' generic `when (event) { X::class.java -> }` wrapper, which only compiles thanks to Kotlin's equality-based smart cast and is a trap for a generator; (3) CollisionEvents.Exit carries ONLY entityA/entityB — no position, impulse or contacts, unlike Enter/Update — so payload handling is generated per event rather than assumed uniform; (4) THE REPORTING PRECONDITION: collision events fire only when at least one body is DYNAMIC, so two static colliders touching fire nothing silently, and the escape hatch is PhysicsWorldComponent.kinematicCollisionReportMode (default NONE) — stated in the emitted file because 'my handler never fires' is otherwise unsearchable; (5) event.contacts is EMPTY under the default BRIEF detail level, which gives averaged position and accumulated impulse only — DETAILED is what populates per-contact data. HONEST STATUS: structural — jar-cited and sample-shaped; capture evidence before claiming a handler fired on device.",
      inputSchema: {
        packageName: z.string().describe("Kotlin package for the emitted file, e.g. com.example.app.content"),
        collision: z.array(z.enum(COLLISION)).optional().describe("Collision events to subscribe. Enter = first contact, Update = every frame while in contact, Exit = separation (entityA/entityB ONLY). Default ['Enter']."),
        animation: z.array(z.enum(ANIMATION)).optional().describe("Animation playback events; each carries the AnimationPlaybackController."),
        audio: z.array(z.enum(AUDIO)).optional().describe("Audio playback events; each carries the AudioPlayerController."),
      },
    },
    async ({ packageName, collision, animation, audio }) => {
      try {
        return ok(generateEventSubscriptionKotlin({ packageName, collision, animation, audio }));
      } catch (e: any) {
        return fail(String(e?.message ?? e));
      }
    },
  );
}
