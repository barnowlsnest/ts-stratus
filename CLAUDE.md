# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A TypeScript client for the [stratus](https://github.com/barnowlsnest/stratus) gRPC `StreamService`. Node runs the `.ts` source files directly via built-in type stripping — there is no `ts-node`, bundler, or loader flag.

## Commands

```bash
nvm use && npm install     # Node >=22.18 required, pinned to 24 in .nvmrc

npm test                   # runs src/**/*.test.ts with Node's built-in test runner
npm run test:watch         # same, in watch mode
node --test src/stratus/codec.test.ts   # run a single test file directly

npm run typecheck          # tsc --noEmit — the ONLY thing that checks types (Node ignores types at runtime)
npm run build              # rm -rf dist && tsc -p tsconfig.build.json — emits JS + .d.ts to dist/
npm run lint               # type-aware ESLint (eslint.config.mjs)
npm run lint:fix

npm run proto:sync         # re-downloads proto/stratus/v1/stratus.proto from GitHub (pinned SHA)
```

There is no separate lint/typecheck-per-file shortcut beyond the flags above — `tsc --noEmit` and `eslint .` always run over the whole project.

## Critical conventions (Node type-stripping)

Because Node executes TypeScript source as-is (no transpile step at runtime):

- **Relative imports must include the literal `.ts` extension** (e.g. `from "./codec.ts"`). `tsc` rewrites these to `.js` on build via `rewriteRelativeImportExtensions`.
- **Only erasable syntax is allowed** (`erasableSyntaxOnly` in tsconfig). No `enum`, `namespace`, or constructor parameter properties — use `const` objects/unions and explicit field assignment instead, since Node's type-stripping can't transform code, only erase types.
- Type errors do **not** stop `node --test` or normal execution — Node ignores types entirely at runtime. Always run `npm run typecheck` separately (or trust CI/editor) before considering work correct.

## Architecture

- `src/index.ts` — package entry point; re-exports everything from `src/stratus/`.
- `src/stratus/types.ts` — the public-facing domain types (`Range`, `StreamInfo`, `InputRecord`, `OutputRecord`, `AddResult`, `DeleteResult`, `CallOptions`, `Uint64 = bigint | number`). These are hand-written against the vendored proto schema, not generated.
- `src/stratus/codec.ts` — the wire ⟷ domain boundary. Defines `Wire*` interfaces matching the gRPC JS objects produced by `@grpc/proto-loader` (configured with `longs: String`, so every proto `uint64` arrives as a decimal string) and `encode*`/`decode*` functions that convert between wire strings and `bigint`. All uint64 handling funnels through `encodeUint64`/`decodeUint64` here — this is the file to touch when the schema's numeric fields change.
- `src/stratus/client.ts` — loads `proto/stratus/v1/stratus.proto` via `protoLoader.loadSync`, builds the gRPC client constructor (`loadStreamService`, cached module-level), and exposes `createStratusClient()` returning a `StratusClient` with promise-based methods (`getStreamInfo`, `reconcileCache`, `add`, `readRange`, `deleteUpTo`) plus one async-generator method (`readOffset`) for the server-streaming RPC. Every method converts domain args to `Wire*` requests via codec functions before calling the raw gRPC client, and decodes responses back via codec functions before returning.
- Auth: server auth and TLS are both opt-in on any host (no loopback special case). With `AUTH_TOKEN` set the server requires `authorization: Bearer <token>` on every RPC, unary and streaming (unary + stream interceptors); unset, it accepts every call and just logs a warning. It serves TLS only when both `TLS_CERT_FILE` and `TLS_KEY_FILE` are set (setting one alone is a config error), otherwise plaintext with a warning. So `token`/`tls` on the client must match the specific server's deployment. The upstream `compose.yaml` runs unauthenticated plaintext published on `127.0.0.1:8000`. `createStratusClient` takes `token` (default `STRATUS_AUTH_TOKEN`) and attaches it with a client interceptor, not call credentials, because grpc-js only sends call credentials over a secure channel and the client must also work in plaintext (the Go client's `WithToken` sets `RequireTransportSecurity() = false` for the same reason). `tls` (`true` or `{ caFile }`) selects SSL channel credentials and is mutually exclusive with a custom `credentials`. `src/stratus/client.test.ts` checks this end to end against an in-process server.
- `proto/stratus/v1/stratus.proto` — vendored schema, not hand-edited. Kept in sync via `scripts/sync-proto.mjs`, which fetches from `barnowlsnest/stratus` pinned to a commit SHA (`REF` constant) rather than a branch, specifically so upstream pushes cannot silently change the schema underneath the hand-written types in `types.ts`/`codec.ts`. Bumping `REF` and re-running `npm run proto:sync` is the only supported way to pick up a schema change — re-check `types.ts` and `codec.ts` against the new `.proto` afterward.
- The server does not expose gRPC reflection, which is why the proto is vendored instead of discovered at runtime.

### uint64 handling

Every ID, dedup key, and count in the schema is a proto `uint64`, which overflows JS `Number` above 2^53. The convention throughout the client:
- Wire layer: strings (decimal).
- Domain layer: `bigint`.
- Public method inputs accept `Uint64` (`bigint | number`) and reject any `number` that isn't `Number.isSafeInteger`, rather than silently losing precision (see `encodeUint64`/`safeInteger` in `codec.ts`).

### Streaming

`readOffset` is the one server-streaming RPC; it's implemented as an `AsyncGenerator<OutputRecord, void>`. Breaking out of the consuming `for await` loop cancels the underlying gRPC call (`stream.cancel()` in a `finally` block) — this pattern should be preserved for any future streaming RPCs.
