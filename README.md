# ts-stratus

Node.js + TypeScript sandbox that runs `.ts` files directly with Node's built-in
type stripping — no `ts-node`, no bundler, no loader flags.

## Requirements

Node.js 22.18 or newer (pinned to 24 in `.nvmrc`).

```bash
nvm use
npm install
```

## Scripts

| Script  | What it does  |
| --- | --- |
| `npm test` | Runs `*.test.ts` files with Node's built-in test runner |
| `npm run test:watch` | Test runner in watch mode |
| `npm run typecheck` | `tsc --noEmit` — the only thing that checks types |
| `npm run build` | Emits JavaScript + declarations to `dist/` |
| `npm run lint` / `npm run lint:fix` | Type-aware ESLint |
| `npm run proto:sync` | Re-downloads the stratus `.proto` from GitHub |

## Conventions

Because Node executes the TypeScript source as-is, two rules apply:

- **Relative imports must include the `.ts` extension** (`import { greet } from "./greet.ts"`).
  `tsc` rewrites these to `.js` on build via `rewriteRelativeImportExtensions`.
- **Only erasable syntax is allowed.** `enum`, `namespace`, and constructor
  parameter properties are rejected by `erasableSyntaxOnly`, since Node strips
  types without transforming code. Use `const` objects and unions instead.

Type errors do not stop Node from running `.ts` files — Node ignores types
entirely. Run `npm run typecheck` (or rely on the editor and CI) to catch them.

## Stratus gRPC client

`src/index.ts` is the package entry point. It re-exports the public client for
the [stratus](https://github.com/barnowlsnest/stratus) `StreamService`. The
address defaults to `localhost:8000` and can be overridden with `STRATUS_ADDR`.

```ts
import { createStratusClient } from "ts-stratus";

const client = createStratusClient({ address: "localhost:8000" });

try {
  const info = await client.getStreamInfo({ deadlineMs: 5_000 });

  await client.add([{ dedupKey: 1n, rawData: new TextEncoder().encode("hi") }]);

  // Server-streaming; `break` cancels the RPC.
  for await (const record of client.readOffset(info.range.start, 10n, {
    serverTimeoutMs: 5_000,
  })) {
    console.log(record.id, Buffer.from(record.rawData).toString());
  }
} finally {
  client.close();
}
```

### Authentication and TLS

Auth and TLS are both opt-in on the stratus server, on any host. When it is
configured with `AUTH_TOKEN` it rejects every call — streaming ones included —
with `UNAUTHENTICATED` unless it carries `authorization: Bearer <token>`; with
`AUTH_TOKEN` unset it accepts every call (and ignores a token if you send one).
It serves TLS only when given `TLS_CERT_FILE` and `TLS_KEY_FILE`, and otherwise
serves plaintext. It logs a warning for each one that is off. So `token` and
`tls` have to match how that particular server is deployed. Pass the same value
the server has in `AUTH_TOKEN`:

```ts
const client = createStratusClient({
  address: "stratus.example:8000",
  token: process.env.STRATUS_AUTH_TOKEN, // the default when `token` is omitted
  tls: { caFile: "ca.pem" },             // or `tls: true` for the system roots
});
```

| Option        | Default                  | Meaning                                                              |
| ------------- | ------------------------ | -------------------------------------------------------------------- |
| `token`       | `STRATUS_AUTH_TOKEN` env | bearer token; an empty string sends no header                        |
| `tls`         | off                      | `true` or `{ caFile }`; without it the channel is plaintext          |
| `credentials` | plaintext                | custom channel credentials; cannot be combined with `tls` (unless `false`) |

Without `tls` the token travels in plaintext. That is fine against a server on
loopback, on a private container network whose port is published on `127.0.0.1`
only, or behind a gateway or mesh that already terminates TLS. Pass `tls` when
the stratus server itself serves TLS. The upstream `compose.yaml` stack is for
local/demo runs: it serves unauthenticated plaintext on `127.0.0.1:8000`, so the
default `createStratusClient()` connects to it as-is.

### uint64 and bigint

Every ID, dedup key and count in the schema is a proto `uint64`, which overflows
JavaScript's `Number` above 2^53. The client takes these off the wire as strings
and hands them to you as `bigint`, so comparisons and arithmetic need `1n`-style
literals. Methods accept either a `bigint` or a `number`, and reject a `number`
that is not a safe integer rather than silently losing precision.

### Where the schema comes from

The server does not register gRPC reflection, so the schema cannot be discovered
at runtime — `proto/stratus/v1/stratus.proto` is vendored instead. `npm run
proto:sync` re-downloads it from GitHub, pinned to a commit SHA rather than a
branch so upstream pushes cannot change the schema underneath the hand-written
types in `src/stratus/types.ts`. Bump `REF` in `scripts/sync-proto.mjs` to move
to a newer schema, and re-check those types when you do.
