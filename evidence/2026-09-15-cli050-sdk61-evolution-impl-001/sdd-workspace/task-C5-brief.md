## C5: Single-flight doors with complete MCP result transport

**Files:** modify `src/doors.ts`; create `src/innerclient.ts`, `test/innerclient.mjs`; extend `test/doors.mjs` and tarball startup fixtures.

**Interface:** preserve the current domain-value `innerCall` compatibility path explicitly. Add a distinct raw result path for forwarding so internal consumers do not suddenly receive an MCP envelope instead of their expected JSON object.

```ts
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
export interface InnerClient {
  callRaw(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}
export function createSingleFlightClient(connect: () => Promise<InnerClient>): () => Promise<InnerClient> {
  let pending: Promise<InnerClient> | undefined;
  return () => pending ??= connect().catch(error => { pending = undefined; throw error; });
}
```

The snippet shows initialization ownership only. The implementation must also invalidate the matching generation on close/failure and preserve existing process-lifecycle protections.

- [ ] Add a delayed fake connection and call the provider concurrently 20 times. Assert one connection, one child and identical client identity. Add failed-first-initialization/retry and old-generation-close races.
- [ ] Add raw-result fixtures containing `structuredContent`, text, image/resource blocks and `isError: true`. Assert exact preservation in the forwarding lane and intentional decoding in the domain-value lane; do not convert `isError` to a success object.
- [ ] Implement the pending connection and typed forwarding. Keep clean stdio and bounded client timeouts; avoid changing all existing door result contracts to a new nesting shape.
- [ ] Measure cold/warm fixed-input latency, response bytes and child count before/after in retained host-only fixtures. Build; run `npm run test:doors`, `node --test test/innerclient.mjs` and affected tarball tests. Commit the reviewed transport change.

