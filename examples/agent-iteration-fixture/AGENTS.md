# Agent iteration protocol fixture

This is a dedicated disposable protocol example, package `com.example.picofixture.iteration.debug` in debug builds. It is separate from every existing showcase and Mission Replay app. Do not install, launch, stop, clear data, or capture until the root has actual native ownership, emulator-start authority where needed, and an explicitly identified emulator. A connected headset is never a fallback.

The official CLI generated the planar scaffold. `Main.kt` keeps its `DefaultWindowContainer` and `PicoTheme`; `content/HomePage.kt` shows one panel and a transition counter using SpatialUI `Text`. All app-authored layout stays transparent over system glass. Material/Material3 components are forbidden. There are no interactive human input controls in this semantic fixture.

`src/debug/.../AgentInteractionBridge.kt` is generated from `emitAgentInteractionBridgeKt` in the MCP source. Keep those exact bytes synchronized. Android's app-private file permissions and `run-as` protect IPC; no receiver, service, provider, socket, reflection, arbitrary evaluator, or external-storage path participates. The debug package is a distinct installed identity. `src/release/.../FixtureBridge.kt` is inert and the release artifact must omit the debug implementation.

Use `./gradlew --offline --no-daemon -Dorg.gradle.java.installations.auto-download=false assembleDebug assembleRelease` only with already provisioned Gradle, JDK, Android SDK and Maven dependencies. Do not provision shared tooling to repair a missing prerequisite. Preserve the generated `local.properties` locally; it is ignored. Do not rerun scaffold creation without accounting for the CLI's observed implicit template refresh in `evidence/scaffold-observation.json`.

Runtime action, APK and frame identities belong to the root interaction session. An ACK proves only app semantics. Capture is independent, and a frame must be opened and judged before any visual claim. No data reset or automatic retry after uncertain mutation is authorized.
