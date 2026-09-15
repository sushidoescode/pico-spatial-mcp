# Spatial SDK 6.0.0 offline drift measurement

Measured on 2026-08-22 from the Gradle cache, without network access or dependency
resolution. The repository base was `main` at `259c2b5`. This document covers the seven
runtime/UI artifacts at 0.13.3 and 6.0.0, the Spatial Gradle plugin at 0.13.2 and 6.0.0,
and the four PICO Compose-fork artifacts at 1.0.1 and 1.0.5.

This is a static JAR/AAR measurement. It does not claim that an application was built, run,
or visually verified at 6.0.0.

## Measurement headline

- Seven SDK source JARs: **0 added, 0 removed, 48 content-differing** among **467**
  Kotlin/Java source entries.
- Seven-artifact public Kotlin API: **1 public type alias added**, with **0 types removed** and
  **0 type signatures changed**; **0 constructors** and **0 public enum entries** added, removed,
  or signature-changed; **2 public methods added** and **3 public method signatures changed**.
- Public-to-non-public or non-public-to-public visibility changes: **0**.
- Literal generator imports: **149 distinct**, comprising **120 types** and **29 top-level
  declarations**; **149 resolve at 6.0.0 and 0 do not**.
- Compose fork: **0 added, 0 removed, 5 content-differing** among **1,138** Kotlin/Java
  source entries; public Kotlin API delta is zero in every requested category.

### Material disagreement with the earlier headline

The earlier numerator, 48 differing files, is reproduced exactly. The earlier denominator,
507 files, is **not reproducible from these cached JARs**:

- 467 is the count of `.kt` and `.java` entries across the seven source JARs.
- 474 is the count of non-directory entries when each JAR's manifest is included.
- 599 is the count of every ZIP entry, including manifests and directory entries.

No combination of the measured source-JAR entry classes produces 507. This document therefore
uses **48 of 467 source files** and leaves the origin of 507 unresolved rather than reconciling
the counts silently.

The earlier claim of no added public types is also **not reproduced** when Kotlin type aliases
are included in the source API. UI design adds the implicit-public
`TextFieldFeedBackOptionAction` alias. A class-name-only ABI pass cannot see it because a type
alias creates no runtime class, but it is present in the 6.0.0 JAR's Kotlin metadata and is a
compile-time public API addition.

A further input discrepancy is also material: there is **no `-sources.jar` at either plugin
version** anywhere below the cached `com.pico.spatial.tools` group. The two plugin binary JARs
are present. Their 87 non-directory entries have identical names and decompressed bytes, so the
plugin source-level comparison is inconclusive while the binary and Kotlin-metadata comparisons
are conclusive.

## 1. Source-JAR file-set delta: SDK 0.13.3 to 6.0.0

Counts below include `.kt` and `.java` file entries and compare decompressed entry bytes. ZIP
timestamps and compression are deliberately irrelevant.

| Module | Old files | New files | Added | Removed | Content-differing |
| --- | ---: | ---: | ---: | ---: | ---: |
| `com.pico.spatial.core:core` | 195 | 195 | 0 | 0 | 20 |
| `com.pico.spatial.foundation:foundation` | 34 | 34 | 0 | 0 | 0 |
| `com.pico.spatial.sense:sense` | 16 | 16 | 0 | 0 | 0 |
| `com.pico.spatial.tracking:tracking` | 25 | 25 | 0 | 0 | 0 |
| `com.pico.spatial.ui:design` | 68 | 68 | 0 | 0 | 14 |
| `com.pico.spatial.ui:foundation` | 91 | 91 | 0 | 0 | 8 |
| `com.pico.spatial.ui:platform` | 38 | 38 | 0 | 0 | 6 |
| **Total** | **467** | **467** | **0** | **0** | **48** |

The 48 differing paths are:

```text
core (20)
com/pico/spatial/core/container/SpatialContainerManager.kt
com/pico/spatial/core/container/SpatialView.kt
com/pico/spatial/core/ecs/AnimationResourceLibraryComponent.kt
com/pico/spatial/core/ecs/AttachmentPanelComponent.kt
com/pico/spatial/core/ecs/AudioMixerGroupsComponent.kt
com/pico/spatial/core/ecs/AudioResourceLibraryComponent.kt
com/pico/spatial/core/ecs/CollisionComponent.kt
com/pico/spatial/core/ecs/DrawOrderGroupComponent.kt
com/pico/spatial/core/ecs/Entity.kt
com/pico/spatial/core/ecs/ImageBasedLightComponent.kt
com/pico/spatial/core/ecs/ModelComponent.kt
com/pico/spatial/core/ecs/StageEnvironmentLightingComponent.kt
com/pico/spatial/core/ecs/VideoComponent.kt
com/pico/spatial/core/ecs/VideoPlayerComponent.kt
com/pico/spatial/core/ecs/animation/AnimationTransitionMode.kt
com/pico/spatial/core/ecs/resource/AudioGroupResource.kt
com/pico/spatial/core/ecs/resource/PhysicallyBasedMaterial.kt
com/pico/spatial/core/ecs/resource/ShaderGraphMaterial.kt
com/pico/spatial/core/ecs/resource/UnlitMaterial.kt
com/pico/spatial/core/ecs/resource/VideoMaterial.kt

ui-design (14)
com/pico/spatial/ui/design/CheckBox.kt
com/pico/spatial/ui/design/Chips.kt
com/pico/spatial/ui/design/LinearProgressIndicator.kt
com/pico/spatial/ui/design/ScrollIndicator.kt
com/pico/spatial/ui/design/Slider.kt
com/pico/spatial/ui/design/Switch.kt
com/pico/spatial/ui/design/TextField.kt
com/pico/spatial/ui/design/Timepicker.kt
com/pico/spatial/ui/design/text/BasicTextFieldWrapper.kt
com/pico/spatial/ui/design/text/TextSelectionAndToolbarProvider.kt
com/pico/spatial/ui/design/tokens/MotionTokens.kt
com/pico/spatial/ui/design/windows/Snackbar.kt
com/pico/spatial/ui/design/windows/Subwindow.kt
com/pico/spatial/ui/design/windows/TabBar.kt

ui-foundation (8)
com/pico/spatial/ui/foundation/content/SpatialModelView.kt
com/pico/spatial/ui/foundation/content/SpatialView.kt
com/pico/spatial/ui/foundation/gesture/SpatialDragGestureDetector.kt
com/pico/spatial/ui/foundation/gesture/SpatialRotateGestureDetector.kt
com/pico/spatial/ui/foundation/gesture/SpatialScaleGestureDetector.kt
com/pico/spatial/ui/foundation/hover/SpatialMaterialHoverEffect.kt
com/pico/spatial/ui/foundation/window/SpatialDialogAsPopup.kt
spatialui/x/ui/window/AndroidDialog.android.kt

ui-platform (6)
com/pico/spatial/ui/platform/SpatialAudioEffectPlayerImpl.kt
com/pico/spatial/ui/platform/SpatialCompositionLocals.kt
com/pico/spatial/ui/platform/SpatialHandControllerHaptic.kt
com/pico/spatial/ui/platform/containers/SUIStage.kt
com/pico/spatial/ui/platform/containers/SUIWindowContainer.kt
com/pico/spatial/ui/platform/resize/WindowConstraintsModifier.kt
```

The plugin's two binary JARs contain 87 files apiece: **0 added, 0 removed, 0 differing**.
Their archive SHA-256 values differ because ZIP metadata differs, but all entry names and
decompressed entry bytes are identical.

Command producing the plugin entry comparison:

```sh
python3 - <<'PY'
from pathlib import Path
from zipfile import ZipFile

root = Path('/Users/sushantsrikrish/.gradle/caches/modules-2/files-2.1/com.pico.spatial.tools/com.pico.spatial.tools.gradle.plugin')
old = next((root / '0.13.2').glob('*/*.jar'))
new = next((root / '6.0.0').glob('*/*.jar'))
with ZipFile(old) as left, ZipFile(new) as right:
    a = {item.filename: left.read(item) for item in left.infolist() if not item.is_dir()}
    b = {item.filename: right.read(item) for item in right.infolist() if not item.is_dir()}
common = a.keys() & b.keys()
print('old', len(a), 'new', len(b),
      'added', len(b.keys() - a.keys()), 'removed', len(a.keys() - b.keys()),
      'differing', sum(a[path] != b[path] for path in common))
PY
```

Command producing the SDK and Compose file-set counts and hashes:

```sh
python3 /private/tmp/pico_sdk6_source_diff.py
```

The helper SHA-256 was
`e5584f9eafe98c6f39dc7c5d55478b41f3290703ebecb30c427507e940002aff`. It selected exactly
one non-sample source JAR per coordinate/version, excluded directories and
`META-INF/MANIFEST.MF`, keyed remaining entries by ZIP path, and compared decompressed bytes.
The code-file denominator was checked separately with:

```sh
python3 - <<'PY'
from pathlib import Path
from zipfile import ZipFile

cache = Path('/Users/sushantsrikrish/.gradle/caches/modules-2/files-2.1')
modules = [
    ('com.pico.spatial.core', 'core'),
    ('com.pico.spatial.foundation', 'foundation'),
    ('com.pico.spatial.sense', 'sense'),
    ('com.pico.spatial.tracking', 'tracking'),
    ('com.pico.spatial.ui', 'design'),
    ('com.pico.spatial.ui', 'foundation'),
    ('com.pico.spatial.ui', 'platform'),
]
for group, artifact in modules:
    jar = next((cache / group / artifact / '0.13.3').glob('*/*-sources.jar'))
    with ZipFile(jar) as archive:
        code = [item for item in archive.infolist()
                if not item.is_dir() and item.filename.endswith(('.kt', '.java'))]
        files = [item for item in archive.infolist() if not item.is_dir()]
        print(group, artifact, 'code', len(code),
              'non-directory', len(files), 'all-entries', len(archive.infolist()))
PY
```

## 2. Public API surface delta

The API census reads `classes.jar` from each AAR and Kotlin metadata from every class. It counts
source-visible `public` and `protected` Kotlin classes, interfaces, objects, type aliases,
constructors, functions, properties, and enum entries, including property accessors as methods.
It excludes `internal` declarations, private declarations, generated `R`/`BuildConfig` classes,
lambdas, synthetic accessors, and obfuscator-name churn. A method signature change below means
the same owner and Kotlin source name had one old JVM descriptor replaced by one new descriptor;
type-alias signatures compare their metadata underlying and expanded types.

| Module | Public types old/new | Constructors old/new | Methods old/new | Enum entries old/new | Delta |
| --- | ---: | ---: | ---: | ---: | --- |
| core | 276/276 | 118/118 | 1,315/1,315 | 227/227 | none |
| foundation | 41/41 | 43/43 | 349/349 | 4/4 | none |
| sense | 19/19 | 1/1 | 62/62 | 45/45 | none |
| tracking | 49/49 | 23/23 | 196/196 | 87/87 | none |
| UI design | 122/123 | 23/23 | 798/798 | 13/13 | 1 public type alias added |
| UI foundation | 79/79 | 23/23 | 370/371 | 38/38 | 1 method added; 3 signatures changed |
| UI platform | 62/62 | 13/13 | 133/134 | 46/46 | 1 method added |
| **Total** | **648/649** | **244/244** | **3,223/3,225** | **460/460** | **1 type alias and 2 methods added; 3 method signatures changed** |

Requested category totals, expressed as added / removed / signature-changed:

| Category | Added | Removed | Signature-changed |
| --- | ---: | ---: | ---: |
| Public types, including type aliases | 1 | 0 | 0 |
| Public constructors | 0 | 0 | 0 |
| Public methods | 2 | 0 | 3 |
| Public enum entries | 0 | 0 | 0 |

Every non-zero public API delta is named below.

### Added public type

The one added public type is the compile-time-only alias:

```kotlin
com.pico.spatial.ui.design.text.TextFieldFeedBackOptionAction =
    (TextFieldFeedBackOption) -> Unit
```

It is declared with implicit public visibility and `@OptIn(InternalSpatialUIApi::class)`. The
opt-in annotation does not make the alias `internal`.

### Added public methods

1. New overload:

   ```kotlin
   com.pico.spatial.ui.foundation.content.SpatialModelView(
       source: Source<*>,
       modifier: Modifier = Modifier,
       resizability: Resizability = Resizability.None,
       onLoad: (() -> Unit)? = null,
       onError: ((String) -> Unit)? = null,
       onSuccess: ((LoadedModel) -> Unit)? = null,
       content: @Composable SpatialModelScope.() -> Unit = {},
   )
   ```

2. `com.pico.spatial.ui.platform.HandControllerHapticType.toString(): String`.

### Signature-changed public methods

1. `detectSpatialDragGesture`: `onDragStart` changed from `(Offset3D) -> Unit` to
   `(Offset3D, SpatialDragValue) -> Unit`; `onDragEnd` and `onDragCancel` changed from
   `() -> Unit` to `(SpatialDragValue) -> Unit`.
2. `detectSpatialRotateGesture`: `onRotateStart`, `onRotateEnd`, and `onRotateCancel` each
   changed from `() -> Unit` to `(SpatialRotateValue) -> Unit`.
3. `detectSpatialScaleGesture`: `onScaleStart`, `onScaleEnd`, and `onScaleCancel` each changed
   from `() -> Unit` to `(SpatialScaleValue) -> Unit`.

The raw JVM descriptor set consequently has 5 additions and 3 removals. Pairing the three
same-owner/same-name replacements yields the disjoint result above: 2 added methods and 3
signature changes.

The plugin binary has 45 public Kotlin types, 21 constructors, 167 methods, and 8 enum entries
at both 0.13.2 and 6.0.0, with zero deltas.

### Why raw `ACC_PUBLIC` is not the public Kotlin API

A second classfile pass intentionally ignored Kotlin metadata. In core alone it reported 3
apparently public types added, 12 constructors added and 12 removed, 74 methods added and 58
removed, and 6 enum constants added. The type/enum additions are
`SpatialViewLifecycleObserver`, `SpatialViewHostLifecycleEvent` and its six entries, plus the
synthetic obfuscated class `com/pico/spatial/core/container/e1`. The source JAR declares the
first two types `internal`; the remaining constructor/method churn is dominated by internal,
synthetic, and obfuscator-renamed implementation classes. Kotlin compiles `internal`
declarations to JVM-public bytecode, so access flags alone overstate the supported Kotlin API.
Conversely, a raw access-flag pass cannot see `TextFieldFeedBackOptionAction` because a Kotlin
type alias has no classfile of its own; its file-facade metadata carries the declaration. No raw
candidate was silently promoted into the headline, and no metadata declaration was silently
dropped from it.

Commands producing the Kotlin-metadata API census:

```sh
'/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/javac' \
  -cp '/Applications/Android Studio.app/Contents/plugins/Kotlin/kotlinc.ide/lib/kotlin-metadata-jvm.jar:/Applications/Android Studio.app/Contents/plugins/Kotlin/kotlinc.ide/lib/kotlin-stdlib.jar:/Applications/Android Studio.app/Contents/plugins/android/lib/asm-9.6.jar' \
  -d /private/tmp /private/tmp/KotlinApiDump.java
python3 /private/tmp/kotlin_api_compare.py
```

Helper SHA-256 values:

- `KotlinApiDump.java`:
  `cc2dbd4e18d3b7539eefb96d2963734d708025333cd17a105857b82eee8b2143`
- `kotlin_api_compare.py`:
  `41fdd42b82c4ba7524fc63ddadfc5ce3728efb8f8415966a5c85346a6d9ca266`
- raw classfile cross-check `pico_sdk6_api_diff.py`:
  `ed7824deb88e0ca166cb422d04dacf13c0aa0da3a66840093200dccc6c7bbabc`

The raw cross-check command was:

```sh
python3 /private/tmp/pico_sdk6_api_diff.py --summary
```

## 3. Public visibility changes

**0 public visibility changes in either direction.** No type, constructor, method, property
getter, or property setter common to the two versions changed from public/protected to another
Kotlin visibility, or from another Kotlin visibility to public/protected. The same result holds
for the plugin and all four Compose-fork artifacts.

This count is emitted as `public_visibility_changes` by the same metadata command in section 2.
The independent access-flag cross-check also reports zero public visibility transitions.

## 4. Design-token, resource, constant, and default-value changes

These changes are a visual-regression risk for golden frames captured at 0.13.3. Source-only
comparison is insufficient here: the standard Bézier change exists in the AAR resource table
without changing `MotionTokens.kt`.

### Visual and interaction constants

| Symbol or use | 0.13.3 | 6.0.0 |
| --- | --- | --- |
| `MotionTokens.bezierEasingStandard` resource tuple | `(0.3, 0.2, 0, 1)` | `(0.3, 0, 0.2, 1)` |
| `MotionTokens.durationMedium4` | 480 ms | 1,000 ms |
| `SnackbarDefaults.BottomOffset` | 64 dp | 80 dp |
| `SubwindowDefaults.CornerRadius` | 16 dp | 32 dp |
| Tab-bar expanded-height animation duration | `durationMedium2` = 360 ms | `durationMedium3` = 420 ms |
| Tab-bar container-hover active-height duration | 360 ms | 420 ms |
| Tab-bar expanded-content hover alpha duration | 360 ms | 420 ms |
| Tab-bar item background-alpha duration | 360 ms | 420 ms |
| Tab-bar item clip/size duration | 360 ms | 420 ms |
| Tab-bar support-content alpha duration | 360 ms | 420 ms |
| `TabBarDefaults.HoverDelayMillis` (aliases `durationMedium4`) | 480 ms | 1,000 ms |
| `TabBarDefaults.ExpandedAlphaShowDelayMillis` | 680 ms | 1,200 ms |
| `TabBarDefaults.ExpandedAlphaHideDelayMillis` | 280 ms | 800 ms |
| `WheelPickerDefaults.StepLevel` | absent | 70 |
| `WheelPickerDefaults.StepFrequency` | absent | 240 |
| `WheelPickerDefaults.StepDuration` | absent | 1 ms |
| Internal `materialSpatialHoverEffect` default material | `Material.Thickest` | `Material.Regular` |

The three new wheel-picker constants form a new internal default step haptic
`HandControllerHapticType.custom(70, 240, 1)`. A caller-supplied non-default step haptic still
wins. This is interaction drift rather than a golden-frame change, but it is a real added
constant and is included rather than omitted.

The hover-material default is an internal declaration currently referenced only inside its own
source JAR, but changing from the thickest material to regular can change hover rendering and is
therefore included in the visual-risk inventory.

### Public default-value changes not represented in JVM descriptors

`WindowContainerConstraintsScope.windowConstraints` changed all six defaults:

| Parameter | 0.13.3 | 6.0.0 |
| --- | --- | --- |
| `minWidth` | `Dp.Unspecified` | `Dp.Hairline` |
| `minHeight` | `Dp.Unspecified` | `Dp.Hairline` |
| `minDepth` | `Dp.Unspecified` | `Dp.Hairline` |
| `maxWidth` | `Dp.Unspecified` | `Dp.Infinity` |
| `maxHeight` | `Dp.Unspecified` | `Dp.Infinity` |
| `maxDepth` | `Dp.Unspecified` | `Dp.Infinity` |

The implementation also adds a precondition that maximum width/height must be at least their
minimum and minimum width/height must be non-negative. Default argument values are not encoded
as a changed JVM method descriptor, so this source-level behavioral change supplements section 2.

### Non-visual constants and generated version metadata

- Private `FakeEntityId`: absent -> `100L`; it is used by the non-spatial composition-local
  audio player.
- The generated `BuildConfig.LIBRARY_VERSION_NAME` in core, non-UI foundation, sense, and
  tracking: `0.13.3` -> `6.0.0`. The three UI AARs do not carry that changed field. This is
  expected build metadata, not design behavior.

No other named Android resource value changes were found across the seven AARs. The complete
resource-table comparison found exactly 2 changes, both in UI design: the standard Bézier tuple
and `durationMedium4` listed above.

Commands producing the constant/resource measurements:

```sh
python3 - <<'PY'
from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree as ET

cache = Path('/Users/sushantsrikrish/.gradle/caches/modules-2/files-2.1')
modules = [
    ('com.pico.spatial.core', 'core'),
    ('com.pico.spatial.foundation', 'foundation'),
    ('com.pico.spatial.sense', 'sense'),
    ('com.pico.spatial.tracking', 'tracking'),
    ('com.pico.spatial.ui', 'design'),
    ('com.pico.spatial.ui', 'foundation'),
    ('com.pico.spatial.ui', 'platform'),
]

def values(group, artifact, version):
    aar = next((cache / group / artifact / version).glob('*/*.aar'))
    found = {}
    with ZipFile(aar) as archive:
        for path in archive.namelist():
            if not path.startswith('res/values') or not path.endswith('.xml'):
                continue
            root = ET.fromstring(archive.read(path))
            for node in root:
                name = node.attrib.get('name')
                if name:
                    found[(path, node.tag, name)] = (
                        dict(node.attrib), ''.join(node.itertext()).strip())
    return found

for group, artifact in modules:
    old, new = values(group, artifact, '0.13.3'), values(group, artifact, '6.0.0')
    changed = sorted(key for key in old.keys() & new.keys() if old[key] != new[key])
    print(group, artifact, 'added', len(new.keys() - old.keys()),
          'removed', len(old.keys() - new.keys()), 'changed', len(changed))
    for key in changed:
        print(key, old[key], '->', new[key])
PY
```

Source constants and default arguments were enumerated from all 48 unified source diffs with:

```sh
python3 /private/tmp/pico_sdk6_source_diff.py
python3 - <<'PY'
from difflib import unified_diff
from pathlib import Path
from zipfile import ZipFile

cache = Path('/Users/sushantsrikrish/.gradle/caches/modules-2/files-2.1')
modules = [
    ('com.pico.spatial.core', 'core'),
    ('com.pico.spatial.foundation', 'foundation'),
    ('com.pico.spatial.sense', 'sense'),
    ('com.pico.spatial.tracking', 'tracking'),
    ('com.pico.spatial.ui', 'design'),
    ('com.pico.spatial.ui', 'foundation'),
    ('com.pico.spatial.ui', 'platform'),
]
for group, artifact in modules:
    old = next((cache / group / artifact / '0.13.3').glob('*/*-sources.jar'))
    new = next((cache / group / artifact / '6.0.0').glob('*/*-sources.jar'))
    with ZipFile(old) as left, ZipFile(new) as right:
        for path in sorted(set(left.namelist()) & set(right.namelist())):
            if not path.endswith(('.kt', '.java')) or left.read(path) == right.read(path):
                continue
            print(group, artifact, path)
            print('\n'.join(unified_diff(
                left.read(path).decode(errors='replace').splitlines(),
                right.read(path).decode(errors='replace').splitlines(),
                fromfile='old', tofile='new', n=3,
            )))
PY
unzip -p /Users/sushantsrikrish/.gradle/caches/modules-2/files-2.1/com.pico.spatial.ui/design/0.13.3/9f13712e8fbbf8e3961b6c13afcf83c56f298934/design-0.13.3.aar res/values/values.xml | rg 'pico_sys_motion'
unzip -p /Users/sushantsrikrish/.gradle/caches/modules-2/files-2.1/com.pico.spatial.ui/design/6.0.0/c093dd1b7d10bcf7430c2038849ec5e33de48e18/design-6.0.0.aar res/values/values.xml | rg 'pico_sys_motion'
```

## 5. Generator-emitted `com.pico.spatial.*` imports

The literal import census scans `src/` and `appskeleton/`, the repository's generator and
verbatim skeleton inputs. It excludes the explanatory placeholder `import com.pico.spatial...`
in `src/vault.ts` and found no dynamically assembled `com.pico.spatial.*` import FQNs. There are
**149 distinct imports: 120 types and 29 top-level declarations**. Namespace totals are core 87,
sense 9, tracking 6, and UI 47. Every one resolves in the seven 6.0.0 AAR/source-JAR pairs;
unresolved count: **0**.

Resolution means either an exact class exists in an AAR's nested `classes.jar`, or a public
top-level source declaration exists and its JVM file-facade class exists. Multiple legitimate
overloads count as one resolved import. In particular, `spatialHoverEffect` has two public
overloads, and the inline generic `registerSystem`/`unregisterSystem` declarations both resolve.

Every import and its measured result follows; `yes` applies to every line.

```text
com.pico.spatial.core.container.SpatialViewContent  yes
com.pico.spatial.core.ecs.AnchorComponent  yes
com.pico.spatial.core.ecs.AttachmentPanelComponent  yes
com.pico.spatial.core.ecs.CollisionComponent  yes
com.pico.spatial.core.ecs.Component  yes
com.pico.spatial.core.ecs.DirectionalLightComponent  yes
com.pico.spatial.core.ecs.DrawOrderGroup  yes
com.pico.spatial.core.ecs.DrawOrderGroupComponent  yes
com.pico.spatial.core.ecs.Entity  yes
com.pico.spatial.core.ecs.EntityQueryCondition  yes
com.pico.spatial.core.ecs.EnvironmentLightingSettingsComponent  yes
com.pico.spatial.core.ecs.GaussianSplattingComponent  yes
com.pico.spatial.core.ecs.GroundShadowComponent  yes
com.pico.spatial.core.ecs.ImageBasedLightComponent  yes
com.pico.spatial.core.ecs.ImageBasedLightReceiverComponent  yes
com.pico.spatial.core.ecs.ImageBasedLightSource  yes
com.pico.spatial.core.ecs.InteractableComponent  yes
com.pico.spatial.core.ecs.LoadType  yes
com.pico.spatial.core.ecs.LookAtComponent  yes
com.pico.spatial.core.ecs.LookAtForwardDirection  yes
com.pico.spatial.core.ecs.ModelComponent  yes
com.pico.spatial.core.ecs.ObjectAudioComponent  yes
com.pico.spatial.core.ecs.OpacityControllerComponent  yes
com.pico.spatial.core.ecs.ParticleComponent  yes
com.pico.spatial.core.ecs.PhysicsForceComponent  yes
com.pico.spatial.core.ecs.PhysicsVelocityComponent  yes
com.pico.spatial.core.ecs.PhysicsWorldComponent  yes
com.pico.spatial.core.ecs.PointLightComponent  yes
com.pico.spatial.core.ecs.PortalComponent  yes
com.pico.spatial.core.ecs.PortalWorldComponent  yes
com.pico.spatial.core.ecs.RigidBodyComponent  yes
com.pico.spatial.core.ecs.Scene  yes
com.pico.spatial.core.ecs.SceneUpdateContext  yes
com.pico.spatial.core.ecs.SpotLightComponent  yes
com.pico.spatial.core.ecs.StageEnvironmentLightingComponent  yes
com.pico.spatial.core.ecs.System  yes
com.pico.spatial.core.ecs.TransformComponent  yes
com.pico.spatial.core.ecs.VideoPlayerComponent  yes
com.pico.spatial.core.ecs.anchor.AnchorTarget  yes
com.pico.spatial.core.ecs.animation.AnimationBindTarget  yes
com.pico.spatial.core.ecs.animation.AnimationPlayConfig  yes
com.pico.spatial.core.ecs.animation.AnimationPlaybackController  yes
com.pico.spatial.core.ecs.animation.EaseType  yes
com.pico.spatial.core.ecs.animation.MaterialTarget  yes
com.pico.spatial.core.ecs.animation.OrbitAnimation  yes
com.pico.spatial.core.ecs.animation.RepeatMode  yes
com.pico.spatial.core.ecs.animation.SpatialAnimation  yes
com.pico.spatial.core.ecs.animation.TweenAnimation  yes
com.pico.spatial.core.ecs.audio.AudioPlayerController  yes
com.pico.spatial.core.ecs.event.AnimationEvents  yes
com.pico.spatial.core.ecs.event.AudioEvents  yes
com.pico.spatial.core.ecs.event.CollisionEvents  yes
com.pico.spatial.core.ecs.light.ShadowProjectionType  yes
com.pico.spatial.core.ecs.particle.ParticleColorVaryingProperty  yes
com.pico.spatial.core.ecs.particle.ParticleVaryingPropertyType  yes
com.pico.spatial.core.ecs.resource.AnimationResource  yes
com.pico.spatial.core.ecs.resource.AssetBundle  yes
com.pico.spatial.core.ecs.resource.BlendingMode  yes
com.pico.spatial.core.ecs.resource.GaussianSplattingResource  yes
com.pico.spatial.core.ecs.resource.MaterialCullingMode  yes
com.pico.spatial.core.ecs.resource.MeshResource  yes
com.pico.spatial.core.ecs.resource.PhysicallyBasedMaterial  yes
com.pico.spatial.core.ecs.resource.PhysicsMaterialResource  yes
com.pico.spatial.core.ecs.resource.PortalMaterial  yes
com.pico.spatial.core.ecs.resource.ShapeResource  yes
com.pico.spatial.core.ecs.resource.TextureResource  yes
com.pico.spatial.core.ecs.resource.UnlitMaterial  yes
com.pico.spatial.core.ecs.resource.VideoMaterial  yes
com.pico.spatial.core.ecs.simulation.CollisionCastHitMode  yes
com.pico.spatial.core.ecs.simulation.CollisionCastResult  yes
com.pico.spatial.core.ecs.simulation.CollisionFilter  yes
com.pico.spatial.core.ecs.simulation.CollisionGroup  yes
com.pico.spatial.core.ecs.simulation.CollisionInfoDetailLevel  yes
com.pico.spatial.core.ecs.simulation.CollisionResponseMode  yes
com.pico.spatial.core.ecs.simulation.MassProperties  yes
com.pico.spatial.core.ecs.simulation.RigidBodyMode  yes
com.pico.spatial.core.ecs.video.CypressMediaPlayer  yes
com.pico.spatial.core.ecs.video.CypressMediaPlayerCallback  yes
com.pico.spatial.core.ecs.video.CypressMediaPlayerErrorCode  yes
com.pico.spatial.core.ecs.video.DisplayMode  yes
com.pico.spatial.core.ecs.video.VideoDimensionMode  yes
com.pico.spatial.core.lifecycle.Cancellable  yes
com.pico.spatial.core.math.Color4  yes
com.pico.spatial.core.math.EulerAngles  yes
com.pico.spatial.core.math.Quat  yes
com.pico.spatial.core.math.Transform  yes
com.pico.spatial.core.math.Vector3  yes
com.pico.spatial.sense.base.AnchorUpdate  yes
com.pico.spatial.sense.base.SemanticLabelType  yes
com.pico.spatial.sense.mesh.MeshAnchor  yes
com.pico.spatial.sense.mesh.MeshTrackingManager  yes
com.pico.spatial.sense.plane.PlaneAnchor  yes
com.pico.spatial.sense.plane.PlaneTrackingManager  yes
com.pico.spatial.sense.world.WorldAnchor  yes
com.pico.spatial.sense.world.WorldTrackingManager  yes
com.pico.spatial.sense.world.WorldTrackingResult  yes
com.pico.spatial.tracking.DataProvider  yes
com.pico.spatial.tracking.hand.HandJoint  yes
com.pico.spatial.tracking.hand.HandPose  yes
com.pico.spatial.tracking.hand.HandTrackingData  yes
com.pico.spatial.tracking.hand.HandTrackingProvider  yes
com.pico.spatial.tracking.hmd.HMDTrackingProvider  yes
com.pico.spatial.ui.design.Button  yes
com.pico.spatial.ui.design.PicoTheme  yes
com.pico.spatial.ui.design.SegmentControl  yes
com.pico.spatial.ui.design.SegmentItem  yes
com.pico.spatial.ui.design.SideNavigation  yes
com.pico.spatial.ui.design.SideNavigationItem  yes
com.pico.spatial.ui.design.Text  yes
com.pico.spatial.ui.design.TitleBar  yes
com.pico.spatial.ui.design.windows.CoachmarkBox  yes
com.pico.spatial.ui.design.windows.Sheet  yes
com.pico.spatial.ui.design.windows.SimpleCoachmark  yes
com.pico.spatial.ui.design.windows.SnackbarHost  yes
com.pico.spatial.ui.design.windows.Subwindow  yes
com.pico.spatial.ui.design.windows.SubwindowPlacement  yes
com.pico.spatial.ui.design.windows.TabBar  yes
com.pico.spatial.ui.design.windows.Toolbar  yes
com.pico.spatial.ui.foundation.content.AttachmentPanelBuilder  yes
com.pico.spatial.ui.foundation.content.SpatialView  yes
com.pico.spatial.ui.foundation.content.SpatialViewAttachments  yes
com.pico.spatial.ui.foundation.content.panelSize  yes
com.pico.spatial.ui.foundation.dsl.DefaultStage  yes
com.pico.spatial.ui.foundation.dsl.DefaultWindowContainer  yes
com.pico.spatial.ui.foundation.dsl.Form  yes
com.pico.spatial.ui.foundation.dsl.Immersion  yes
com.pico.spatial.ui.foundation.dsl.SpatialAppScope  yes
com.pico.spatial.ui.foundation.dsl.Stage  yes
com.pico.spatial.ui.foundation.dsl.WindowContainer  yes
com.pico.spatial.ui.foundation.dsl.WindowContainerSize  yes
com.pico.spatial.ui.foundation.dsl.launch  yes
com.pico.spatial.ui.foundation.dsl.registerSystem  yes
com.pico.spatial.ui.foundation.dsl.unregisterSystem  yes
com.pico.spatial.ui.foundation.gesture.SpatialDragValue  yes
com.pico.spatial.ui.foundation.gesture.SpatialScaleValue  yes
com.pico.spatial.ui.foundation.gesture.TargetEntity  yes
com.pico.spatial.ui.foundation.gesture.detectSpatialDragGesture  yes
com.pico.spatial.ui.foundation.gesture.detectSpatialScaleGesture  yes
com.pico.spatial.ui.foundation.gesture.detectSpatialTapGesture  yes
com.pico.spatial.ui.foundation.hover.spatialHoverEffect  yes
com.pico.spatial.ui.foundation.material.backgroundMaterial  yes
com.pico.spatial.ui.platform.LengthUnit  yes
com.pico.spatial.ui.platform.LocalPhysicalLengthConverter  yes
com.pico.spatial.ui.platform.Material  yes
com.pico.spatial.ui.platform.ViewPoint  yes
com.pico.spatial.ui.platform.containers.LocalSpatialNavigator  yes
com.pico.spatial.ui.platform.containers.StageStyle  yes
com.pico.spatial.ui.platform.resize.ContainerResizeType  yes
com.pico.spatial.ui.platform.stub.SpatialLaunchActivity  yes
```

Commands producing the import count and resolution table:

```sh
rg -o --no-filename --pcre2 'import\s+com\.pico\.spatial\.[A-Za-z0-9_.]+' \
  src appskeleton -g '*.{ts,tsx,js,mjs,kt,kts}' \
  | sed -E 's/^import[[:space:]]+//' \
  | rg -v '\.\.\.$' \
  | sort -u \
  | wc -l
python3 /private/tmp/generator_import_check.py
```

The resolution helper SHA-256 was
`93024861309423f2b7a2d14cfe38d20fc8b1972b418370910aae9af9997e3ec5`. Its output headline
was `distinct_imports 149`, `resolution_counts {'class': 120, 'top-level': 29}`, and
`unresolved 0`.

## 6. Compose fork: 1.0.1 to 1.0.5

The PICO Compose fork is a separate version axis. Source-code counts and deltas are:

| Artifact | Kotlin/Java files old/new | Added | Removed | Content-differing |
| --- | ---: | ---: | ---: | ---: |
| `com.pico.spatial.ui.foundation:foundation-android` | 444/444 | 0 | 0 | 1 |
| `com.pico.spatial.ui:ui-android` | 405/405 | 0 | 0 | 4 |
| `com.pico.spatial.ui:ui-graphics-android` | 127/127 | 0 | 0 | 0 |
| `com.pico.spatial.ui:ui-text-android` | 162/162 | 0 | 0 | 0 |
| **Total** | **1,138/1,138** | **0** | **0** | **5** |

The corresponding source-JAR payload count is 1,151 entries after excluding manifests but
including 13 unchanged license/documentation files; including manifests gives 1,155
non-directory entries. The five differences are all code files:

1. `commonMain/androidx/compose/foundation/ScrollableArea.kt`: calls
   `spatialClipScrollableContainer(orientation)` instead of
   `clipScrollableContainer(orientation)`.
2. `androidMain/androidx/compose/ui/input/pointer/PointerInteropFilter.android.kt`: retains a
   faithful copy of the last dispatched `MotionEvent` for cancellation, recycles it on reset,
   and resets a stuck non-dispatching state on a primary down after hover.
3. `androidMain/com/pico/spatial/ui/input/pointer/MotionEventAdapterExt.kt`: spatial pointer
   recognition changes from `viewZRenderNodeId != -1L` to `viewZRenderNodeId > 0`.
4. `commonMain/androidx/compose/ui/node/NodeCoordinator.kt`: factors hover-bound testing into a
   shared helper and applies it to both layer-bound and measured-bound checks.
5. `commonMain/com/pico/spatial/ui/input/pointer/SpatialHitPathBuilder.kt`: always delegates to
   `coordinator?.hitTestChild(...)` instead of branching through wrapped-coordinator `hitTest`.

Public Kotlin API counts and signatures are stable at the metadata level:

| Artifact | Types | Constructors | Methods | Enum entries | Added / removed / signature-changed / visibility-changed |
| --- | ---: | ---: | ---: | ---: | --- |
| foundation-android | 286 | 93 | 1,104 | 28 | 0 / 0 / 0 / 0 |
| ui-android | 384 | 114 | 2,252 | 89 | 0 / 0 / 0 / 0 |
| ui-graphics-android | 164 | 77 | 1,222 | 17 | 0 / 0 / 0 / 0 |
| ui-text-android | 165 | 104 | 950 | 2 | 0 / 0 / 0 / 0 |
| **Total** | **999** | **388** | **5,528** | **136** | **0 / 0 / 0 / 0** |

A raw access-flag pass sees three new synthetic accessors in the anonymous pointer-filter
implementation: getters for `lastMotionEventDispatchedToView` and `state`, and a setter for
`lastMotionEventDispatchedToView`. Kotlin metadata correctly excludes these compiler accessors
from the public API result.

The four cached `*-samples-sources.jar` classifiers are raw byte-identical between 1.0.1 and
1.0.5 as well: foundation
`9fd144f7c59ee978a98116543c8fdbb9b102b2c914c9cb5ddc322247a283837d`, UI
`a9d6d014e1454d104cc75c626df3ddd9410411e7f2b3f4b612fceb050b83189b`, graphics
`0dbc8738f9a1e834102db02aa7aef15bacec4d5793f41a19ae18284192371bf8`, and text
`ec2ad05e7b9716d4a4c2d06bc4f5bc1476849cdf6bafa28c10956137620f65ac`.

The exact source and API commands are the same `pico_sdk6_source_diff.py` and
`kotlin_api_compare.py` commands shown in sections 1 and 2; both include the four Compose pairs.
The 1,138-code-file denominator was produced with:

```sh
python3 - <<'PY'
from pathlib import Path
from zipfile import ZipFile

cache = Path('/Users/sushantsrikrish/.gradle/caches/modules-2/files-2.1')
modules = [
    ('com.pico.spatial.ui.foundation', 'foundation-android'),
    ('com.pico.spatial.ui', 'ui-android'),
    ('com.pico.spatial.ui', 'ui-graphics-android'),
    ('com.pico.spatial.ui', 'ui-text-android'),
]
total = 0
for group, artifact in modules:
    jars = [path for path in (cache / group / artifact / '1.0.1').glob('*/*-sources.jar')
            if '-samples-sources.jar' not in path.name]
    assert len(jars) == 1, jars
    with ZipFile(jars[0]) as archive:
        count = sum(not item.is_dir() and item.filename.endswith(('.kt', '.java'))
                    for item in archive.infolist())
    total += count
    print(group, artifact, count)
print('total', total)
PY
```

## Artifact identity

All artifacts were selected from
`/Users/sushantsrikrish/.gradle/caches/modules-2/files-2.1`. Full SHA-256 identities follow.

| Coordinate / version | Binary SHA-256 | Sources SHA-256 |
| --- | --- | --- |
| core 0.13.3 | `29b5ec6bdc85238d61914990fdafd2d00b535bf49bc2d018a08ff17f3071dcd0` | `de171b86b33c5638cdc7bd7a0cd6b5fce82c29bfbef1549d2456477a48c72ce7` |
| core 6.0.0 | `92bc5d19b048d9c083681e550e86dc6aaafddf75731a4989f5a8e8165d3db5df` | `71cb6d8be8b3444e522961f7038e731ad6bb5566d505d73839eae19fa5a51aa2` |
| foundation 0.13.3 | `6c96633205376a6b4945e8fdb18364ca6b034552dfb445c3af4b6e9fabe47430` | `4d4bc119a4dfd4feaaeef87322ceaa5a6b698c578912362e75a6e26f19becf91` |
| foundation 6.0.0 | `d9fbaf37a7f238885fe98be3e7c622f411a9cfc4d657a19d1bd900e39fef5a8e` | `28d68f7bb36e9d738e2629769d6a6e12bd73174b98d3928a5ca1b7c1b41290b3` |
| sense 0.13.3 | `ac745e7b58d42a91d301f65e1c2a4b07836d49c08fe6b1f4a273e2b287454be1` | `89d092165a479510ed073e4e98c4cc5d6e231d05b42fcaa5e44d9b430458d159` |
| sense 6.0.0 | `fea45c98a36d6fd4e85a730d1dfb653694d402f679c2b966a98c28483c56f1b4` | `ceb4138161b01c2700e72310e32a4201fb077b2aa60b4bee53d525ead851796f` |
| tracking 0.13.3 | `d69521109891348efa727b0411443026bcae6fbd84b500257b62f7438dbdba89` | `68b40f02fdd33baf8288ea9bf210c3e6d0dd2cc126dbbe9d81f47c9bfe15a9a1` |
| tracking 6.0.0 | `0f8e14e34fb9bee4a08b23d8241ac05cf0e6aa2d57cf51ff8bf4b8b7d7920423` | `e6371e5b2ff5d3cd297ebcffca6c9d50722726e5dc52ee4fa2779334d01ed9e1` |
| UI design 0.13.3 | `b3ac0b83e5819953dee2a8122c5dbf901e121b9f056e30255d60742812a0c8d4` | `60a3afc702f505979dbe6cc7bafcf6d41f84e77f19b1ef12c1e9b5c2890a3239` |
| UI design 6.0.0 | `24ec1f9990eecf936d518a83084e5c8acc86d65cdc808c869df4a911a4803a70` | `4d7b785239ac4a2be81fb4d865dccc879f9a0db2a1a10ef3ef493154ff1d6b43` |
| UI foundation 0.13.3 | `b8a380781089e032d3eae64c9063376690eda0b8db98039c0d8683f12db609e5` | `a0bd3d9f0ac316a21f7f0a3f16d083965da2d260ea81c9e1417264b38216f3c3` |
| UI foundation 6.0.0 | `ad0415f66a41469e706e618e352a4d97ffe40dc18e7f66152196a842f47d07d5` | `431887298abaa2fd5b292c7038cb3047a33bf6db2b8c28d2a489d2d1098bd368` |
| UI platform 0.13.3 | `a35437feb1b765b3f0e85309503403bd2b985ea00a1c55842097b06dfe4a0ce3` | `ecdb5db59aa77d7795ecac7323642f5746df34bc33082f675adfb899762e4a41` |
| UI platform 6.0.0 | `895cdc14512581535f137b6312b7c278576e972c45a6cf61f8fbd13ff87ab94a` | `0ad2cec41fd6932df4ea6c6598b4c3e5fcfc041e56a1c02a6104772c663ea41a` |
| Gradle plugin 0.13.2 | `0a7c8ba534ccaa2b9d607e324ff48827a2f974ad7668449297d3620d1816b7ef` | **not present** |
| Gradle plugin 6.0.0 | `ba0f9577da5d7ce0a8ddd9bd06901bc5a90b5e8676fda6cd42485702026a85d6` | **not present** |
| Compose foundation-android 1.0.1 | `9527177417e9784b6c0d38a1c205bb9020b93db31338bd577f09e6f7d0befe3d` | `9c51c1230f451e6b345f260db595a7e4c0ae6c7f5f495fe60a5fc71688c19247` |
| Compose foundation-android 1.0.5 | `952a158ff7c548432cb3f7f0513b250d1a3a5d4aee9ca1743d510afd3a6d4175` | `7a12021d9fdf0806c9e7c40709890f12f70f14b30611f7ee4103a2d448fd7ff9` |
| Compose ui-android 1.0.1 | `35e3ab768b660a6467ca392cc787c11c7561fb825a26e6c55c9d23965e71eccd` | `83229d4178ef6b3602f70e7655c0b4fab8b0c73b74bd3bda0cedbfa3bf98f154` |
| Compose ui-android 1.0.5 | `b81214b88c1d9200bbefdf855ec8595eea44223b492a9b483d1e426a77f524ca` | `b814451f18cfcaafd69a2f0e542b08c482ca5420464fd65d0f5d51db082c39fb` |
| Compose ui-graphics-android 1.0.1 | `01ceefbbdc4a5bb305256a97a84c89bf7ce39c739615e75502a3e7aacb0dc067` | `88e30efd5a56ffb640ebf2d46bdfac49cc878075742fbe843f5b2d7d97d546f4` |
| Compose ui-graphics-android 1.0.5 | `4aac48931428304ed6a537c01ba675da3a41a33b0076b2beecae24f5e84c455e` | `88e30efd5a56ffb640ebf2d46bdfac49cc878075742fbe843f5b2d7d97d546f4` |
| Compose ui-text-android 1.0.1 | `9df41ea31077079d8ff2234b6e2ba49afee203e2007e3eb850ce44374638c3ba` | `a21a2280e7aac9bd940c406e75c5d3ebfa67f6d2b7db346d376adea2404edaa8` |
| Compose ui-text-android 1.0.5 | `771d7399316fb959171b1edf552524bce692d475c4c00daa30e9a835fd15419b` | `a21a2280e7aac9bd940c406e75c5d3ebfa67f6d2b7db346d376adea2404edaa8` |

Artifact discovery and hashing commands:

```sh
find /Users/sushantsrikrish/.gradle/caches/modules-2/files-2.1 \
  -type f \( -name '*.aar' -o -name '*.jar' \) \
  -path '*com.pico.spatial*' -print
shasum -a 256 /Users/sushantsrikrish/.gradle/caches/modules-2/files-2.1/com.pico.spatial.core/core/0.13.3/*/*
shasum -a 256 /Users/sushantsrikrish/.gradle/caches/modules-2/files-2.1/com.pico.spatial.core/core/6.0.0/*/*
python3 /private/tmp/pico_sdk6_source_diff.py
find /Users/sushantsrikrish/.gradle/caches/modules-2/files-2.1/com.pico.spatial.tools \
  -type f -name '*-sources.jar' -print
```

`pico_sdk6_source_diff.py` performed the same exact-one-artifact selection and hashing for every
coordinate shown in the table. The final `find` command produced no output, confirming the
plugin source-JAR absence.

## Limits of this offline measurement

- Plugin source-level drift is **inconclusive** because the asserted cached source JARs are not
  present. Binary entries and public Kotlin metadata are identical, which narrows but does not
  replace a source comparison.
- The source/JAR/AAR analysis identifies visual-risk inputs; it does not measure rendered-frame
  differences. Golden-frame acceptance still requires rendering and looking at the frames.
- The unexplained 507-file denominator remains unresolved. The numerator 48 and all three
  reproducible denominators are reported so a later audit can diagnose its provenance.
- Import resolution proves declaration presence in cached 6.0.0 artifacts. It is not a Gradle
  dependency-resolution or generated-project compilation result; neither was needed or run for
  this offline task.
