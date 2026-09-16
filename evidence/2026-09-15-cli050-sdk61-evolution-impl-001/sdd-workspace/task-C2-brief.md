## C2: Use the canonical knowledge server without losing lifecycle safety

**Files:** modify `src/knowledge.ts`, `src/picoclimanaged.ts`, `src/clicapabilities.ts`; extend `test/knowledge-lifecycle.mjs` and `test/picocli-autoinstall.mjs`.

**Interface:** managed transport selects argv from the C1 capability set only after its identity matches the execution target; explicitly configured external command/args retain their exact existing behavior. The SDK track owns `readDeclarationIdentity` and verified compatibility-record loading. The CLI adapter supplies root/workspace hints only, independently of graph transport availability; hints cannot establish declaration authority.

```js
// Required fixture assertions over the captured spawn argv:
assert.deepEqual(spawnsFor050.map(x => x.args), [["knowledge", "server"]]);
assert.deepEqual(spawnsFor044.map(x => x.args), [["mcp", "dev-knowledge"]]);
assert.equal(unknownCapabilitySpawns.length, 0);
assert.deepEqual(externalSpawn.args, ["custom-server", "--stdio"]);
```

- [ ] Extend the existing fake MCP process fixture to capture argv under exact 0.4.4 and 0.5.0 identities. The published 0.5.0 source retains colon aliases, but the default should use `knowledge server`; do not silently retry arbitrary aliases after a server error.
- [ ] Add tests proving configuration overrides, cold startup, concurrent callers, cancellation, EOF retirement, timeout, output cap, wrong/reused PID and generation ownership still behave as today. These are load-bearing existing protections.
- [ ] Implement canonical dispatch and update the diagnostic canary. Preserve structured error evidence and exact CLI provenance; missing knowledge data and transport startup failure remain distinct.
- [ ] Reconcile graph action/input/output compatibility using the published server declarations and a harmless fixture server. A transport start alone does not establish API shape or matched SDK declarations.
- [ ] Build; run `npm run test:knowledge-lifecycle` and `npm run test:picocli`. Review with the SDK-track owner before committing shared files.

**Acceptance:** current CLI receives its actual canonical command; legacy/external configurations remain intentional; no unrelated process can be killed and no graph result is promoted to exact declaration authority.

