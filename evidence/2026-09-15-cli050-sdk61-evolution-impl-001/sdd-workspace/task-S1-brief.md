### Task 1: Define component-valid project/host selection

**Files:** Create `src/toolchainselection.ts`, `test/helpers/toolchain-fixture.mjs`, `test/toolchain-resolution.mjs`; modify `src/toolchain.ts:15–91`.
**Interfaces:** Produce these exported types and functions; existing `resolveToolsRoot`, `listVersions`, `pickVersion` become compatibility adapters.

```ts
export type ToolComponent = "packer" | "emulator" | "adb" | "proto";
export type RootSource = "explicit" | "local.properties" | "PICO_HOME" | "default";
export interface ToolchainRequest {
  androidProjectRoot?: string; toolsRoot?: string; toolsVersion?: string;
  projectToolsVersion?: string; required: readonly ToolComponent[];
}
export interface FileIdentity { path: string; sha256: string }
export interface SelectedToolchain {
  status: "ok"; root: string; rootSource: RootSource; version: string;
  reason: "explicit" | "project-pin" | "newest-usable";
  files: Partial<Record<ToolComponent, FileIdentity>>; identity: string;
}
export type ToolchainSelection = SelectedToolchain | {
  status: "unavailable" | "ambiguous"; code: string; detail: string;
};
export interface ToolchainIO {
  platform: NodeJS.Platform; home: string; env: NodeJS.ProcessEnv;
  read(path: string): Buffer | null; entries(path: string): string[] | null;
  realpath(path: string): string | null; executable(path: string): boolean;
}
export function resolveToolchain(request: ToolchainRequest, io?: ToolchainIO): ToolchainSelection;
export function executableNames(name: "adb" | "emulator" | "spatialbundle", platform: NodeJS.Platform): string[];
```

- [ ] Add `toolchainIOFromTree({platform, home, env, files})` to the fixture helper; `files` maps absolute paths to `{bytes: string, executable?: boolean}`. Implement deterministic `entries`, `realpath`, `read` and `executable` without host filesystem access; expose attempted reads for assertions.
- [ ] Add the regression below, plus numeric6.10>6.9 ordering, split/missing components, unreadable/non-directory entries and absent explicit roots.

```js
const io = toolchainIOFromTree({platform:"darwin", home:"/fixture", env:{}, files:{
  "/fixture/Library/PICO/sdk/6.1/editor/spatialbundle/spatialbundle": {bytes:"six-one", executable:true},
  "/fixture/Library/PICO/sdk/6.0/emulator/emulator": {bytes:"six-zero", executable:true}
}});
assert.equal(resolveToolchain({toolsVersion:"6.1", required:["emulator"]}, io).status, "unavailable");
assert.equal(resolveToolchain({required:["packer"]}, io).version, "6.1");
assert.equal(resolveToolchain({toolsVersion:"6.1", projectToolsVersion:"6.0", required:["packer"]}, io).status, "ambiguous");
```

- [ ] Run `npm run build`, then `node --test test/toolchain-resolution.mjs`; retain the initial failure. Missing export is an acceptable first failure; before completion retain a behavioral failure against the legacy requested-version component behavior too.
- [ ] Implement explicit root → project `spatial.tools.dir` → `PICO_HOME` → documented platform default. Explicit roots/pins fail closed; never fall back from an unavailable request. Automatic selection needs every requested component in the same installation.
- [ ] Parse Java-properties continuations/escapes and report conflicting duplicate selection properties. Resolve relative project values against the Android root; canonicalize aliases. Treat equal numeric versions with different payloads as ambiguous; an exact explicit directory name disambiguates them.
- [ ] Validate version tokens as numeric two/three-component labels; reject separators/traversal. Handle missing/unreadable directories as structured unavailable results. Hash only selected required files for identity; no subprocess, registry or provisioning in this module.
- [ ] Add platform fixtures: explicit Windows drive/UNC roots and `.exe`, Linux explicit roots, macOS default, spaces, escaped backslashes/colon, case-insensitive Windows environment keys. `executableNames("adb","win32")` must return `["adb.exe"]`; unsupported default PICO layouts return `unsupported-default-root`, never an invented path.
- [ ] Rebuild and run the narrow test file; assert a request needing both packer/emulator cannot silently mix6.0/6.1. Commit only Task1 files with `fix: unify component-aware PICO tool selection`.

The resolver's externally asserted failure codes are part of the contract:

| Trigger | Status/code |
| --- | --- |
| Explicit version lacks a required component | `unavailable/component-missing` |
| Requested version directory does not exist | `unavailable/version-missing` |
| Explicit root is absent or unreadable | `unavailable/root-unavailable` |
| Explicit request contradicts supplied project pin | `ambiguous/version-conflict` |
| Equal numeric versions contain different required bytes | `ambiguous/version-alias-conflict` |
| Platform has no verified default root | `unavailable/unsupported-default-root` |

Do not add a persistent project pin format in Task1: `projectToolsVersion` is an explicit caller input. A later durable pin format needs a documented schema and its own compatibility review; no official Gradle property is inferred here.

