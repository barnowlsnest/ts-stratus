import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

import { createStratusClient } from "./client.ts";

const TOKEN = "s3cret";

const PROTO_PATH = join(import.meta.dirname, "..", "..", "proto", "stratus", "v1", "stratus.proto");

type Unary = (call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) => void;
type ServerStreaming = (call: grpc.ServerWritableStream<unknown, unknown>) => void;

// Every authorization header value the fake server has seen, in call order.
const receivedAuthorization: grpc.MetadataValue[][] = [];

// Mirrors the stratus server's auth interceptor: every RPC needs the bearer token.
function authorized(metadata: grpc.Metadata): boolean {
    const values = metadata.get("authorization");
    receivedAuthorization.push(values);

    return values.includes(`Bearer ${TOKEN}`);
}

function lastAuthorization(): grpc.MetadataValue[] {
    const last = receivedAuthorization.at(-1);
    assert.ok(last, "server did not observe a call");

    return last;
}

const unauthenticated = { code: grpc.status.UNAUTHENTICATED, details: "invalid or missing bearer token" };

let server: grpc.Server;
let address: string;

before(async () => {
    const definition = protoLoader.loadSync(PROTO_PATH, { longs: String, defaults: true });
    const descriptor = grpc.loadPackageDefinition(definition);
    const stratus = descriptor.stratus as grpc.GrpcObject;
    const v1 = stratus.v1 as grpc.GrpcObject;
    const service = (v1.StreamService as grpc.ServiceClientConstructor).service;

    const getStreamInfo: Unary = (call, callback) => {
        if (!authorized(call.metadata)) {
            callback(unauthenticated);
            return;
        }

        callback(null, { info: { range: { start: "1", end: "3" }, cachedRecords: "3", fsRecords: "3" } });
    };

    const readOffset: ServerStreaming = (call) => {
        if (!authorized(call.metadata)) {
            call.emit("error", unauthenticated);
            return;
        }

        call.write({ records: [{ id: "1", rawData: Buffer.from("hi") }] });
        call.end();
    };

    server = new grpc.Server();
    server.addService(service, { GetStreamInfo: getStreamInfo, ReadOffset: readOffset });

    const port = await new Promise<number>((resolve, reject) => {
        server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, bound) => {
            if (error) {
                reject(error);
                return;
            }

            resolve(bound);
        });
    });

    address = `127.0.0.1:${String(port)}`;
});

after(() => {
    server.forceShutdown();
});

const cases: { name: string; token: string; authorized: boolean }[] = [
    { name: "valid token", token: TOKEN, authorized: true },
    { name: "wrong token", token: "nope", authorized: false },
    { name: "no token", token: "", authorized: false },
];

for (const tc of cases) {
    test(`unary call with ${tc.name}`, async () => {
        const client = createStratusClient({ address, token: tc.token });

        try {
            if (tc.authorized) {
                const actual = await client.getStreamInfo({ deadlineMs: 2_000 });
                assert.deepEqual(actual.range, { start: 1n, end: 3n });
                return;
            }

            await assert.rejects(client.getStreamInfo({ deadlineMs: 2_000 }), {
                code: grpc.status.UNAUTHENTICATED,
            });
            assert.deepEqual(lastAuthorization(), tc.token === "" ? [] : [`Bearer ${tc.token}`]);
        } finally {
            client.close();
        }
    });

    test(`streaming call with ${tc.name}`, async () => {
        const client = createStratusClient({ address, token: tc.token });

        try {
            const consume = async (): Promise<bigint[]> => {
                const ids: bigint[] = [];
                for await (const record of client.readOffset(1n, 1n, { deadlineMs: 2_000 })) {
                    ids.push(record.id);
                }

                return ids;
            };

            if (tc.authorized) {
                assert.deepEqual(await consume(), [1n]);
                return;
            }

            await assert.rejects(consume(), { code: grpc.status.UNAUTHENTICATED });
            assert.deepEqual(lastAuthorization(), tc.token === "" ? [] : [`Bearer ${tc.token}`]);
        } finally {
            client.close();
        }
    });
}

test("token defaults to STRATUS_AUTH_TOKEN", async () => {
    const previous = process.env.STRATUS_AUTH_TOKEN;
    process.env.STRATUS_AUTH_TOKEN = TOKEN;
    const client = createStratusClient({ address });

    try {
        const actual = await client.getStreamInfo({ deadlineMs: 2_000 });
        assert.equal(actual.fsRecords, 3n);
    } finally {
        client.close();
        if (previous === undefined) {
            delete process.env.STRATUS_AUTH_TOKEN;
        } else {
            process.env.STRATUS_AUTH_TOKEN = previous;
        }
    }
});

test("token with illegal header characters is rejected without echoing it", () => {
    const token = "s3cret-from-file\n";

    assert.throws(
        () => createStratusClient({ address, token }),
        (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /not allowed in a gRPC header/);
            assert.doesNotMatch(error.message, /s3cret/);

            return true;
        },
    );
});

test("user interceptors are kept alongside the bearer token one", async () => {
    let userInterceptorCalls = 0;
    const counting: grpc.Interceptor = (callOptions, nextCall) => {
        userInterceptorCalls += 1;

        return new grpc.InterceptingCall(nextCall(callOptions));
    };
    const client = createStratusClient({ address, token: TOKEN, channelOptions: { interceptors: [counting] } });

    try {
        const actual = await client.getStreamInfo({ deadlineMs: 2_000 });
        assert.equal(actual.cachedRecords, 3n);
        assert.equal(userInterceptorCalls, 1);
        assert.deepEqual(lastAuthorization(), [`Bearer ${TOKEN}`]);
    } finally {
        client.close();
    }
});

test("tls and credentials are mutually exclusive", () => {
    assert.throws(
        () => createStratusClient({ address, tls: true, credentials: grpc.credentials.createInsecure() }),
        /either tls or credentials/,
    );
});
