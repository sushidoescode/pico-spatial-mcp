## C6: Correct external APK observations and inspect real media

**Files:** modify `src/verifyapk.ts`, `src/capture.ts`, `src/picoclitools.ts`, `src/doors.ts`; create `src/artifactinspection.ts`, `test/artifactinspection.mjs`, `test/verifyapk-observation.mjs`; reuse identity/capture utilities from `src/nativefleetreceipt.ts` and immutable evidence behavior in `src/ledger.ts`.

**Interface:** external-APK observation is distinct from a fleet-native-debug build receipt. Required observation identity includes APK hash, serial, installed package/hash, boot identity, PID/start identity, foreground, capture route, capture time and immutable media hash. Record missing identity explicitly; do not synthesize it from caller claims.

- [ ] Add injected-device tests where the installed APK differs, a foreign app is foreground, the boot or process start changes, capture bytes are substituted, or an image is malformed but larger than 1000 bytes. All must fail closed or remain explicitly inconclusive as appropriate.
- [ ] Replace the `test/doors.mjs` fixture that expects killing a foreign incumbent. Ordinary verification must neither stop an unrelated app nor clear global logcat. Capture bounded package/time-scoped logs and return the actual conflict evidence.
- [ ] Select ADB/serial through explicit toolchain/target context. Remove the hardcoded old SDK path and package-only mutable `/tmp` capture output. Use unique run directories and refuse replacement of existing artifacts.
- [ ] Add media fixtures: valid small PNG, truncated PNG, arbitrary nonempty bytes, missing MP4 stream, valid dark frame and valid short recording. Check format/decoding, dimensions, hash and measured duration where a decoder is available. If no decoder is available, return unvalidated media, not a successful decode.
- [ ] Keep the recording default short and preserve the existing 180-second MCP cap unless actual route tests justify extending it. CLI 0.5's 1800-second advertisement and returned requested-duration value do not prove actual media duration. Do not build an automatic 30-minute recording into tests.
- [ ] Reuse the ledger's looked-byte checks without broadening evidence tiers. A valid dark ADB frame can be an inconclusive capture route; it is not universally proof of failed immersive rendering. Update descriptions to say what each route observes.
- [ ] Build; run the new artifact/observation suites, `npm run test:doors`, `npm run test:runreceipt`, `npm run test:ledger` and affected CLI fixtures. Native LOOK acceptance, if blocked by current constraints, must remain separately open in the checkpoint. Commit the source/fixture improvement without claiming native success.

