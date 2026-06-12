# PICO Spatial SDK — Interactive API reference (decompiled)

Reverse-engineered from the PICO Spatial SDK 0.13.3 AARs to enable interactive spatial apps (live controller-ray placement, selection, anchoring). All signatures are from javap; Kotlin call syntax may differ slightly (properties vs getters). Flagged uncertainties are real.

## controller

### `com.pico.spatial.tracking.controller.ControllerTrackingProvider`
Entry point for controller tracking. Implements DataProvider<ControllerTrackingData> (delegates to an inner BaseTrackingDataProvider via $$delegate_0). You construct it, call start() (returns StartResult), then consume poses via getLatestData()/getDataFlow()/addListener(...). ALSO uniquely exposes addControllerActionListener / removeControllerActionListener for discrete button/trigger events (button events are NOT in the pose flow). Internally an actionCallback ($actionCallback$1, a foundation ControllerActionCallback) fan-outs to a CopyOnWriteArrayList of registered ControllerActionListeners. Call stop() and getState()/getSupportState() for lifecycle.

```
public ControllerTrackingProvider()
public com.pico.spatial.tracking.DataProvider$StartResult start()
public void stop()
public void addListener(com.pico.spatial.tracking.DataProvider$DataListener<com.pico.spatial.tracking.controller.ControllerTrackingData>)
public void removeListener(com.pico.spatial.tracking.DataProvider$DataListener<com.pico.spatial.tracking.controller.ControllerTrackingData>)
public com.pico.spatial.tracking.DataProvider$State getState()
public com.pico.spatial.tracking.DataProvider$SupportState getSupportState()
public com.pico.spatial.tracking.controller.ControllerTrackingData getLatestData()
public kotlinx.coroutines.flow.SharedFlow<com.pico.spatial.tracking.controller.ControllerTrackingData> getDataFlow()
public final void addControllerActionListener(com.pico.spatial.tracking.controller.ControllerTrackingProvider$ControllerActionListener)
public final void removeControllerActionListener(com.pico.spatial.tracking.controller.ControllerTrackingProvider$ControllerActionListener)
```

### `com.pico.spatial.tracking.controller.ControllerTrackingProvider$ControllerActionListener`
Functional interface (single abstract method) you implement and register via addControllerActionListener to receive discrete button/trigger/grip/thumbstick events. onControllerAction is called with a ControllerActionData carrying both controllers' current ControllerAction snapshot. This is where you detect 'right-trigger pressed' to fire pin placement.

```
public abstract void onControllerAction(com.pico.spatial.tracking.controller.ControllerActionData)
```

### `com.pico.spatial.tracking.controller.ControllerActionData`
Container delivered to onControllerAction. Holds the left and right ControllerAction snapshots — THIS is how you tell left vs right controller for button input: getLeft() vs getRight(). Has a secondary constructor wrapping the foundation-layer ControllerActionData.

```
public final com.pico.spatial.tracking.controller.ControllerAction getLeft()
public final com.pico.spatial.tracking.controller.ControllerAction getRight()
public ControllerActionData(com.pico.spatial.tracking.controller.ControllerAction left, com.pico.spatial.tracking.controller.ControllerAction right)
public ControllerActionData(com.pico.spatial.foundation.extensions.tracking.ControllerActionData)
public boolean equals(java.lang.Object)
public int hashCode()
public java.lang.String toString()
```

### `com.pico.spatial.tracking.controller.ControllerAction`
Immutable data class = full button/axis snapshot for ONE controller (NOT an enum). Exposes every exposed button/axis: X/Y/A/B face buttons (pressed + touched booleans), trigger (pressed bool, touched bool, analog value float 0..1), grip (pressed bool, analog value float), thumbstick (pressed bool, touched bool, ThumbstickValue x/y). For pin placement, detect a press edge on getTriggerPressed() (or threshold getTriggerValue()). Note: which physical buttons exist is identical left/right here; X/Y are conventionally the left controller's face buttons and A/B the right's, but this class carries all four fields regardless — disambiguate hands via ControllerActionData.getLeft()/getRight(), not the field names.

```
public final boolean getXButtonPressed()
public final boolean getXButtonTouched()
public final boolean getYButtonPressed()
public final boolean getYButtonTouched()
public final boolean getAButtonPressed()
public final boolean getAButtonTouched()
public final boolean getBButtonPressed()
public final boolean getBButtonTouched()
public final boolean getTriggerPressed()
public final boolean getTriggerTouched()
public final float getTriggerValue()
public final boolean getGripPressed()
public final float getGripValue()
public final boolean getThumbstickPressed()
public final boolean getThumbstickTouched()
public final com.pico.spatial.tracking.controller.ThumbstickValue getThumbstickValue()
public ControllerAction(boolean xButtonPressed, boolean xButtonTouched, boolean yButtonPressed, boolean yButtonTouched, boolean aButtonPressed, boolean aButtonTouched, boolean bButtonPressed, boolean bButtonTouched, boolean triggerPressed, boolean triggerTouched, float triggerValue, boolean gripPressed, float gripValue, boolean thumbstickPressed, boolean thumbstickTouched, com.pico.spatial.tracking.controller.ThumbstickValue thumbstickValue)
public ControllerAction(com.pico.spatial.foundation.extensions.tracking.ControllerAction)
```

### `com.pico.spatial.tracking.controller.ControllerTrackingData`
The pose payload delivered by the pose flow / DataListener / getLatestData(). Holds left and right ControllerPose plus a timestamp (timestamp getter is internal to tracking_release). THIS is how you tell left vs right controller for POSE/ray: getLeft() vs getRight(). For right-controller ray, use getRight().

```
public final com.pico.spatial.tracking.controller.ControllerPose getLeft()
public final com.pico.spatial.tracking.controller.ControllerPose getRight()
public final long getTimestamp$tracking_release()
public ControllerTrackingData(com.pico.spatial.tracking.controller.ControllerPose left, com.pico.spatial.tracking.controller.ControllerPose right, long timestamp)
public ControllerTrackingData(com.pico.spatial.foundation.extensions.tracking.ControllerTrackingData)
public boolean equals(java.lang.Object)
public int hashCode()
public java.lang.String toString()
```

### `com.pico.spatial.tracking.controller.ControllerPose`
Pose of one controller = position (Vector3, world meters) + rotation (Quat). This IS the ray: origin = getPosition(), direction = getRotation().rotateVector(Vector3.FORWARD). (Vector3.FORWARD assumed -Z forward per the named constant; confirm handedness against an actual pose if precise aim matters.)

```
public final com.pico.spatial.core.math.Vector3 getPosition()
public final com.pico.spatial.core.math.Quat getRotation()
public ControllerPose(com.pico.spatial.core.math.Vector3 position, com.pico.spatial.core.math.Quat rotation)
public ControllerPose(com.pico.spatial.foundation.extensions.tracking.ControllerPose)
public boolean equals(java.lang.Object)
public int hashCode()
public java.lang.String toString()
```

### `com.pico.spatial.tracking.controller.ThumbstickValue`
2D thumbstick axis value, x/y floats (conventionally -1..1). Returned by ControllerAction.getThumbstickValue(). Not needed for trigger-press pin placement; useful for scroll/adjust gestures.

```
public final float getX()
public final float getY()
public ThumbstickValue(float x, float y)
public ThumbstickValue(com.pico.spatial.foundation.extensions.tracking.ThumbstickValue)
public boolean equals(java.lang.Object)
public int hashCode()
public java.lang.String toString()
```

### `com.pico.spatial.tracking.DataProvider`
Generic provider interface implemented by ControllerTrackingProvider (and HMD/hand/eye/body/motion providers). Defines the common lifecycle + data access surface: start/stop, state, support state, latest data, a Kotlin SharedFlow, and add/removeListener. T = ControllerTrackingData for controllers.

```
public abstract com.pico.spatial.tracking.DataProvider$State getState()
public abstract com.pico.spatial.tracking.DataProvider$SupportState getSupportState()
public abstract T getLatestData()
public abstract kotlinx.coroutines.flow.SharedFlow<T> getDataFlow()
public abstract com.pico.spatial.tracking.DataProvider$StartResult start()
public abstract void stop()
public abstract void addListener(com.pico.spatial.tracking.DataProvider$DataListener<T>)
public abstract void removeListener(com.pico.spatial.tracking.DataProvider$DataListener<T>)
```

### `com.pico.spatial.tracking.DataProvider$DataListener`
Per-frame pose push callback (SAM interface). Register via provider.addListener(...) to get ControllerTrackingData on every update — the streaming alternative to polling getLatestData(). Use this to keep a live ray that follows the controller before the trigger fires (e.g. drawing the aim line).

```
public abstract void onProvideData(T)
```

### `com.pico.spatial.tracking.DataProvider$State`
Enum of provider lifecycle state returned by getState(): CREATED, STARTED, STOPPED, PENDING, UNKNOWN. Each has an int getValue().

```
public static final ...State CREATED
public static final ...State STARTED
public static final ...State STOPPED
public static final ...State PENDING
public static final ...State UNKNOWN
public final int getValue()
public static ...State[] values()
public static ...State valueOf(java.lang.String)
```

### `com.pico.spatial.tracking.DataProvider$StartResult`
Enum returned by start(): SUCCESS or PENDING (PENDING = start in progress, e.g. awaiting permission/space; poll getState()/getSupportState()).

```
public static final ...StartResult SUCCESS
public static final ...StartResult PENDING
public static ...StartResult[] values()
public static ...StartResult valueOf(java.lang.String)
```

### `com.pico.spatial.tracking.DataProvider$SupportState`
Enum from getSupportState() gating availability: NONE, SUPPORTED, DEVICE_NOT_SUPPORTED, NOT_IN_FULL_SPACE, WITHOUT_PERMISSION, UNKNOWN. Check == SUPPORTED before relying on data; NOT_IN_FULL_SPACE / WITHOUT_PERMISSION tell you why tracking is unavailable. Each has int getValue().

```
public static final ...SupportState NONE
public static final ...SupportState SUPPORTED
public static final ...SupportState DEVICE_NOT_SUPPORTED
public static final ...SupportState NOT_IN_FULL_SPACE
public static final ...SupportState WITHOUT_PERMISSION
public static final ...SupportState UNKNOWN
public final int getValue()
public static ...SupportState[] values()
public static ...SupportState valueOf(java.lang.String)
```

### `com.pico.spatial.tracking.hmd.HMDPose`
Head pose = position (Vector3) + rotation (Quat). Same shape as ControllerPose. Useful for head-relative placement or fallback gaze ray; not required for controller-ray placement.

```
public final com.pico.spatial.core.math.Vector3 getPosition()
public final com.pico.spatial.core.math.Quat getRotation()
public HMDPose(com.pico.spatial.core.math.Vector3 position, com.pico.spatial.core.math.Quat rotation)
public HMDPose(com.pico.spatial.foundation.extensions.tracking.HMDPose)
```

### `com.pico.spatial.tracking.hmd.HMDTrackingData`
Head tracking payload from HMDTrackingProvider: single HMDPose + timestamp (timestamp internal to tracking_release).

```
public final com.pico.spatial.tracking.hmd.HMDPose getHmdPose()
public final long getTimestamp$tracking_release()
public HMDTrackingData(com.pico.spatial.tracking.hmd.HMDPose hmdPose, long timestamp)
public HMDTrackingData(com.pico.spatial.foundation.extensions.tracking.HMDTrackingData)
```

### `com.pico.spatial.tracking.hmd.HMDTrackingProvider`
DataProvider<HMDTrackingData> for head pose. Same lifecycle/data-access surface as ControllerTrackingProvider, minus the action listener. Construct, start(), then getLatestData()/getDataFlow()/addListener.

```
public HMDTrackingProvider()
public com.pico.spatial.tracking.DataProvider$StartResult start()
public void stop()
public void addListener(...DataListener<HMDTrackingData>)
public void removeListener(...DataListener<HMDTrackingData>)
public com.pico.spatial.tracking.DataProvider$State getState()
public com.pico.spatial.tracking.DataProvider$SupportState getSupportState()
public com.pico.spatial.tracking.hmd.HMDTrackingData getLatestData()
public kotlinx.coroutines.flow.SharedFlow<HMDTrackingData> getDataFlow()
```

### `com.pico.spatial.core.math.Vector3`
3D vector (x,y,z floats) used for pose positions and ray directions. Provides direction constants (ZERO, ONE, UP, DOWN, FORWARD, BACK, RIGHT, LEFT), operators (plus/minus/times/div), normalize/length, and static geometry helpers cross/dot/angle/reflect/project/distance — needed to build a ray, march along it (position + dir*t), and to derive a pin orientation from a hit normal (e.g. cross(UP, normal), angle(UP, normal)). Located in the FOUNDATION jar, not core.

```
public Vector3(float x, float y, float z)
public Vector3(float)
public Vector3(com.pico.spatial.core.math.Vector3)
public static final com.pico.spatial.core.math.Vector3 FORWARD
public static final com.pico.spatial.core.math.Vector3 UP
public static final com.pico.spatial.core.math.Vector3 RIGHT
public final float getX()
public final float getY()
public final float getZ()
public final float length()
public final com.pico.spatial.core.math.Vector3 normalize()
public final com.pico.spatial.core.math.Vector3 plus(Vector3)
public final com.pico.spatial.core.math.Vector3 minus(Vector3)
public final com.pico.spatial.core.math.Vector3 times(float)
public static final float dot(Vector3, Vector3)
public static final com.pico.spatial.core.math.Vector3 cross(Vector3, Vector3)
public static final float angle(Vector3, Vector3)
public static final float distance(Vector3, Vector3)
```

### `com.pico.spatial.core.math.Quat`
Quaternion (x,y,z,w) for orientations. KEY for the ray: rotateVector(dir) rotates a local axis (e.g. Vector3.FORWARD) into world space to get the aim direction from a controller's rotation. Constructors include axis-angle Quat(Vector3 axis, float angleDeg) and identity()/Quat(). For orienting a pin to a hit normal there is NO lookRotation/fromToRotation factory — you must build the rotation yourself via axis-angle (axis = cross(UP, normal), angle = angle(UP, normal)) or interpolate with slerp. Located in the FOUNDATION jar, not core.

```
public Quat(float x, float y, float z, float w)
public Quat()
public Quat(com.pico.spatial.core.math.Vector3 axis, float angle)
public static final com.pico.spatial.core.math.Quat identity()
public final com.pico.spatial.core.math.Vector3 rotateVector(com.pico.spatial.core.math.Vector3)
public final com.pico.spatial.core.math.Quat times(com.pico.spatial.core.math.Quat)
public final com.pico.spatial.core.math.Quat normalize()
public final com.pico.spatial.core.math.Quat conjugate()
public final com.pico.spatial.core.math.EulerAngles toEulerAngles()
public final com.pico.spatial.core.math.Matrix4 toMatrix()
public final kotlin.Pair<java.lang.Float, com.pico.spatial.core.math.Vector3> toAngleAxis()
public static final com.pico.spatial.core.math.Quat slerp(Quat, Quat, float)
```

**Uncertainties:** Vector3.FORWARD's handedness/sign (-Z vs +Z) is inferred from the constant name, not verified. If aim is mirrored or reversed, try Vector3.BACK or check rotateVector output against a known controller orientation. The same applies to UP/RIGHT used when deriving pin orientation from the hit normal.; getTriggerPressed() is the SDK's notion of a digital press; the exact analog threshold it uses is not visible from signatures. For custom sensitivity use getTriggerValue() (assumed 0..1) with your own threshold.; ThumbstickValue x/y range (assumed -1..1) and ControllerAction.getGripValue() range (assumed 0..1) are not provable from signatures.; The ControllerActionListener fires on every action update (the inner foundation ControllerActionCallback fans out to all registered listeners); whether it is invoked only on change or continuously per frame is not determinable from javap — code defensively with edge detection (shown in recipe).; ControllerTrackingData.timestamp and HMDTrackingData.timestamp use an internal getter (getTimestamp$tracking_release) and are effectively not part of the public Java/Kotlin API from outside the tracking module; clock domain/units unknown.; Raycasting against surfaces and anchor persistence are NOT in this (tracking) subsystem — the recipe stubs them. They live in the scene/anchor modules (likely 'sense'/core), which another subagent should document.; Quat has no lookRotation/fromToRotation/euler factory on its Companion; orienting a pin to a hit normal must be built via axis-angle Quat(axis, angleDeg) or slerp. The angle unit for Quat(Vector3 axis, float angle) and Vector3.angle(...) is assumed degrees (common in this Unity-like API) but not proven.; ControllerTrackingProvider exposes only controller data; there is no visible API here to query controller connectivity/handedness presence (e.g., is the left controller turned on) beyond pose validity — a disconnected controller's pose contents are unspecified by these signatures.

## raycast

### `com.pico.spatial.core.ecs.Scene`
THE raycast entry point. rayCast() casts a ray (origin + normalized direction, up to maxDistance) into the scene's physics world and returns hits. convexCast() sweeps a ShapeResource along a direction. Scene also owns entities (queryEntity, getAllEntities) and event subscription. A Scene is obtained per spatial container via AppScene.retrieveAppForm$...(container) (internal) or is the Scene returned by Entity.getScene().

```
public final com.pico.spatial.core.ecs.simulation.CollisionCastHitResults rayCast(com.pico.spatial.core.math.Vector3 origin, com.pico.spatial.core.math.Vector3 direction, float maxDistance, com.pico.spatial.core.ecs.simulation.CollisionCastHitMode hitMode, com.pico.spatial.core.ecs.simulation.CollisionGroup group, com.pico.spatial.core.ecs.Entity ignoreEntity)
// rayCast$default: only the LAST param (ignoreEntity, mask bit 32) is optional/defaults to null; origin, direction, maxDistance, hitMode, group are all REQUIRED (verified via bytecode of rayCast$default and Intrinsics.checkNotNullParameter on origin/direction/hitMode/group)
public final com.pico.spatial.core.ecs.simulation.CollisionCastHitResults convexCast(com.pico.spatial.core.ecs.resource.ShapeResource shape, com.pico.spatial.core.math.Vector3 origin, com.pico.spatial.core.math.Quat rotation, com.pico.spatial.core.math.Vector3 direction, float maxDistance, com.pico.spatial.core.ecs.simulation.CollisionCastHitMode hitMode, com.pico.spatial.core.ecs.simulation.CollisionGroup group, com.pico.spatial.core.ecs.Entity ignoreEntity)
public final java.util.List<com.pico.spatial.core.ecs.Entity> queryEntity(com.pico.spatial.core.ecs.EntityQueryCondition...)
public final <T extends com.pico.spatial.core.ecs.event.Event> com.pico.spatial.core.lifecycle.Cancellable subscribe(java.lang.Class<T>, com.pico.spatial.core.ecs.EventSource, java.lang.Class<? extends com.pico.spatial.core.ecs.Component>, com.pico.spatial.core.ecs.event.EventSubscriber<T>)
public com.pico.spatial.core.ecs.Scene(com.pico.spatial.core.container.SpatialContainerType, java.lang.String, int)
```

### `com.pico.spatial.core.ecs.simulation.CollisionCastHitResults`
Return value of Scene.rayCast / convexCast. Thin immutable wrapper around the ordered list of hits. With CollisionCastHitMode.NEAREST the list has at most one element (the closest); with ALL it contains all hits along the ray.

```
public CollisionCastHitResults(java.util.List<com.pico.spatial.core.ecs.simulation.CollisionCastResult> results)
public final java.util.List<com.pico.spatial.core.ecs.simulation.CollisionCastResult> getResults()
```

### `com.pico.spatial.core.ecs.simulation.CollisionCastResult`
A single raycast hit. THIS is the {hitPoint, hitNormal, hitEntity} the task asked for: getPosition()=world-space hit point, getNormal()=surface normal (orient the pin to this), getEntity()=entity that was hit, getDistance()=distance along the ray. uv0/uv1 give the surface texture coordinates at the hit; materialIndex/shapeIndex identify which sub-shape/material was struck. All fields are immutable (val).

```
public CollisionCastResult(com.pico.spatial.core.ecs.Entity entity, int shapeIndex, com.pico.spatial.core.math.Vector3 position, com.pico.spatial.core.math.Vector3 normal, float distance, com.pico.spatial.core.math.Vector2 uv0, com.pico.spatial.core.math.Vector2 uv1, int materialIndex)
public final com.pico.spatial.core.ecs.Entity getEntity()
public final int getShapeIndex()
public final com.pico.spatial.core.math.Vector3 getPosition()  // hit point (world space)
public final com.pico.spatial.core.math.Vector3 getNormal()    // surface normal -> orients the pin
public final float getDistance()
public final com.pico.spatial.core.math.Vector2 getUv0()
public final com.pico.spatial.core.math.Vector2 getUv1()
public final int getMaterialIndex()
```

### `com.pico.spatial.core.ecs.simulation.CollisionCastHitMode`
Enum selecting how many hits rayCast/convexCast return. NEAREST = closest single hit (what you want for pin placement). ALL = every collider crossed by the ray.

```
public static final CollisionCastHitMode NEAREST
public static final CollisionCastHitMode ALL
```

### `com.pico.spatial.core.ecs.simulation.CollisionGroup`
Inline value class (wraps an int bitmask) selecting which collision groups the ray tests against. Use the constants for a 'hit everything' raycast. Note the getter is name-mangled (getValue-pVg5ArA) because it is a Kotlin value class; from Kotlin just reference the constants directly.

```
public static final CollisionGroup$Companion Companion
public static final int COLLISION_GROUP_DEFAULT
public static final int COLLISION_GROUP_ALL
public final int getValue-pVg5ArA()
```

### `com.pico.spatial.core.ecs.CollisionComponent`
The collider component. Attach this to any entity you want the ray to be able to hit. Holds a list of ShapeResource colliders, a PhysicsMaterialResource, a CollisionResponseMode (TRIGGER_FULL/TRIGGER_LITE/COLLIDER_FULL), a CollisionFilter (group+mask), and a CollisionInfoDetailLevel (BRIEF/DETAILED). Without a CollisionComponent on an entity, rayCast will not report it.

```
public CollisionComponent()
public CollisionComponent(java.util.List<com.pico.spatial.core.ecs.resource.ShapeResource> collisionShapes, com.pico.spatial.core.ecs.resource.PhysicsMaterialResource physicsMaterial, com.pico.spatial.core.ecs.simulation.CollisionResponseMode responseMode, com.pico.spatial.core.ecs.simulation.CollisionFilter filter, com.pico.spatial.core.ecs.simulation.CollisionInfoDetailLevel detailLevel)
public final java.util.List<com.pico.spatial.core.ecs.resource.ShapeResource> getCollisionShape()
public final void setCollisionShape(java.util.List<com.pico.spatial.core.ecs.resource.ShapeResource>)
public final com.pico.spatial.core.ecs.simulation.CollisionResponseMode getCollisionResponseMode()
public final void setCollisionResponseMode(com.pico.spatial.core.ecs.simulation.CollisionResponseMode)
public final com.pico.spatial.core.ecs.simulation.CollisionFilter getCollisionFilter()
public final void setCollisionFilter(com.pico.spatial.core.ecs.simulation.CollisionFilter)
public final com.pico.spatial.core.ecs.resource.PhysicsMaterialResource getPhysicsMaterial()
public final void setPhysicsMaterial(com.pico.spatial.core.ecs.resource.PhysicsMaterialResource)
public final com.pico.spatial.core.ecs.simulation.CollisionInfoDetailLevel getCollisionInfoDetailLevel()
public final void setCollisionInfoDetailLevel(com.pico.spatial.core.ecs.simulation.CollisionInfoDetailLevel)
```

### `com.pico.spatial.core.ecs.simulation.CollisionFilter`
Group+mask pair controlling which colliders interact. COLLISION_FILTER_DEFAULT / COLLISION_FILTER_ALL constants for the common cases. Used in CollisionComponent (per-entity); note rayCast takes a single CollisionGroup, not a CollisionFilter.

```
public static final CollisionFilter COLLISION_FILTER_DEFAULT
public static final CollisionFilter COLLISION_FILTER_ALL
public CollisionFilter(com.pico.spatial.core.ecs.simulation.CollisionGroup group, com.pico.spatial.core.ecs.simulation.CollisionGroup mask)
public CollisionFilter()
public final com.pico.spatial.core.ecs.simulation.CollisionGroup getGroup()
public final com.pico.spatial.core.ecs.simulation.CollisionGroup getMask()
```

### `com.pico.spatial.core.ecs.resource.ShapeResource`
A collider shape resource. Add one (or several) to a CollisionComponent so the entity is raycastable. Factory methods on the Companion build primitive or mesh colliders; offsetBy* return a shifted/rotated copy. Implements Closeable (close() to free native resource). For raycasting a real surface (e.g. a scanned wall/desk) you typically use createStaticMesh(MeshResource).

```
public static final ShapeResource createBox(com.pico.spatial.core.math.Vector3 halfExtents)
public static final ShapeResource createSphere(float radius)
public static final ShapeResource createCapsule(float radius, float height)
public static final ShapeResource createConvexMesh(com.pico.spatial.core.ecs.resource.MeshResource)
public static final ShapeResource createStaticMesh(com.pico.spatial.core.ecs.resource.MeshResource)
public final ShapeResource offsetByTranslation(com.pico.spatial.core.math.Vector3)
public final ShapeResource offsetByRotation(com.pico.spatial.core.math.Quat)
public final ShapeResource offsetByTranslationAndRotation(com.pico.spatial.core.math.Quat, com.pico.spatial.core.math.Vector3)
public ShapeResource(long handle)
```

### `com.pico.spatial.core.ecs.TransformComponent`
Position + rotation + scale of an entity. To DROP THE PIN: create an Entity, attach a TransformComponent whose position = CollisionCastResult.getPosition() and quaternion = rotation that aligns the pin's up-axis to CollisionCastResult.getNormal(). Rotation can be set as Quat (setQuaternion) or EulerAngles (setEulerAngles).

```
public TransformComponent()
public TransformComponent(com.pico.spatial.core.math.Transform)
public TransformComponent(com.pico.spatial.core.math.Vector3 position, com.pico.spatial.core.math.Quat rotation, com.pico.spatial.core.math.Vector3 scale)
public TransformComponent(com.pico.spatial.core.math.Vector3 position, com.pico.spatial.core.math.EulerAngles rotation, com.pico.spatial.core.math.Vector3 scale)
public final com.pico.spatial.core.math.Vector3 getPosition()
public final void setPosition(com.pico.spatial.core.math.Vector3)
public final com.pico.spatial.core.math.Quat getQuaternion()
public final void setQuaternion(com.pico.spatial.core.math.Quat)
public final com.pico.spatial.core.math.EulerAngles getEulerAngles()
public final void setEulerAngles(com.pico.spatial.core.math.EulerAngles)
```

### `com.pico.spatial.core.ecs.Entity`
ECS entity. getComponents() returns a ComponentSet you use to add/get/has components. getScene() returns the Scene the entity lives in (a handle you can call rayCast on). new Entity() makes an empty entity to use as the pin. Entity.Companion.load(...) loads a model (e.g. a pin glb).

```
public Entity()
public Entity(boolean)
public final com.pico.spatial.core.ecs.Scene getScene()
public final com.pico.spatial.core.ecs.Entity$ComponentSet getComponents()
public final java.lang.String getName()
// Companion: public final Entity load(String path) ; load(File) ; load(ContentResolver, Uri) ; loadSuspend(...) variants
```

### `com.pico.spatial.core.ecs.Entity$ComponentSet`
Typed component container on an Entity. Generic get/set/has/remove by Class. Use set(component) to attach a TransformComponent / CollisionComponent, get(Class) to read one back. Implements Collection<Component>.

```
public final <T extends com.pico.spatial.core.ecs.Component> T get(java.lang.Class<T>)
public final <T extends com.pico.spatial.core.ecs.Component> void set(java.lang.Class<T>, T)
public final <T extends com.pico.spatial.core.ecs.Component> void set(T)
public final void set(java.util.List<? extends com.pico.spatial.core.ecs.Component>)
public final <T extends com.pico.spatial.core.ecs.Component> boolean has(java.lang.Class<T>)
public final void remove(java.lang.Class<? extends com.pico.spatial.core.ecs.Component>)
public int getSize()
```

### `com.pico.spatial.core.math.Vector3`
3-float vector used for origin/direction/position/normal. Has the vector math needed to orient to a normal: cross, dot, angle, normalize, plus/minus/times. Constants UP/DOWN/FORWARD/etc. NOTE: this class lives in the FOUNDATION jar (com.pico.spatial.core.math), not the core jar, despite the package name.

```
public Vector3(float x, float y, float z)
public Vector3(float)
public static final Vector3 ZERO, ONE, UP, DOWN, FORWARD, BACK, RIGHT, LEFT
public static final float dot(Vector3, Vector3)
public static final Vector3 cross(Vector3, Vector3)
public static final float angle(Vector3, Vector3)
public final Vector3 normalize()
public final float length()
public final Vector3 plus(Vector3) / minus(Vector3) / times(float) / div(float)
public final float getX() / getY() / getZ()
```

### `com.pico.spatial.core.math.Quat`
Quaternion for the pin's orientation. Construct from axis+angle: Quat(Vector3 axis, float angleRadians). There is NO lookRotation/fromToRotation helper; to align an up-axis to the hit normal compute axis = cross(refUp, normal), angle = acos(dot(refUp, normal)) and build Quat(axis.normalize(), angle), or convert via EulerAngles. rotateVector() applies the rotation. Lives in the FOUNDATION jar.

```
public Quat(float x, float y, float z, float w)
public Quat(com.pico.spatial.core.math.Vector3 axis, float angle)  // axis-angle ctor
public Quat()  // identity
public static final Quat identity()
public static final Quat slerp(Quat, Quat, float)
public final com.pico.spatial.core.math.Vector3 rotateVector(com.pico.spatial.core.math.Vector3)
public final com.pico.spatial.core.math.EulerAngles toEulerAngles()
public final kotlin.Pair<java.lang.Float, com.pico.spatial.core.math.Vector3> toAngleAxis()
public final Quat normalize() / conjugate()
// NO lookRotation / fromToRotation factory present
```

### `com.pico.spatial.core.ecs.PhysicsWorldComponent`
Configures the physics simulation for a scene/world entity: gravity, kinematic collision report mode, solver iterations, simulation clock. NOT needed to raycast (rayCast works against colliders regardless), but required if you want pins to be dynamic rigid bodies or want CollisionEvents to fire.

```
public PhysicsWorldComponent()
public PhysicsWorldComponent(com.pico.spatial.core.math.Vector3 gravity, com.pico.spatial.core.ecs.simulation.KinematicCollisionReportMode, com.pico.spatial.core.ecs.simulation.SolverIterations, com.pico.spatial.core.ecs.simulation.SimulationClock)
public final com.pico.spatial.core.math.Vector3 getGravity()
public final void setGravity(com.pico.spatial.core.math.Vector3)
public final com.pico.spatial.core.ecs.simulation.KinematicCollisionReportMode getKinematicCollisionReportMode()
public final com.pico.spatial.core.ecs.simulation.SolverIterations getSolverIterations()
public final com.pico.spatial.core.ecs.simulation.SimulationClock getSimulationClock()
```

### `com.pico.spatial.core.ecs.PhysicsForceComponent`
Applies a continuous force + torque to a rigid-body entity. Dynamics only; irrelevant to raycast pin placement unless you want the pin to be pushed.

```
public PhysicsForceComponent(com.pico.spatial.core.math.Vector3 force, com.pico.spatial.core.math.Vector3 torque)
public final com.pico.spatial.core.math.Vector3 getForce()
public final void setForce(com.pico.spatial.core.math.Vector3)
public final com.pico.spatial.core.math.Vector3 getTorque()
public final void setTorque(com.pico.spatial.core.math.Vector3)
```

### `com.pico.spatial.core.ecs.PhysicsVelocityComponent`
Sets/reads linear + angular velocity of a rigid-body entity. Dynamics only; not used for raycast pin placement.

```
public PhysicsVelocityComponent(com.pico.spatial.core.math.Vector3 linearVelocity, com.pico.spatial.core.math.Vector3 angularVelocity)
public final com.pico.spatial.core.math.Vector3 getLinearVelocity()
public final void setLinearVelocity(com.pico.spatial.core.math.Vector3)
public final com.pico.spatial.core.math.Vector3 getAngularVelocity()
public final void setAngularVelocity(com.pico.spatial.core.math.Vector3)
```

### `com.pico.spatial.core.ecs.resource.PhysicsMaterialResource`
Friction/restitution material for a collider, referenced by CollisionComponent. Construct with (staticFriction, dynamicFriction, restitution). Closeable native resource. Does not affect raycast geometry; only contact dynamics.

```
public PhysicsMaterialResource(float staticFriction, float dynamicFriction, float restitution)
public final float getStaticFriction() / getDynamicFriction() / getRestitution()
public final void setStaticFriction(float) / setDynamicFriction(float) / setRestitution(float)
public void close()
```

### `com.pico.spatial.core.ecs.simulation.CollisionContact`
A single contact point reported in CollisionEvents (Enter/Update). Holds position, normal, impulse, penetrationDistance. Relevant only to physics collision events, not to raycast results (raycast returns CollisionCastResult instead).

```
public CollisionContact(com.pico.spatial.core.math.Vector3 position, com.pico.spatial.core.math.Vector3 normal, com.pico.spatial.core.math.Vector3 impulse, float penetrationDistance)
public final com.pico.spatial.core.math.Vector3 getPosition() / getNormal() / getImpulse()
public final float getPenetrationDistance()
```

**Uncertainties:** Vector3, Quat, EulerAngles, Vector2, Transform are NOT in core/classes.jar; they resolve from foundation/classes.jar under package com.pico.spatial.core.math. I javap'd them from /tmp/pico-sdk/foundation/x. They are the same types referenced by Scene.rayCast.; CollisionGroup is a Kotlin inline value class (getter mangled as getValue-pVg5ArA). From Kotlin you pass a CollisionGroup; the int constants COLLISION_GROUP_DEFAULT / COLLISION_GROUP_ALL are the intended arguments. The exact public Kotlin constructor/factory for wrapping a raw int is obscured by R8 (only synthetic ctors with DefaultConstructorMarker survive in javap); the Companion likely exposes a builder. Treat the constructor call in the recipe as illustrative.; rayCast's 'direction' semantics: confirmed via bytecode it is passed straight to the foundation Scene.rayCast as a Vector3; whether it must be normalized or whether maxDistance scales the direction is not provable from signatures — I assumed a normalized direction + separate maxDistance (standard). Normalize to be safe.; There is NO Quat.lookRotation / fromToRotation / fromAxes helper in the SDK (verified on Quat and Quat$Companion). Orienting the pin to the hit normal must be done manually (axis-angle from cross/dot, as shown) or via EulerAngles. This is a real gap, not an oversight in my search.; How to OBTAIN the active Scene from app-facing code: Scene is reachable via Entity.getScene(); the AppScene retrieve*AppForm* methods are marked $spatialsdk_core_core (internal). The public/app entry that yields the first Scene (activity/spatial-view bootstrap) lives outside this subsystem (container / app lifecycle classes).; Adding the pin Entity to the Scene and parenting: Scene exposes only internal addEntity$spatialsdk_core_core(Entity, boolean). The public mechanism to register a freshly-created Entity (likely automatic on attaching components within a managed spatial view, or a higher-level helper) is part of the ECS/Scene subsystem, not the raycast subsystem.; Persistence/anchoring of the placed pin is NOT in this core raycast subsystem — no anchor API appeared among cast/physics/collision classes. It belongs to the tracking/sense module (spatial anchors).; convexCast is the swept-shape analog of rayCast (same hit-result type); useful for thicker 'pin tip' tests but not required. Its rotation/direction parameter semantics weren't deeply verified beyond the signature.

## interaction

### `com.pico.spatial.core.ecs.InteractableComponent`
Marker component. Adding it to an entity makes that entity interactable (selectable/hittable by controller rays). It carries NO public click/select callback and NO public state -- its only role is to call pushComponent() on the native adapter (confirmed in bytecode: getAdapter().pushComponent()). There is no onClick/onSelect setter here. Selection feedback must come from elsewhere (collision events on a CollisionComponent, or the app's own controller-ray raycast loop). extends com.pico.spatial.core.ecs.Component.

```
public com.pico.spatial.core.ecs.InteractableComponent()  // no-arg ctor; just add it to an entity
public com.pico.spatial.core.ecs.Component clone()
public final com.pico.spatial.foundation.extensions.spatial.ecs.InteractableComponent getAdapter$spatialsdk_core_core()  // internal; not usable from app code
public boolean equals(java.lang.Object)
public int hashCode()
```

### `com.pico.spatial.core.container.ModelViewInteractableComponent`
Package-private (NOT public) internal component (final class, no public ctor exposed). Used internally by SpatialModelView to make a loaded model view's entity interactable (see SpatialModelView.access$applySingleEntityInteractable). App code cannot instantiate it; use ecs.InteractableComponent instead. Documented here only to note it is internal.

```
ModelViewInteractableComponent()  // package-private, extends com.pico.spatial.core.ecs.Component
```

### `com.pico.spatial.core.ecs.Entity`
The scene-graph node / ECS entity. Holds a ComponentSet (getComponents()), supports parent/child hierarchy, model loading (static load/loadSuspend), and coordinate-space conversions. NOTE: there is NO instance addEntity(Entity) -- you parent entities with addChild(Entity)/setParent(Entity), and you add a root entity to the live scene via SpatialView.addEntity(Entity) (see SpatialView). extends EventSource implements SpatialCoordinateSpace.

```
public com.pico.spatial.core.ecs.Entity()  // create empty entity
public com.pico.spatial.core.ecs.Entity(long)
public static final com.pico.spatial.core.ecs.Entity load(java.lang.String) throws ResourceLoadingException  // blocking model load from asset path
public static final com.pico.spatial.core.ecs.Entity load(java.io.File) throws ResourceLoadingException
public static final com.pico.spatial.core.ecs.Entity load(android.content.ContentResolver, android.net.Uri) throws ResourceLoadingException
public static final com.pico.spatial.core.ecs.Entity load(java.io.InputStream, com.pico.spatial.core.ecs.ModelFormat) throws ResourceLoadingException
public static final com.pico.spatial.core.ecs.Entity load(java.lang.String, com.pico.spatial.core.ecs.resource.AssetBundle) throws ResourceLoadingException
public static final java.lang.Object loadSuspend(java.lang.String, kotlin.coroutines.Continuation<? super Entity>)  // suspend fun load(path): Entity
public static final java.lang.Object loadSuspend(java.io.File, kotlin.coroutines.Continuation<? super Entity>)
public static final java.lang.Object loadSuspend(android.content.ContentResolver, android.net.Uri, kotlin.coroutines.Continuation<? super Entity>)
public static final java.lang.Object loadSuspend(java.io.InputStream, com.pico.spatial.core.ecs.ModelFormat, kotlin.coroutines.Continuation<? super Entity>)
public static final java.lang.Object loadSuspend(java.lang.String, com.pico.spatial.core.ecs.resource.AssetBundle, kotlin.coroutines.Continuation<? super Entity>)
public final com.pico.spatial.core.ecs.Entity$ComponentSet getComponents()  // the component accessor: entity.components in Kotlin
public final com.pico.spatial.core.ecs.Scene getScene()
public final long getId()
public final long getUUID()
public final boolean isValid()
public final boolean isEnabled()
public final void setEnabled(boolean)
public final java.lang.String getName()
public final void setName(java.lang.String)
public final boolean addChild(com.pico.spatial.core.ecs.Entity)  // parent another entity under this one
public final boolean removeChild(com.pico.spatial.core.ecs.Entity)
public final boolean removeAllChildren()
public final com.pico.spatial.core.ecs.Entity[] getChildren()
public final int getChildrenCount()
public final boolean hasChild()
public final boolean hasParent()
public final boolean isChild(com.pico.spatial.core.ecs.Entity)
public final boolean isParent(com.pico.spatial.core.ecs.Entity)
public final boolean setParent(com.pico.spatial.core.ecs.Entity)
public final com.pico.spatial.core.ecs.Entity getParent()
public final boolean removeFromParent()
public final com.pico.spatial.core.ecs.Entity findEntity(java.lang.String)
public final com.pico.spatial.core.ecs.Entity clone(com.pico.spatial.core.ecs.Entity$CloneOptions)
public final boolean destroy(boolean)
public com.pico.spatial.core.ecs.Entity getOrigin()
public final com.pico.spatial.core.math.Vector3 convertPositionTo(com.pico.spatial.core.math.Vector3, com.pico.spatial.core.ecs.Entity)
public final com.pico.spatial.core.math.Vector3 convertPositionFrom(com.pico.spatial.core.math.Vector3, com.pico.spatial.core.ecs.Entity)
public final com.pico.spatial.core.math.Quat convertRotationTo(com.pico.spatial.core.math.Quat, com.pico.spatial.core.ecs.Entity)
public final com.pico.spatial.core.math.Quat convertRotationFrom(com.pico.spatial.core.math.Quat, com.pico.spatial.core.ecs.Entity)
public final com.pico.spatial.core.math.Transform convertTransformTo(com.pico.spatial.core.math.Transform, com.pico.spatial.core.ecs.Entity)
public final com.pico.spatial.core.math.Transform convertTransformFrom(com.pico.spatial.core.math.Transform, com.pico.spatial.core.ecs.Entity)
public final com.pico.spatial.core.ecs.BoundingBox getVisualBounds(com.pico.spatial.core.ecs.Entity, boolean, boolean)
```

### `com.pico.spatial.core.ecs.Entity$ComponentSet`
The per-entity component collection returned by entity.getComponents(). Implements Collection<Component>. This is how you ADD/GET/REMOVE/QUERY components (InteractableComponent, TransformComponent, ModelComponent, CollisionComponent, etc.). The reified Kotlin helpers get()/set(T)/has() with no Class arg use the runtime type; the Class<T> overloads are the JVM-visible form.

```
public final <T extends Component> T get(java.lang.Class<T>)  // entity.components.get(TransformComponent::class.java)
public final <T extends Component> T get()  // reified: entity.components.get<TransformComponent>()
public final <T extends Component> void set(java.lang.Class<T>, T)  // attach/replace a component
public final <T extends Component> void set(T)  // reified set; entity.components.set(InteractableComponent())
public final void set(java.util.List<? extends Component>)
public final <T extends Component> boolean has(java.lang.Class<T>)
public final <T extends Component> boolean has()
public final void remove(java.lang.Class<? extends Component>)
public final void clear()
public boolean add(com.pico.spatial.core.ecs.Component)
public boolean contains(com.pico.spatial.core.ecs.Component)
public int getSize() / public final int size()
public java.util.Iterator<com.pico.spatial.core.ecs.Component> iterator()
```

### `com.pico.spatial.core.ecs.TransformComponent`
The entity transform (local-space TRS). Rotation is exposed BOTH as a quaternion (Quat) and as EulerAngles -- they are kept in sync. setQuaternion(Quat) is the way to orient a pin to a surface normal. All set* methods also return the TransformComponent (fluent builder variants exist). extends Component.

```
public com.pico.spatial.core.ecs.TransformComponent()
public com.pico.spatial.core.ecs.TransformComponent(com.pico.spatial.core.math.Transform)
public com.pico.spatial.core.ecs.TransformComponent(com.pico.spatial.core.math.Vector3 pos, com.pico.spatial.core.math.EulerAngles rot, com.pico.spatial.core.math.Vector3 scale)
public com.pico.spatial.core.ecs.TransformComponent(com.pico.spatial.core.math.Vector3 pos, com.pico.spatial.core.math.Quat rot, com.pico.spatial.core.math.Vector3 scale)  // <- ctor that takes a quaternion directly
public final com.pico.spatial.core.math.Vector3 getPosition()
public final void setPosition(com.pico.spatial.core.math.Vector3)
public final com.pico.spatial.core.ecs.TransformComponent setPosition(com.pico.spatial.core.math.Vector3)  // fluent variant
public final com.pico.spatial.core.math.Quat getQuaternion()
public final void setQuaternion(com.pico.spatial.core.math.Quat)  // <- orient from a quaternion (surface normal)
public final com.pico.spatial.core.ecs.TransformComponent setQuaternion(com.pico.spatial.core.math.Quat)  // fluent variant
public final com.pico.spatial.core.math.EulerAngles getEulerAngles()
public final void setEulerAngles(com.pico.spatial.core.math.EulerAngles)
public final com.pico.spatial.core.ecs.TransformComponent setEulerAngles(com.pico.spatial.core.math.EulerAngles)  // fluent variant
public final com.pico.spatial.core.math.Vector3 getScaleVector()
public final void setScaleVector(com.pico.spatial.core.math.Vector3)
public final com.pico.spatial.core.ecs.TransformComponent setScaleVector(com.pico.spatial.core.math.Vector3)  // fluent variant
public final com.pico.spatial.core.ecs.TransformComponent scaleBy(float)
public final com.pico.spatial.core.math.Matrix4 getLocalMatrix()
public com.pico.spatial.core.ecs.Component clone()
```

### `com.pico.spatial.core.math.Vector3`
Immutable 3-float vector (x,y,z), the position/scale/direction/normal type. Has operator overloads (plus/minus/times/div), normalize/length/dot/cross, and direction constants. Used for ray origin, ray direction, hit position, hit normal.

```
public com.pico.spatial.core.math.Vector3(float x, float y, float z)
public com.pico.spatial.core.math.Vector3(float)  // all components = v
public com.pico.spatial.core.math.Vector3(com.pico.spatial.core.math.Vector3)
public final float getX() / getY() / getZ()
public static final com.pico.spatial.core.math.Vector3 ZERO, ONE, UP, DOWN, FORWARD, BACK, RIGHT, LEFT
public final float length()
public final com.pico.spatial.core.math.Vector3 normalize()
public final com.pico.spatial.core.math.Vector3 plus/minus/times/div(Vector3)  // operators; times(float)/div(float) too
public final com.pico.spatial.core.math.Vector3 unaryMinus()
public final boolean isFinite()
public static final float dot(Vector3, Vector3)
public static final com.pico.spatial.core.math.Vector3 cross(Vector3, Vector3)
public static final float angle(Vector3, Vector3)
public static final com.pico.spatial.core.math.Vector3 reflect(Vector3 dir, Vector3 normal)
public static final com.pico.spatial.core.math.Vector3 project(Vector3, Vector3)
public static final com.pico.spatial.core.math.Vector3 lerp/slerp(Vector3, Vector3, float)  // also lerpUnclamped/slerpUnclamped/moveTowards
public final com.pico.spatial.core.math.Vector4 toVector4()  // Companion mirrors all the static dot/cross/etc.
```

### `com.pico.spatial.core.math.Quat`
Immutable quaternion (x,y,z,w) -- the rotation type used by TransformComponent.setQuaternion. KEY for surface-normal orientation: the constructor Quat(Vector3 axis, float angle) builds a rotation from an axis+angle, rotateVector rotates a vector, toEulerAngles/toMatrix convert. Default ctor Quat() = identity. Includes slerp/nlerp.

```
public com.pico.spatial.core.math.Quat()  // identity
public com.pico.spatial.core.math.Quat(float x, float y, float z, float w)
public com.pico.spatial.core.math.Quat(com.pico.spatial.core.math.Vector3 axis, float angle)  // <- axis-angle rotation (radians; see EulerAngles.degreeToRadian)
public com.pico.spatial.core.math.Quat(com.pico.spatial.core.math.Quat)
public static final com.pico.spatial.core.math.Quat identity()
public final float getX()/getY()/getZ()/getW()
public final com.pico.spatial.core.math.Vector3 rotateVector(com.pico.spatial.core.math.Vector3)
public final com.pico.spatial.core.math.EulerAngles toEulerAngles()
public final com.pico.spatial.core.math.Matrix4 toMatrix()
public final kotlin.Pair<java.lang.Float, com.pico.spatial.core.math.Vector3> toAngleAxis()
public final com.pico.spatial.core.math.Quat times(com.pico.spatial.core.math.Quat)  // compose rotations; also times(float)/div(float)/plus/minus/unaryMinus
public final com.pico.spatial.core.math.Quat normalize()
public final com.pico.spatial.core.math.Quat conjugate()
public final float length()
public final boolean isFinite()
public final boolean equivalentCheck(com.pico.spatial.core.math.Quat)
public static final com.pico.spatial.core.math.Quat slerp(Quat, Quat, float)  // also nlerp, slerpLongPath, dot
static Companion mirrors identity()/dot/nlerp/slerp/slerpLongPath
```

### `com.pico.spatial.core.math.Rotation`
Higher-level rotation wrapper around a Quat. Can be built from a Quat, EulerAngles, or (angle, axis). Exposes angle/axis/eulerAngles/quaternion/inverse and compose (times). Handy when you have an axis+angle from a normal-to-up rotation. NOTE ctor order is (float angle, Vector3 axis) -- opposite of Quat(axis, angle).

```
public com.pico.spatial.core.math.Rotation(com.pico.spatial.core.math.Quat)
public com.pico.spatial.core.math.Rotation(com.pico.spatial.core.math.EulerAngles)
public com.pico.spatial.core.math.Rotation(float angle, com.pico.spatial.core.math.Vector3 axis)
public static final com.pico.spatial.core.math.Rotation identity()
public final com.pico.spatial.core.math.Quat getQuaternion()
public final float getAngle()
public final com.pico.spatial.core.math.Vector3 getAxis()
public final com.pico.spatial.core.math.EulerAngles getEulerAngles()
public final com.pico.spatial.core.math.Rotation getInverse()
public final boolean isIdentity()
public final com.pico.spatial.core.math.Rotation times(com.pico.spatial.core.math.Rotation)
public static final com.pico.spatial.core.math.Rotation slerp(Rotation, Rotation, float, Rotation$Companion$SlerpPath)
```

### `com.pico.spatial.core.math.EulerAngles`
Immutable pitch/yaw/roll triple (radians). Convertible to/from Quat. Provides degree<->radian helpers (important: the Quat axis-angle ctor and these use radians).

```
public com.pico.spatial.core.math.EulerAngles(float pitch, float yaw, float roll)
public com.pico.spatial.core.math.EulerAngles()  // zero
public final float getPitch()/getYaw()/getRoll()
public final com.pico.spatial.core.math.Quat toQuat()
public static final float degreeToRadian(float)
public static final float radianToDegree(float)
public final boolean isFinite()
public final boolean equivalentCheck(com.pico.spatial.core.math.EulerAngles)
```

### `com.pico.spatial.core.math.Transform`
Immutable position+rotation(quaternion or euler)+scale bundle. Construct one and pass to the TransformComponent(Transform) ctor, or read getPosition/getQuaternion/getScale. translate/rotate/scale return new Transforms.

```
public com.pico.spatial.core.math.Transform()
public com.pico.spatial.core.math.Transform(Vector3 position, EulerAngles rotation, Vector3 scale)
public com.pico.spatial.core.math.Transform(Vector3 position, Quat quaternion, Vector3 scale)
public final com.pico.spatial.core.math.Vector3 getPosition()
public final com.pico.spatial.core.math.Vector3 getScale()
public final com.pico.spatial.core.math.Quat getQuaternion()
public final com.pico.spatial.core.math.EulerAngles getRotation()
public final com.pico.spatial.core.math.Matrix4 toMatrix4()
public final float[] toFloatArray()
public final com.pico.spatial.core.math.Transform rotate(com.pico.spatial.core.math.Quat)
public final com.pico.spatial.core.math.Transform translate(com.pico.spatial.core.math.Vector3)
public final com.pico.spatial.core.math.Transform scale(com.pico.spatial.core.math.Vector3)
```

### `com.pico.spatial.core.math.Matrix4`
4x4 matrix. Companion.lookAt(eye, center, up) builds a look-at basis; getRotation() extracts a Quat. This is the cleanest path to turn a hit-point + surface-normal into an orientation quaternion (build lookAt aligning forward to the normal, take getRotation()).

```
Companion: public final com.pico.spatial.core.math.Matrix4 lookAt(Vector3 eye, Vector3 center, Vector3 up)
Companion: public final com.pico.spatial.core.math.Matrix4 rotation(com.pico.spatial.core.math.EulerAngles)
public final com.pico.spatial.core.math.Quat getRotation()  // extract orientation as a quaternion
```

### `com.pico.spatial.core.ecs.Scene`
The live ECS scene (entity.getScene()). Provides the PUBLIC event subscription API (subscribe -> Cancellable) and rayCast/convexCast. rayCast is the SDK-native ray-vs-collider test that returns hit entity + hit point + surface normal. extends EventSource.

```
public final com.pico.spatial.core.ecs.simulation.CollisionCastHitResults rayCast(com.pico.spatial.core.math.Vector3 origin, com.pico.spatial.core.math.Vector3 direction, float distance, com.pico.spatial.core.ecs.simulation.CollisionCastHitMode hitMode, com.pico.spatial.core.ecs.simulation.CollisionGroup group, com.pico.spatial.core.ecs.Entity referenceSpaceEntity)
public static CollisionCastHitResults rayCast$default(Scene, Vector3, Vector3, float, CollisionCastHitMode, CollisionGroup, Entity, int, Object)  // trailing args have defaults
public final com.pico.spatial.core.ecs.simulation.CollisionCastHitResults convexCast(ShapeResource, Vector3 origin, Quat rotation, Vector3 direction, float distance, CollisionCastHitMode, CollisionGroup, Entity)
public final <T extends Event> com.pico.spatial.core.lifecycle.Cancellable subscribe(java.lang.Class<T> eventType, com.pico.spatial.core.ecs.EventSource source, java.lang.Class<? extends Component> componentType, com.pico.spatial.core.ecs.event.EventSubscriber<T> subscriber)  // PUBLIC subscription; returns Cancellable to unsubscribe
public static Cancellable subscribe$default(Scene, Class, EventSource, Class, EventSubscriber, int, Object)
public final java.util.List<com.pico.spatial.core.ecs.Entity> queryEntity(com.pico.spatial.core.ecs.EntityQueryCondition...)
```

### `com.pico.spatial.core.ecs.simulation.CollisionCastHitResults`
Result wrapper from Scene.rayCast/convexCast. Just holds the ordered list of per-hit results.

```
public com.pico.spatial.core.ecs.simulation.CollisionCastHitResults(java.util.List<CollisionCastResult>)
public final java.util.List<com.pico.spatial.core.ecs.simulation.CollisionCastResult> getResults()
```

### `com.pico.spatial.core.ecs.simulation.CollisionCastResult`
A single ray/convex-cast hit. THE central type for pin placement: getEntity()=hit entity, getPosition()=world hit point (pin position), getNormal()=surface normal (orient pin), plus distance/uv/material. Note: position/normal are in the reference space passed to rayCast (the referenceSpaceEntity arg).

```
public com.pico.spatial.core.ecs.simulation.CollisionCastResult(Entity entity, int shapeIndex, Vector3 position, Vector3 normal, float distance, Vector2 uv0, Vector2 uv1, int materialIndex)
public final com.pico.spatial.core.ecs.Entity getEntity()
public final int getShapeIndex()
public final com.pico.spatial.core.math.Vector3 getPosition()  // hit point
public final com.pico.spatial.core.math.Vector3 getNormal()   // surface normal
public final float getDistance()
public final com.pico.spatial.core.math.Vector2 getUv0()
public final com.pico.spatial.core.math.Vector2 getUv1()
public final int getMaterialIndex()
```

### `com.pico.spatial.core.ecs.simulation.CollisionCastHitMode`
Enum selecting which hits rayCast returns.

```
public static final CollisionCastHitMode NEAREST
public static final CollisionCastHitMode ALL
public static CollisionCastHitMode[] values()
public static CollisionCastHitMode valueOf(java.lang.String)
```

### `com.pico.spatial.core.ecs.CollisionComponent`
Adds collision geometry to an entity so it is a valid rayCast/convexCast target and can emit CollisionEvents. Required on a surface for Scene.rayCast to hit it. Constructed with a list of ShapeResource plus response mode / filter / detail level.

```
public com.pico.spatial.core.ecs.CollisionComponent()
public com.pico.spatial.core.ecs.CollisionComponent(java.util.List<ShapeResource> shapes, PhysicsMaterialResource material, CollisionResponseMode responseMode, CollisionFilter filter, CollisionInfoDetailLevel detailLevel)
public final java.util.List<com.pico.spatial.core.ecs.resource.ShapeResource> getCollisionShape() / setCollisionShape(List)
public final com.pico.spatial.core.ecs.simulation.CollisionResponseMode getCollisionResponseMode() / setCollisionResponseMode(...)
public final com.pico.spatial.core.ecs.simulation.CollisionFilter getCollisionFilter() / setCollisionFilter(...)
public final com.pico.spatial.core.ecs.resource.PhysicsMaterialResource getPhysicsMaterial() / setPhysicsMaterial(...)
public final com.pico.spatial.core.ecs.simulation.CollisionInfoDetailLevel getCollisionInfoDetailLevel() / setCollisionInfoDetailLevel(...)
```

### `com.pico.spatial.core.ecs.event.EventSubscriber`
Functional interface passed to Scene.subscribe; onEvent fires for each matching event. Parameterized by the Event subtype.

```
public abstract void onEvent(T)  // T extends com.pico.spatial.core.ecs.event.Event
```

### `com.pico.spatial.core.ecs.event.CollisionEvents$Enter`
Concrete Event delivered on collision begin (subscribe with CollisionEvents.Enter.class). Carries the two entities and contact data. This is the only ECS-level event family that reflects something 'touching' an interactable collider; there is NO ClickEvent/SelectEvent/PointerEvent in the core event package (the full event set is: Animation/Audio/Collision/Component/Entity/Scene/Timeline events).

```
public final com.pico.spatial.core.ecs.Entity getEntityA()
public final com.pico.spatial.core.ecs.Entity getEntityB()
public final com.pico.spatial.core.math.Vector3 getPosition()
public final com.pico.spatial.core.math.Vector3 getImpulse()
public final float getPenetrationDistance()
public final java.util.List<com.pico.spatial.core.ecs.simulation.CollisionContact> getContacts()
// siblings: CollisionEvents$Update, CollisionEvents$Exit
```

### `com.pico.spatial.core.container.SpatialView`
Android FrameLayout that hosts the spatial scene. addEntity(Entity) is the public way to put a root entity into the live scene (this is the 'addEntity' the task referenced; it is NOT on Entity). Use this to drop a newly-built pin entity into the world.

```
public com.pico.spatial.core.container.SpatialView(android.content.Context)
public final void addEntity(com.pico.spatial.core.ecs.Entity)  // add entity to the live spatial scene
public final com.pico.spatial.core.container.SpatialViewContent getContent()
public final void setAttachments(java.util.List<? extends AttachmentPanel>)
public final int getDepthZ()
public final float getScaleZ() / setScaleZ(float)
public final kotlin.jvm.functions.Function0<kotlin.Unit> getOnContentUpdateCallback() / setOnContentUpdateCallback(...)
```

### `com.pico.spatial.core.container.SpatialModelView`
SpatialView subclass that loads a single model and auto-applies interactivity to it (internal applySingleEntityInteractable / ModelViewInteractableComponent). Construct with (Context, assetPath, Resizability) [+ optional AssetBundle]. Exposes model scale / resizability but NO public click/select listener -- selection is handled by the system's pointer/controller layer, not a callback here.

```
public com.pico.spatial.core.container.SpatialModelView(android.content.Context, java.lang.String path, SpatialModelView$Resizability)
public com.pico.spatial.core.container.SpatialModelView(android.content.Context, java.lang.String path, AssetBundle, SpatialModelView$Resizability)
public final com.pico.spatial.core.container.SpatialModelView$Resizability getResizability() / setResizability(...)
public final com.pico.spatial.core.math.Vector3 getModelScale() / setModelScale(Vector3)
public com.pico.spatial.core.ecs.Entity l  // (obfuscated) the model's root entity field
```

### `com.pico.spatial.core.ecs.LookAtComponent`
Alternative to manually computing orientation: makes an entity continuously face a target (the viewer or another entity). Useful for billboard-style pins/labels; not for normal-aligned pins. Forward direction and up-alignment are configurable.

```
public com.pico.spatial.core.ecs.LookAtComponent()
public final void setViewerAsTarget()
public final void setEntityAsTarget(com.pico.spatial.core.ecs.Entity)
public final void clearTarget()
public final com.pico.spatial.core.ecs.LookAtTargetType getLookAtTargetType()
public final boolean getAlignLocalUpToWorldUp() / setAlignLocalUpToWorldUp(boolean)
public final com.pico.spatial.core.ecs.LookAtForwardDirection getLookAtForwardDirection() / setLookAtForwardDirection(...)
```

### `com.pico.spatial.core.ecs.ModelComponent`
The visual mesh+material for an entity (the pin's glyph). Construct from a MeshResource + Material(s), or load a whole entity via Entity.load. Listed for completeness of the build-a-pin step.

```
public com.pico.spatial.core.ecs.ModelComponent()
public com.pico.spatial.core.ecs.ModelComponent(com.pico.spatial.core.ecs.resource.MeshResource, com.pico.spatial.core.ecs.resource.Material)
public com.pico.spatial.core.ecs.ModelComponent(com.pico.spatial.core.ecs.resource.MeshResource, com.pico.spatial.core.ecs.resource.Material[])
```

### `com.pico.spatial.tracking.controller.ControllerPose`
(tracking module, adjacent subsystem) Provides the controller's world position+rotation -- the ray origin and direction for raycasting. getRotation().rotateVector(Vector3.FORWARD) gives the aim direction. Obtained via com.pico.spatial.tracking.controller.ControllerTrackingProvider (not detailed here -- belongs to the tracking subsystem).

```
public final com.pico.spatial.core.math.Vector3 getPosition()  // ray origin
public final com.pico.spatial.core.math.Quat getRotation()    // aim orientation
public com.pico.spatial.tracking.controller.ControllerPose(Vector3, Quat)
```

**Uncertainties:** InteractableComponent is a pure marker: bytecode shows its only effect is getAdapter().pushComponent(); it has NO onClick/onSelect/setlistener API. How a 'select' is actually delivered to app code is NOT discoverable from the core jar — there is no ClickEvent/SelectEvent/PointerEvent in com.pico.spatial.core.ecs.event (full set: Animation/Audio/Collision/Component/Entity/Scene/Timeline). Selection feedback most likely comes from (a) the app's own controller-ray rayCast loop, or (b) the system pointer layer / SpatialModelView's internal interactable wiring, or (c) a higher-level UI/attachment-panel layer not in this subsystem. Treat pattern (a) in the recipe as the safe assumption.; The foundation adapter classes (com.pico.spatial.foundation.extensions.spatial.ecs.InteractableComponent / TransformComponent / Component / Entity, and the event model classes) are referenced everywhere as field `m`/`b` but are NOT present in any extracted jar (foundation/classes.jar does not contain com/pico/spatial/foundation/extensions/spatial/ecs/*). They are presumably in a native bridge or a separate artifact, so the real interaction/transform semantics behind these delegates are unverifiable here.; CollisionGroup and CollisionFilter: the Companion classes expose no enumerated public factory constants in javap (only the obfuscated DefaultConstructorMarker ctor). I did not fully enumerate CollisionGroup/CollisionFilter/CollisionResponseMode/CollisionInfoDetailLevel public constructors or enum values — the rayCast group/filter args' exact construction needs a follow-up javap of those four classes.; rayCast/CollisionCastResult coordinate space: position and normal are expressed relative to the 'referenceSpaceEntity' (last rayCast arg). Whether passing null means world space vs requires a specific origin entity is not provable from signatures; Entity.convertPositionFrom/convertRotationFrom exist to convert between entity spaces if needed.; Quat(Vector3 axis, float angle) and the EulerAngles helpers strongly imply angles are in RADIANS (EulerAngles.degreeToRadian/radianToDegree exist), but javap does not prove the unit; verify before feeding degrees.; Matrix4.lookAt(eye, center, up) handedness/forward-axis convention is unverified from signatures; the resulting getRotation() quaternion may align a different local axis (forward vs up) to the normal than expected — validate on-device and swap to the axis-angle Option B if the pin points the wrong way.; ModelViewInteractableComponent is package-private with no usable public constructor; it is internal to SpatialModelView. App code should use com.pico.spatial.core.ecs.InteractableComponent instead. Its precise behavior vs the plain InteractableComponent is not documented.; No persistence API exists in this subsystem; durable, world-locked pins require AnchorComponent/AnchorEntity (anchor/tracking subsystem) which was not analyzed here.

## anchor

### `com.pico.spatial.sense.world.WorldTrackingManager`
Object singleton (INSTANCE). Creates/loads/removes PERSISTENT world anchors. This is the 'stick a pin to a world-space point permanently' API. createAnchor takes a position + Euler rotation + name and returns a WorldAnchor with a stable UUID you persist. No start/stop/getState (unlike Plane/Mesh) — world anchors are managed directly via these suspend calls. Backend bridges to foundation com.pico.spatial.foundation.extensions.sense.WorldTrackingManager (createAnchor(String name, float[] pose, ProviderCallback)). Most likely to work in the emulator since it does not depend on passthrough camera surface reconstruction.

```
public static final com.pico.spatial.sense.world.WorldTrackingManager INSTANCE
private WorldTrackingManager()
public final java.lang.Object createAnchor(com.pico.spatial.core.math.Vector3 position, com.pico.spatial.core.math.EulerAngles rotation, java.lang.String name, kotlin.coroutines.Continuation<? super com.pico.spatial.sense.world.WorldTrackingResult<com.pico.spatial.sense.world.WorldAnchor>>)  // SUSPEND
public static java.lang.Object createAnchor$default(WorldTrackingManager, Vector3, EulerAngles, String, Continuation, int, Object)  // name (and possibly rotation) have defaults
public final java.lang.Object loadAnchor(java.util.UUID[] uuids, kotlin.coroutines.Continuation<? super com.pico.spatial.sense.world.WorldTrackingResult<com.pico.spatial.sense.world.WorldAnchor[]>>)  // SUSPEND; rehydrate persisted anchors by saved UUID
public static java.lang.Object loadAnchor$default(WorldTrackingManager, java.util.UUID[], Continuation, int, Object)
public final java.lang.Object removeAnchor(java.util.UUID uuid, kotlin.coroutines.Continuation<? super com.pico.spatial.sense.world.WorldTrackingResult<kotlin.Unit>>)  // SUSPEND
public final com.pico.spatial.core.lifecycle.Cancellable subscribeAnchorUpdate(com.pico.spatial.sense.base.AnchorUpdateSubscriber<com.pico.spatial.sense.world.WorldAnchor>)
public final void triggerAnchorUpdate$sense_release(com.pico.spatial.sense.base.AnchorUpdate<com.pico.spatial.sense.world.WorldAnchor>)  // internal
```

### `com.pico.spatial.sense.world.WorldAnchor`
A persistent world anchor returned by WorldTrackingManager. Has a stable anchorUUID (persist this to disk; reload via loadAnchor) and a current Transform (position+rotation in world space). Extends base Anchor.

```
public WorldAnchor(com.pico.spatial.foundation.extensions.sense.WorldAnchor adapter)
public final com.pico.spatial.core.math.Transform getTransform()
public final java.util.UUID getAnchorUUID()
public final java.lang.String getName()
public final com.pico.spatial.foundation.extensions.sense.WorldAnchor getWorldAnchorAdapter$sense_release()
```

### `com.pico.spatial.sense.world.WorldTrackingResult`
Sealed-style result wrapper for all WorldTrackingManager suspend calls. Two subtypes: Success<T>(data) and Error(errorCode, errorMessage). You must branch on the subtype (instanceof / when) to get the WorldAnchor out of createAnchor/loadAnchor. Note: Mesh and Plane loadAllAnchors return raw arrays (no result wrapper); only World wraps results.

```
public abstract class WorldTrackingResult<T>
WorldTrackingResult$Success<T>: public final T getData()
WorldTrackingResult$Success<T>: public Success(T data)
WorldTrackingResult$Error: public final int getErrorCode()
WorldTrackingResult$Error: public final java.lang.String getErrorMessage()
WorldTrackingResult$Error: public Error(int errorCode, java.lang.String errorMessage)
```

### `com.pico.spatial.sense.plane.PlaneTrackingManager`
Object singleton (INSTANCE). Provides detected room PLANES (floor/wall/table/etc.) you can raycast against to find a surface under the controller ray. Must call start() before data is available; getState() reports tracking lifecycle. loadAllAnchors() is suspend and returns a snapshot array of PlaneAnchor; subscribeAnchorUpdate() gives a live ADDED/UPDATED/REMOVED stream. EMULATOR CAVEAT: plane data comes from passthrough scene understanding; on an emulator with no real cameras this likely returns an empty array / never fires ADDED events.

```
public static final com.pico.spatial.sense.plane.PlaneTrackingManager INSTANCE
public final com.pico.spatial.sense.base.TrackingState getState()
public final void start()
public final void stop()
public final java.lang.Object loadAllAnchors(kotlin.coroutines.Continuation<? super com.pico.spatial.sense.plane.PlaneAnchor[]>)  // SUSPEND, returns PlaneAnchor[]
public final com.pico.spatial.core.lifecycle.Cancellable subscribeAnchorUpdate(com.pico.spatial.sense.base.AnchorUpdateSubscriber<com.pico.spatial.sense.plane.PlaneAnchor>)
public final void triggerAnchorUpdate$sense_release(com.pico.spatial.sense.base.AnchorUpdate<com.pico.spatial.sense.plane.PlaneAnchor>)  // internal
```

### `com.pico.spatial.sense.plane.PlaneAnchor`
A detected planar surface. transform gives plane center pose; boundingBoxSize is a Vector2 (width/height of the plane). vertices+indices give the polygon boundary mesh you can raycast against. planeOrientation tells HORIZONTAL_UPWARD/DOWNWARD/VERTICAL/etc; semantics gives a single SemanticLabelType (FLOOR/WALL/TABLE...). Extends base Anchor.

```
public PlaneAnchor(com.pico.spatial.foundation.extensions.sense.PlaneAnchor adapter)
public final java.util.UUID getAnchorUUID()
public final com.pico.spatial.core.math.Transform getTransform()
public final com.pico.spatial.core.math.Vector2 getBoundingBoxSize()
public final java.util.List<com.pico.spatial.core.math.Vector3> getVertices()
public final java.util.List<java.lang.Integer> getIndices()
public final com.pico.spatial.sense.base.SemanticLabelType getSemantics()
public final com.pico.spatial.sense.plane.PlaneOrientation getPlaneOrientation()
```

### `com.pico.spatial.sense.mesh.MeshTrackingManager`
Object singleton (INSTANCE). Provides the room's reconstructed scene MESH (a single/aggregate triangle mesh per anchor) — denser than planes, good for raycasting against arbitrary geometry. Same lifecycle as Plane: start()/stop()/getState(), suspend loadAllAnchors() returns MeshAnchor[], subscribeAnchorUpdate() for live updates. EMULATOR CAVEAT: same as planes — depends on real-world reconstruction, likely empty in emulator.

```
public static final com.pico.spatial.sense.mesh.MeshTrackingManager INSTANCE
public final com.pico.spatial.sense.base.TrackingState getState()
public final void start()
public final void stop()
public final java.lang.Object loadAllAnchors(kotlin.coroutines.Continuation<? super com.pico.spatial.sense.mesh.MeshAnchor[]>)  // SUSPEND, returns MeshAnchor[]
public final com.pico.spatial.core.lifecycle.Cancellable subscribeAnchorUpdate(com.pico.spatial.sense.base.AnchorUpdateSubscriber<com.pico.spatial.sense.mesh.MeshAnchor>)
public final void triggerAnchorUpdate$sense_release(com.pico.spatial.sense.base.AnchorUpdate<com.pico.spatial.sense.mesh.MeshAnchor>)  // internal
```

### `com.pico.spatial.sense.mesh.MeshAnchor`
A reconstructed scene-mesh anchor. transform = mesh origin pose; boundingBoxSize is Vector3 (3D extents); vertices+indices form the triangle mesh (raycast target); semantics is a per-vertex/region List<SemanticLabelType>. Extends base Anchor.

```
public MeshAnchor(com.pico.spatial.foundation.extensions.sense.MeshAnchor adapter)
public final java.util.UUID getAnchorUUID()
public final com.pico.spatial.core.math.Transform getTransform()
public final com.pico.spatial.core.math.Vector3 getBoundingBoxSize()
public final java.util.List<com.pico.spatial.core.math.Vector3> getVertices()
public final java.util.List<java.lang.Integer> getIndices()
public final java.util.List<com.pico.spatial.sense.base.SemanticLabelType> getSemantics()
```

### `com.pico.spatial.sense.base.Anchor`
Empty open base class for all anchor types (World/Plane/Mesh/Keyboard). Carries no fields itself; used as the upper-bound type parameter for AnchorUpdate<T> and AnchorUpdateSubscriber<T>.

```
public class Anchor
public Anchor()
```

### `com.pico.spatial.sense.base.AnchorUpdate`
A single anchor-change event delivered to subscribers. getAnchor() returns the affected anchor (typed T); getEvent() returns the Event enum (ADDED/UPDATED/REMOVED/LOADED/UNKNOWN).

```
public AnchorUpdate(com.pico.spatial.foundation.extensions.sense.AnchorUpdate adapter, T anchor)
public final T getAnchor()
public final com.pico.spatial.sense.base.AnchorUpdate$Event getEvent()
```

### `com.pico.spatial.sense.base.AnchorUpdate$Event`
Enum of anchor lifecycle events. To handle live surface updates, switch on this in onUpdate.

```
ADDED
UPDATED
REMOVED
LOADED
UNKNOWN
public final int getValue()
public static AnchorUpdate$Event[] values()
public static AnchorUpdate$Event valueOf(String)
```

### `com.pico.spatial.sense.base.AnchorUpdateSubscriber`
Functional callback interface you implement and pass to any TrackingManager.subscribeAnchorUpdate(...). onUpdate is invoked per anchor change. Returns a Cancellable to unsubscribe.

```
public interface AnchorUpdateSubscriber<T extends com.pico.spatial.sense.base.Anchor>
public abstract void onUpdate(com.pico.spatial.sense.base.AnchorUpdate<T>)
```

### `com.pico.spatial.sense.base.TrackingState`
Enum returned by Plane/Mesh getState(). Use to gate calls (only loadAllAnchors when RUNNING).

```
NONE
INITIALIZED
RUNNING
PAUSED
STOPPED
INVALID
UNKNOWN
public final int getValue()
```

### `com.pico.spatial.sense.base.SemanticLabelType`
Enum of room semantic categories attached to plane/mesh anchors. Lets you place pins only on, e.g., TABLE or FLOOR, or color-code by surface type.

```
UNKNOWN
FLOOR
CEILING
WALL
DOOR
WINDOW
OPENING
TABLE
SOFA
CHAIR
HUMAN
BEAM
COLUMN
CURTAIN
CABINET
BED
PLANT
SCREEN
VIRTUAL_WALL
REFRIGERATOR
WASHING_MACHINE
AIR_CONDITIONER
LAMP
WALL_ART
STAIRWAY
```

### `com.pico.spatial.sense.plane.PlaneOrientation`
Enum describing a plane's facing. Use to decide pin orientation (e.g. up-marker on HORIZONTAL_UPWARD floor/table, flat-against-wall marker on VERTICAL).

```
UNKNOWN_ORIENTATION
HORIZONTAL_UPWARD
HORIZONTAL_DOWNWARD
VERTICAL
ARBITRARY
public final int getValue()
```

### `com.pico.spatial.core.ecs.anchor.AnchorTarget`
Describes what an ECS entity should anchor to. THE BRIDGE between a persisted WorldAnchor UUID and a rendered entity. createWorldAnchorTarget(UUID) takes the WorldAnchor.anchorUUID you got from createAnchor; createCameraTarget() anchors to the headset/camera instead. Pass the result into AnchorComponent or AnchorEntity.

```
public AnchorTarget()
public AnchorTarget(com.pico.spatial.foundation.extensions.spatial.ecs.anchor.AnchorTarget adapter)
public static final com.pico.spatial.core.ecs.anchor.AnchorTarget createCameraTarget()
public static final com.pico.spatial.core.ecs.anchor.AnchorTarget createWorldAnchorTarget(java.util.UUID)
Companion.createCameraTarget()
Companion.createWorldAnchorTarget(java.util.UUID)
```

### `com.pico.spatial.core.ecs.AnchorComponent`
ECS Component you attach to an existing Entity to make its world transform follow an AnchorTarget every frame (so a placed pin stays stuck to the surface/world anchor). Has positionOffset (Vector3) and rotationOffset (Quat) applied on top of the anchor pose, plus a TrackingMode. Construct with (AnchorTarget, TrackingMode) — when TrackingMode is omitted via the synthetic default ctor it defaults to CONTINUOUS. Extends core ECS Component; clone()/equals provided.

```
public AnchorComponent()
public AnchorComponent(com.pico.spatial.core.ecs.anchor.AnchorTarget, com.pico.spatial.core.ecs.AnchorComponent$TrackingMode)
public AnchorComponent(com.pico.spatial.core.ecs.anchor.AnchorTarget, com.pico.spatial.core.ecs.AnchorComponent$TrackingMode, int, kotlin.jvm.internal.DefaultConstructorMarker)  // synthetic; omitting TrackingMode defaults to CONTINUOUS
public AnchorComponent(com.pico.spatial.core.ecs.AnchorComponent)  // copy ctor
public final com.pico.spatial.core.ecs.anchor.AnchorTarget getAnchorTarget()
public final void setAnchorTarget(com.pico.spatial.core.ecs.anchor.AnchorTarget)
public final com.pico.spatial.core.math.Vector3 getPositionOffset()
public final void setPositionOffset(com.pico.spatial.core.math.Vector3)
public final com.pico.spatial.core.math.Quat getRotationOffset()
public final void setRotationOffset(com.pico.spatial.core.math.Quat)
public final com.pico.spatial.core.ecs.AnchorComponent$TrackingMode getTrackingMode()
public final void setTrackingMode(com.pico.spatial.core.ecs.AnchorComponent$TrackingMode)
public com.pico.spatial.core.ecs.Component clone()
```

### `com.pico.spatial.core.ecs.AnchorComponent$TrackingMode`
Wrapper enum-like type for anchor tracking cadence. CONTINUOUS = re-pose every frame as the anchor refines (best for surface-stuck pins); ONCE = snap to the anchor pose a single time. No public factory beyond the two static fields; default in AnchorComponent is CONTINUOUS.

```
public static final TrackingMode CONTINUOUS
public static final TrackingMode ONCE
public TrackingMode(com.pico.spatial.foundation.extensions.spatial.ecs.anchor.TrackingMode adapter)
public TrackingMode()
```

### `com.pico.spatial.core.ecs.AnchorEntity`
Convenience Entity subclass pre-wired to an AnchorTarget — a one-line way to create an entity that lives at an anchor. Constructor takes the AnchorTarget directly. Use this OR add an AnchorComponent to an existing entity (the component route also gives you positionOffset/rotationOffset/TrackingMode control). NOTE: AnchorEntity exposes only the constructor here; its behavior beyond construction is inherited from Entity and not visible in this javap.

```
public AnchorEntity(com.pico.spatial.core.ecs.anchor.AnchorTarget)
```

### `com.pico.spatial.core.ecs.simulation.CollisionCastResult`
NOT in the sense module but CRITICAL to the pin-placement flow and discovered while tracing the raycast path. A single physics raycast/shapecast hit: getPosition() = world-space hit point, getNormal() = surface normal at the hit, getEntity() = what was hit, getDistance(), uv0/uv1, materialIndex. This is the natural raycast-against-scene-colliders result whose position feeds WorldTrackingManager.createAnchor and whose normal drives pin orientation. (The cast-invoking method itself lives in the core ECS/physics scene API — owned by another subsystem — and was not located in the sense jar.)

```
public final com.pico.spatial.core.ecs.Entity getEntity()
public final com.pico.spatial.core.math.Vector3 getPosition()
public final com.pico.spatial.core.math.Vector3 getNormal()
public final float getDistance()
public final com.pico.spatial.core.math.Vector2 getUv0()
public final int getMaterialIndex()
```

### `com.pico.spatial.core.math.Transform`
Pose container used by every Anchor (foundation jar com.pico.spatial.core.math). Build one with position+rotation(+scale); read anchor.getTransform().getPosition()/getRotation()/getQuaternion(). Rotation available both as EulerAngles (getRotation) and Quat (getQuaternion).

```
public Transform(com.pico.spatial.core.math.Vector3 position, com.pico.spatial.core.math.EulerAngles rotation, com.pico.spatial.core.math.Vector3 scale)
public Transform(com.pico.spatial.core.math.Vector3 position, com.pico.spatial.core.math.Quat quaternion, com.pico.spatial.core.math.Vector3 scale)
public final com.pico.spatial.core.math.Vector3 getPosition()
public final com.pico.spatial.core.math.Quat getQuaternion()
public final com.pico.spatial.core.math.EulerAngles getRotation()
```

### `com.pico.spatial.core.math.EulerAngles`
Rotation as pitch/yaw/roll. REQUIRED type for the rotation arg of WorldTrackingManager.createAnchor (it takes EulerAngles, NOT Quat). Convert a Quat to this via Quat.toEulerAngles(); convert back via EulerAngles.toQuat(). degreeToRadian/radianToDegree helpers exist (units of the constructor fields are not explicitly documented in signatures).

```
public EulerAngles(float pitch, float yaw, float roll)
public EulerAngles()
public final float getPitch()
public final float getYaw()
public final float getRoll()
public final com.pico.spatial.core.math.Quat toQuat()
public static final float degreeToRadian(float)
public static final float radianToDegree(float)
```

### `com.pico.spatial.core.math.Quat`
Quaternion (foundation jar). Constructible from (x,y,z,w) or (axis Vector3, angle). Convert to EulerAngles via toEulerAngles() for createAnchor. IMPORTANT: there is NO lookRotation / fromToRotation helper, so building an orientation from a hit normal must be done manually (e.g. axis-angle from cross(UP, normal) and angle(UP, normal), or via EulerAngles).

```
public Quat(float x, float y, float z, float w)
public Quat(com.pico.spatial.core.math.Vector3 axis, float angle)
public Quat()
public final com.pico.spatial.core.math.EulerAngles toEulerAngles()
public final kotlin.Pair<java.lang.Float, com.pico.spatial.core.math.Vector3> toAngleAxis()
public static final com.pico.spatial.core.math.Quat identity()
public final com.pico.spatial.core.math.Quat times(com.pico.spatial.core.math.Quat)
public final com.pico.spatial.core.math.Quat normalize()
```

### `com.pico.spatial.core.lifecycle.Cancellable`
Handle returned by every subscribeAnchorUpdate(...) call (foundation jar). Call cancel() to stop receiving updates and release the subscription.

```
public abstract void cancel()
```

**Uncertainties:** RAYCAST IS NOT IN THIS SUBSYSTEM: neither the sense module nor the core simulation package exposes a discoverable rayCast/castRay method in javap. CollisionCastResult{position, normal} clearly IS the hit type, but the method that performs the cast lives in the core ECS scene/physics API (another agent's subsystem). I could not confirm its exact signature. The recipe assumes you build colliders from plane/mesh vertices (or attach colliders to AnchorEntities) and cast via that core API.; EMULATOR: Plane and Mesh tracking depend on passthrough scene reconstruction; with no real cameras the emulator very likely returns empty loadAllAnchors() arrays and never fires ADDED events (start()/getState() may still report RUNNING). World anchors (createAnchor/loadAnchor) bridge to foundation WorldTrackingManager and use 6DoF pose tracking, NOT cameras, so they are the component most likely to function in the emulator — but I could not execute anything to verify; this is inference from the bytecode bridge targets (com.pico.spatial.foundation.extensions.sense.WorldTrackingManager.createAnchor(String,float[],ProviderCallback)).; createAnchor rotation arg is EulerAngles, not Quat — confirmed from javap. The UNITS of EulerAngles (degrees vs radians) and of Vector3.angle()/the EulerAngles fields are NOT determinable from signatures. degreeToRadian/radianToDegree helpers exist on EulerAngles, hinting the canonical internal unit may be radians, but VERIFY before placing pins or orientation will be wrong.; createAnchor$default and loadAnchor$default exist, meaning createAnchor has default parameter(s). The name String is almost certainly defaulted; whether the EulerAngles rotation is also defaulted (to identity) could not be confirmed without decompiling the $default body's bitmask fully.; AnchorComponent default TrackingMode = CONTINUOUS — confirmed from the default-constructor bytecode (loads TrackingMode.CONTINUOUS when the rotation/mode bit is unset). TrackingMode only exposes CONTINUOUS and ONCE as static fields; there is no public factory, and the precise per-frame semantics (does CONTINUOUS re-query the native anchor pose every frame?) is inferred from naming, not documented.; AnchorEntity exposes ONLY its constructor in javap (everything else inherited from Entity). How to add render/mesh components to it, and the exact Entity.addComponent API for the AnchorComponent route, belong to the core ECS subsystem and are not shown here.; Many AnchorComponent methods are R8-obfuscated single-letter statics (a/b/c... returning Vector3/Quat/AnchorTarget); these are internal accessors backing the public getters/setters and are not part of the intended public API.; WorldAnchor.getTransform() returns the anchor's current pose, but whether it auto-updates as tracking refines, or is a snapshot at load time, is not determinable from signatures (subscribeAnchorUpdate UPDATED events are the reliable way to observe pose changes).; No persistence/save call was found beyond the UUID itself — the model appears to be: the platform persists the anchor natively keyed by UUID, and the app persists the UUID. createAnchor/loadAnchor/removeAnchor are the full lifecycle; there is no explicit save() in this subsystem.

## Implementation recipe — live controller-ray pin placement

I have all the decompiled docs inline. This is a synthesis task, not a code-exploration task, so I'll produce the recipe directly.

# IMPLEMENTATION RECIPE — Live Controller-Ray Damage-Pin Placement (PICO Spatial SDK, Kotlin)

## Imports (all steps)
```kotlin
import com.pico.spatial.tracking.controller.ControllerTrackingProvider
import com.pico.spatial.tracking.controller.ControllerActionData
import com.pico.spatial.tracking.controller.ControllerTrackingData
import com.pico.spatial.tracking.DataProvider
import com.pico.spatial.core.ecs.*
import com.pico.spatial.core.ecs.simulation.*
import com.pico.spatial.core.ecs.resource.*
import com.pico.spatial.core.ecs.anchor.AnchorTarget
import com.pico.spatial.core.container.SpatialView
import com.pico.spatial.core.math.*
import com.pico.spatial.sense.world.WorldTrackingManager
import com.pico.spatial.sense.world.WorldTrackingResult
import kotlin.math.abs
import kotlin.math.acos
```

---

## STEP 1 — Setup: obtain `ControllerTrackingProvider`, register the right-trigger listener inside a `SpatialView`

The `ControllerTrackingProvider` (controller doc) is a plain `DataProvider<ControllerTrackingData>` you construct yourself; there is no factory tying it to the `SpatialView`. Build it in your view/activity, gate on `getSupportState()`, then register the action listener. Keep a reference to the `SpatialView` and to a `Scene` (obtained via any entity's `getScene()` — see Step 2) for later.

```kotlin
class PinPlacer(private val spatialView: SpatialView) {

    private val controller = ControllerTrackingProvider()      // controller doc: public ctor
    private var wasTriggerPressed = false                       // edge-detection state

    fun start() {
        val startResult = controller.start()                   // -> DataProvider.StartResult.SUCCESS | PENDING
        // Gate before trusting data (controller doc: SupportState enum):
        // SUPPORTED / NOT_IN_FULL_SPACE / WITHOUT_PERMISSION / DEVICE_NOT_SUPPORTED / NONE / UNKNOWN
        if (controller.getSupportState() != DataProvider.SupportState.SUPPORTED) {
            // If startResult == PENDING, poll getState()/getSupportState() until STARTED+SUPPORTED.
            // Show a "raise/enable controller" message; do not place pins yet.
        }

        // Register the discrete button/trigger listener. Button events are NOT in the pose flow —
        // they ONLY arrive via addControllerActionListener (controller doc, ControllerActionListener).
        controller.addControllerActionListener(::onControllerAction)
    }

    fun stop() {
        controller.removeControllerActionListener(::onControllerAction)
        controller.stop()
    }
    // onControllerAction defined in Step 2.
}
```

Notes / flags:
- `ControllerTrackingProvider.ControllerActionListener` is a SAM interface (`onControllerAction(ControllerActionData)`), so a method reference `::onControllerAction` works. If the Kotlin SAM conversion is rejected (it is a *nested* interface, not a fun-interface guaranteed), fall back to the explicit `object : ControllerTrackingProvider.ControllerActionListener { override fun onControllerAction(...) }`.
- UNCERTAIN (controller doc): the listener may fire continuously every frame, not only on change. Edge-detection (Step 2) is therefore mandatory, not optional.
- UNCERTAIN: there is no API to check controller connectivity/handedness here; a disconnected right controller's pose contents are unspecified. Defensively null/zero-check the pose in Step 2.

---

## STEP 2 — On trigger press: read pose → build ray → cast into scene → `{hitPoint, hitNormal}`

The right-trigger rising edge is detected on `ControllerActionData.getRight().getTriggerPressed()`. On that edge, read the *freshest* pose via `controller.getLatestData().getRight()` (the action callback does not carry a pose), build the ray, and call `Scene.rayCast(...)`.

```kotlin
private fun onControllerAction(action: ControllerActionData) {
    val right = action.getRight()                              // RIGHT hand snapshot (ControllerAction)
    val pressedNow = right.getTriggerPressed()                // or: right.getTriggerValue() > 0.5f
    if (pressedNow && !wasTriggerPressed) {
        placePinFromRightController()                         // RISING EDGE only
    }
    wasTriggerPressed = pressedNow
}

private fun placePinFromRightController() {
    // --- Read freshest right-controller pose (ControllerPose: position + rotation) ---
    val pose   = controller.getLatestData().getRight()        // controller doc: ControllerTrackingData.getRight()
    val origin = pose.getPosition()                           // Vector3, world meters = ray ORIGIN
    val dir    = pose.getRotation()                           // Quat
                    .rotateVector(Vector3.FORWARD)            // local -Z forward -> world aim direction
                    .normalize()

    // --- Obtain the active Scene. Scene is reachable via Entity.getScene(); keep a reference to
    //     any entity already in the world (e.g. a known surface/root entity). ---
    val scene: Scene = referenceEntity.getScene()             // referenceEntity = an entity you already hold

    // --- Cast the ray. rayCast args are ALL required except the trailing ignoreEntity ---
    val hits: CollisionCastHitResults = scene.rayCast(
        origin,
        dir,
        10.0f,                                                // maxDistance (m)
        CollisionCastHitMode.NEAREST,                         // closest single hit (raycast doc)
        CollisionGroup(CollisionGroup.COLLISION_GROUP_ALL, null), // see flag below — value class ctor is illustrative
        null                                                  // ignoreEntity (pass a ray/cursor entity to skip it)
    )

    val hit = hits.getResults().firstOrNull() ?: return       // NEAREST => 0 or 1 element
    val hitPoint  = hit.getPosition()                         // world-space hit point (raycast doc)
    val hitNormal = hit.getNormal().normalize()               // surface normal
    val hitEntity = hit.getEntity()                           // what we hit (persist id if anchoring its surface)

    val orientation = orientUpToNormal(hitNormal)             // Step 3
    dropPin(scene, hitPoint, orientation, hitNormal)          // Step 4 + 5
}
```

Flags / uncertain APIs:
- `Vector3.FORWARD` handedness (−Z vs +Z) is **inferred from the constant name**. If aim is mirrored/reversed on device, swap to `Vector3.BACK`. Validate against a known controller orientation.
- `getTriggerPressed()`'s internal analog threshold is not visible. For custom sensitivity use `getTriggerValue() > 0.5f` (assumed 0..1).
- **`CollisionGroup` is a Kotlin inline value class** (getter mangled `getValue-pVg5ArA`). The `CollisionGroup(int, null)` constructor shown is **illustrative** — R8 hid the real public wrapping ctor/factory; the intended argument values are the constants `COLLISION_GROUP_ALL` / `COLLISION_GROUP_DEFAULT`. SAFEST: from Kotlin pass `CollisionGroup.Companion`-provided value if it exists, or wrap the constant; verify the exact constructor at compile time and adjust. If you cannot construct it, this is the one call most likely to need a javap follow-up.
- The cast only hits entities carrying a `CollisionComponent` with `ShapeResource` colliders. On device, scanned scene meshes *may* already have colliders; if `hits` is always empty, jump to **Step 6**.
- `getScene()` is the public, verified way to obtain a `Scene` (`AppScene.retrieveAppForm$...` is internal). You must already hold one in-scene entity. If you have none yet, create one root entity, add it via `spatialView.addEntity(...)` (Step 4), then read its `.getScene()`.
- UNCERTAIN (interaction doc): `rayCast` reports `position`/`normal` in the space of the **last (referenceSpaceEntity) arg**. Passing `null` for `ignoreEntity` is fine, but if your hit coordinates look offset, the cast may be interpreting a reference-space entity — re-check the overload you bind to and, if needed, convert with `Entity.convertPositionFrom/convertRotationFrom`.

---

## STEP 3 — Pin orientation: quaternion rotating +Y onto `hitNormal` (with world-up snap)

There is **no `lookRotation`/`fromToRotation`** on `Quat` (confirmed across raycast, interaction, anchor docs). Build it via axis-angle: axis = `cross(UP, normal)`, angle = `acos(dot(UP, normal))`. Handle the two degenerate cases (already aligned / flipped 180°). The requested world-up snap: when the surface is nearly horizontal-up (`|normal.y| > 0.85`), snap the pin to stand straight up on world +Y to avoid jitter from a noisy near-vertical normal.

```kotlin
/** Returns a Quat that rotates the pin's local +Y (Vector3.UP) onto worldNormal. */
private fun orientUpToNormal(worldNormal: Vector3): Quat {
    val n = worldNormal.normalize()

    // World-up snap: near-horizontal-up surface (floor/table) -> stand the pin straight up.
    if (abs(n.getY()) > 0.85f) {
        return if (n.getY() >= 0f) Quat.identity()            // +Y already == world up
               else Quat(Vector3.RIGHT, Math.PI.toFloat())    // ceiling: flip 180° about X
    }

    val up   = Vector3.UP
    val dotv = Vector3.dot(up, n).coerceIn(-1f, 1f)
    return when {
        dotv >  0.9999f -> Quat.identity()                    // parallel -> no rotation
        dotv < -0.9999f -> Quat(Vector3.RIGHT, Math.PI.toFloat()) // anti-parallel -> 180° about a stable axis
        else -> {
            val axis  = Vector3.cross(up, n).normalize()      // rotation axis (Vector3 static cross)
            val angle = acos(dotv.toDouble()).toFloat()       // RADIANS (see flag)
            Quat(axis, angle)                                 // axis-angle ctor: Quat(Vector3 axis, float angle)
        }
    }
}
```

Flags / uncertain APIs:
- **Angle unit is assumed RADIANS** for `Quat(Vector3, Float)`. Evidence: `EulerAngles` exposes `degreeToRadian/radianToDegree` and the interaction doc annotates the ctor "(radians)". I therefore feed `acos(...)` (radians) directly. The controller-doc recipe instead used `Vector3.angle(...)` and assumed *degrees* — those are inconsistent. SAFEST: use `acos(dot)` (provably radians) rather than `Vector3.angle()` whose unit is unproven. If the pin is rotated by a wrong factor, the unit is the culprit — convert via `EulerAngles.degreeToRadian`.
- `Vector3.UP`/`RIGHT` directions are name-inferred. If pins lean wrong, this axis convention is the suspect.
- ALTERNATIVE (interaction doc): `Matrix4.lookAt(eye, center=hitPoint+normal, up)` then `.getRotation()` gives a quaternion in one step — but its handedness/which-local-axis-it-aligns is **unverified**, and it may align local *forward* (−Z) rather than local *+Y* to the normal. Since the task explicitly asks for "+Y onto hitNormal," the axis-angle form above is the safer, semantically exact choice. Keep `lookAt` as a fallback only if axis-angle misbehaves.

---

## STEP 4 — Create the pin entity at `hitPoint` with that orientation; (optional) anchor it

Create the pin `Entity`, attach a `TransformComponent(position, quaternion, scale)`, add it to the live scene via `SpatialView.addEntity(...)` (the public "addEntity" — it is **not** on `Entity`). Optionally bind it to a persistent `WorldAnchor` so it survives frames/sessions.

```kotlin
private fun dropPin(scene: Scene, hitPoint: Vector3, orientation: Quat, hitNormal: Vector3) {
    // Visual: load a model, or build Entity() + ModelComponent(mesh, material).
    val pin = Entity.load("models/damage_pin.glb")            // or: Entity()
    pin.setName("damage_pin_${System.currentTimeMillis()}")

    // Lift the pin slightly off the surface along the normal so it doesn't z-fight.
    val placePos = hitPoint.plus(hitNormal.times(0.01f))

    pin.getComponents().set(
        TransformComponent(placePos, orientation, Vector3(0.05f, 0.05f, 0.05f)) // pos, Quat rot, scale
    )

    makePinSelectable(pin)                                    // Step 5 (before adding is fine)
    spatialView.addEntity(pin)                               // public add to live scene (interaction doc)

    // --- OPTIONAL persistence via WorldTrackingManager (anchor doc). SUSPEND calls. ---
    // persistPinAsWorldAnchor(pin, placePos, orientation)   // Step 4b (call from a coroutine)
}
```

### Step 4b — persist via `WorldTrackingManager` (most emulator-friendly of the sense APIs)
```kotlin
private suspend fun persistPinAsWorldAnchor(pin: Entity, pos: Vector3, orientation: Quat) {
    // createAnchor takes EulerAngles (NOT Quat). Convert:
    val euler: EulerAngles = orientation.toEulerAngles()      // Quat.toEulerAngles()

    val result = WorldTrackingManager.createAnchor(pos, euler, "damage_pin")  // SUSPEND
    when (result) {
        is WorldTrackingResult.Success -> {
            val anchor = result.getData()                    // WorldAnchor
            val uuid = anchor.getAnchorUUID()                // PERSIST this UUID to disk (prefs/db)

            // Bind the rendered pin to the anchor so it stays stuck:
            val target = AnchorTarget.createWorldAnchorTarget(uuid)
            val ac = AnchorComponent(target, AnchorComponent.TrackingMode.CONTINUOUS)
            pin.getComponents().set(ac)                      // pin now follows the world anchor every frame
        }
        is WorldTrackingResult.Error -> {
            // result.getErrorCode() / result.getErrorMessage(); fall back to in-memory pin only.
        }
    }
}
```

Flags / uncertain APIs:
- `Entity.load(...)` is **blocking** (`throws ResourceLoadingException`). Call it off the UI thread or use `loadSuspend(...)`. Wrap in try/catch.
- **`SpatialView.addEntity(Entity)`** is the verified public way to add a root entity. `Scene.addEntity$...` is internal — do not use. (raycast doc was unsure here; interaction doc resolves it.)
- `WorldTrackingManager.createAnchor` rotation arg is **`EulerAngles`, not `Quat`** (confirmed). **UNIT of EulerAngles (deg vs rad) is unproven.** `Quat.toEulerAngles()` should produce whatever unit the SDK expects internally, so converting straight from the quaternion (rather than constructing `EulerAngles` by hand) is the safest path — it avoids guessing the unit.
- `AnchorComponent.TrackingMode.CONTINUOUS` re-poses every frame (best for stuck pins); `ONCE` snaps once. Default is `CONTINUOUS`.
- If you anchor the pin, the `AnchorComponent` drives its transform from the anchor pose — the `TransformComponent` you set becomes a base that the anchor overrides; use `ac.setPositionOffset/setRotationOffset` for fine nudges instead of fighting it.
- ALTERNATIVE to `AnchorComponent`: construct `AnchorEntity(target)` directly and attach render components to it. Either works; the component route gives offset/mode control.
- UNCERTAIN: whether `createAnchor`'s `EulerAngles` rotation arg is itself defaulted (a `$default` exists). Pass it explicitly as shown.

---

## STEP 5 — Make the pin selectable so a tap opens its detail card

Add `InteractableComponent()`. **Critical caveat (interaction doc):** `InteractableComponent` is a *pure marker* — it has **no `onClick`/`onSelect` callback**, and the core event package has **no ClickEvent/SelectEvent/PointerEvent**. So "tap opens detail card" must be implemented by **your own controller-ray loop**: on a trigger press that is NOT a placement gesture, raycast and check whether `hit.entity == pin`. For your own ray to hit the pin, the pin also needs a `CollisionComponent`.

```kotlin
private fun makePinSelectable(pin: Entity) {
    // Marker so the system/your loop treats it as interactable:
    pin.getComponents().set(InteractableComponent())

    // REQUIRED for your own rayCast to hit the pin: give it a collider.
    pin.getComponents().set(
        CollisionComponent(
            listOf(ShapeResource.createSphere(0.05f)),       // small hit volume around the pin
            PhysicsMaterialResource(0.5f, 0.5f, 0.0f),
            CollisionResponseMode.COLLIDER_FULL,             // exact enum values not enumerated — verify
            CollisionFilter.COLLISION_FILTER_ALL,
            CollisionInfoDetailLevel.BRIEF                   // exact enum values not enumerated — verify
        )
    )
}
```

Selection-detection loop (reuse the SAME `onControllerAction` edge; distinguish placement vs select by app mode, e.g. a thumbstick/B-button modifier, or "select if ray hits an existing pin, else place"):
```kotlin
// Inside placePinFromRightController(), after you compute `hit`:
val hitEntity = hit.getEntity()
if (hitEntity.getName()?.startsWith("damage_pin_") == true) {
    openDetailCard(hitEntity)    // tapped an existing pin -> open its card
    return                       // do NOT place a new pin on top
}
// else fall through to dropPin(...) as normal.
```

Flags / uncertain APIs:
- **Selection delivery is the single biggest API gap.** Pattern (a) — your own raycast loop checking `hit.entity == pin` — is the **safe assumption** and is fully under your control. The system pointer layer *may* also drive selection through the `InteractableComponent`, but no app-visible callback was found, so do not rely on it.
- ALTERNATIVE (interaction doc): if you drive a cursor *collider* into pins, subscribe to `CollisionEvents.Enter` via `Scene.subscribe(CollisionEvents.Enter::class.java, pin, CollisionComponent::class.java, EventSubscriber{ ... })` and `cancel()` later. More complex; only use if you have a physical cursor collider.
- `CollisionResponseMode` and `CollisionInfoDetailLevel` enum constant names (e.g. `COLLIDER_FULL`, `BRIEF`) are taken from the docs' prose, not a full enumeration — verify the exact constant names against the SDK.
- Matching pins by name prefix is pragmatic; more robustly, keep a `Set<Long>` of pin `Entity.getId()` you placed and test membership.

---

## STEP 6 — EMULATOR FALLBACK (no passthrough → plane/mesh tracking empty)

`PlaneTrackingManager` and `MeshTrackingManager` depend on passthrough scene reconstruction; in the emulator `loadAllAnchors()` very likely returns an **empty array** and `ADDED` events never fire (anchor doc). The ray then hits nothing. Fix: **do not rely on tracked planes/mesh for the cast target — raycast against your app's OWN loaded room geometry / physics colliders.** `Scene.rayCast` is identical whether the collider came from scene-understanding or from your own GLB; you just need the collider to exist.

Exactly which API to use:
1. **Attach a `CollisionComponent` to your own room/level entities** (the GLB you ship for the emulator), using `ShapeResource.createStaticMesh(meshResource)` for the room mesh (or `createBox`/`createSphere` primitives for simple floors/walls). This is the operative call — `ShapeResource.createStaticMesh(MeshResource)` from the raycast doc.
2. Then **call the exact same `Scene.rayCast(origin, dir, maxDistance, CollisionCastHitMode.NEAREST, group, null)`** from Step 2. No code path changes — only the collider source changes.

```kotlin
/** Call ONCE at load for the emulator/in-app room model so the controller ray has something to hit. */
private fun makeRoomRaycastable(roomEntity: Entity, roomMesh: MeshResource) {
    if (!roomEntity.getComponents().has(CollisionComponent::class.java)) {
        roomEntity.getComponents().set(
            CollisionComponent(
                listOf(ShapeResource.createStaticMesh(roomMesh)),  // <-- the operative emulator API
                PhysicsMaterialResource(0.5f, 0.5f, 0.0f),
                CollisionResponseMode.COLLIDER_FULL,
                CollisionFilter.COLLISION_FILTER_ALL,
                CollisionInfoDetailLevel.BRIEF
            )
        )
    }
}
```

If you *want* to keep the tracked-surface path on real hardware and only fall back in the emulator, gate at runtime:
```kotlin
PlaneTrackingManager.start()
val planes = PlaneTrackingManager.loadAllAnchors()           // SUSPEND; PlaneAnchor[]
val usingTrackedSurfaces =
    PlaneTrackingManager.getState() == TrackingState.RUNNING && planes.isNotEmpty()
if (!usingTrackedSurfaces) {
    makeRoomRaycastable(roomEntity, roomMesh)                // emulator path: cast against own geometry
}
// To turn tracked planes/mesh INTO colliders on real HW: build ShapeResource.createStaticMesh from a
// MeshResource constructed out of PlaneAnchor/MeshAnchor getVertices()+getIndices(), attach as above.
```

Flags / uncertain APIs:
- **Persistence in the emulator:** `WorldTrackingManager.createAnchor/loadAnchor` bridges to foundation `WorldTrackingManager` and uses **6DoF pose tracking, not cameras**, so it is the **anchor API most likely to function in the emulator** — prefer it over plane/mesh for Step 4b. Still unverified without running.
- Converting `PlaneAnchor`/`MeshAnchor` `getVertices()`+`getIndices()` into a `MeshResource` for `createStaticMesh` requires the `MeshResource` builder, which is **not in these docs** — that constructor lives in the core ECS resource API and must be confirmed. For the pure-emulator path you sidestep this by shipping your own GLB room whose `MeshResource` you already have from `Entity.load`.
- `CollisionGroup` construction caveat from Step 2 applies identically here.

---

## CONSOLIDATED UNCERTAINTY / RISK LIST (verify on device)
1. `Vector3.FORWARD` sign (−Z assumed) — if aim reversed, use `Vector3.BACK`.
2. Angle unit for `Quat(axis, angle)` — RADIANS assumed; used `acos` (provably radians) over `Vector3.angle` (unit unproven).
3. `CollisionGroup` value-class construction — shown ctor is illustrative; the real public wrap/factory is R8-obscured. **Most likely compile-time fix needed.**
4. `Scene` acquisition — must hold an in-scene entity for `getScene()`; internal `AppScene` retrieve methods are not usable.
5. `rayCast` reference-space arg — hit position/normal may be in a reference-entity space; convert via `Entity.convertPositionFrom` if offset.
6. `InteractableComponent` has **no selection callback** — selection MUST be your own raycast loop (pattern a).
7. `CollisionResponseMode`/`CollisionInfoDetailLevel` exact enum constant names not fully enumerated.
8. Plane/Mesh tracking empty in emulator — use own-geometry colliders + `ShapeResource.createStaticMesh`.
9. `createAnchor` rotation is `EulerAngles` (not `Quat`), unit unproven — convert via `Quat.toEulerAngles()` rather than hand-building.
10. Action listener may fire every frame — edge detection mandatory (implemented).
11. `Entity.load` is blocking and throws — load off-thread / use `loadSuspend`, wrap in try/catch.

Key class/method citations: `ControllerTrackingProvider.start()/getSupportState()/addControllerActionListener/getLatestData()`, `ControllerActionData.getRight()`, `ControllerAction.getTriggerPressed()/getTriggerValue()`, `ControllerPose.getPosition()/getRotation()`, `Quat.rotateVector/toEulerAngles`, `Vector3.FORWARD/UP/RIGHT/cross/dot/normalize`, `Scene.rayCast`, `CollisionCastHitResults.getResults`, `CollisionCastResult.getPosition/getNormal/getEntity`, `CollisionCastHitMode.NEAREST`, `CollisionGroup.COLLISION_GROUP_ALL`, `TransformComponent(Vector3,Quat,Vector3)`, `Entity.load/getComponents/getScene/getName`, `Entity$ComponentSet.set/has`, `SpatialView.addEntity`, `InteractableComponent()`, `CollisionComponent(...)`, `ShapeResource.createStaticMesh/createSphere`, `WorldTrackingManager.createAnchor/loadAnchor`, `WorldTrackingResult.Success/Error`, `WorldAnchor.getAnchorUUID`, `AnchorTarget.createWorldAnchorTarget`, `AnchorComponent(target, TrackingMode.CONTINUOUS)`, `PlaneTrackingManager.start/getState/loadAllAnchors`, `TrackingState.RUNNING`.
