import { join } from "node:path";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

import {
    decodeAddResult,
    decodeDeleteResult,
    decodeRange,
    decodeRecords,
    decodeStreamInfo,
    encodeDuration,
    encodeInputRecord,
    encodeUint64,
} from "./codec.ts";
import type {
    WireAddResponse,
    WireDeleteResponse,
    WireDuration,
    WireGetStreamInfoResponse,
    WireInputRecord,
    WireReadResponse,
    WireReconcileCacheResponse,
} from "./codec.ts";
import type {
    AddResult,
    CallOptions,
    DeleteResult,
    InputRecord,
    OutputRecord,
    Range,
    ReadOffsetOptions,
    ReadRangeOptions,
    StreamInfo,
    Uint64,
} from "./types.ts";

const PROTO_PATH = join(
    import.meta.dirname,
    "..",
    "..",
    "proto",
    "stratus",
    "v1",
    "stratus.proto",
);

const LOADER_OPTIONS: protoLoader.Options = {
    keepCase: false,
    // uint64 exceeds Number's safe range, so take the strings and widen to bigint
    // in the codec rather than letting the loader lose precision.
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
};

export const DEFAULT_ADDRESS = process.env.STRATUS_ADDR ?? "localhost:8000";

type EmptyRequest = Record<string, never>;

type UnaryCallback<Response> = (
    error: grpc.ServiceError | null,
    response?: Response,
) => void;

interface WireAddRequest {
    records: WireInputRecord[];
}

interface WireReadRangeRequest {
    startId: string;
    endId: string;
    timeout?: WireDuration;
}

interface WireReadOffsetRequest {
    startId: string;
    maxRecords: string;
    timeout?: WireDuration;
}

interface WireDeleteRequest {
    endId: string;
}

interface StreamServiceClient extends grpc.Client {
    GetStreamInfo(
        request: EmptyRequest,
        options: grpc.CallOptions,
        callback: UnaryCallback<WireGetStreamInfoResponse>,
    ): grpc.ClientUnaryCall;
    ReconcileCache(
        request: EmptyRequest,
        options: grpc.CallOptions,
        callback: UnaryCallback<WireReconcileCacheResponse>,
    ): grpc.ClientUnaryCall;
    Add(
        request: WireAddRequest,
        options: grpc.CallOptions,
        callback: UnaryCallback<WireAddResponse>,
    ): grpc.ClientUnaryCall;
    ReadRange(
        request: WireReadRangeRequest,
        options: grpc.CallOptions,
        callback: UnaryCallback<WireReadResponse>,
    ): grpc.ClientUnaryCall;
    Delete(
        request: WireDeleteRequest,
        options: grpc.CallOptions,
        callback: UnaryCallback<WireDeleteResponse>,
    ): grpc.ClientUnaryCall;
    ReadOffset(
        request: WireReadOffsetRequest,
        options: grpc.CallOptions,
    ): grpc.ClientReadableStream<WireReadResponse>;
}

type StreamServiceConstructor = new (
    address: string,
    credentials: grpc.ChannelCredentials,
    options?: Partial<grpc.ChannelOptions>,
) => StreamServiceClient;

let cachedConstructor: StreamServiceConstructor | undefined;

function loadStreamService(): StreamServiceConstructor {
    cachedConstructor ??= (() => {
        const packageDefinition = protoLoader.loadSync(PROTO_PATH, LOADER_OPTIONS);
        const descriptor = grpc.loadPackageDefinition(packageDefinition);
        const stratus = descriptor.stratus as grpc.GrpcObject;
        const v1 = stratus.v1 as grpc.GrpcObject;

        return v1.StreamService as unknown as StreamServiceConstructor;
    })();

    return cachedConstructor;
}

export interface StratusClientOptions {
    address?: string;
    credentials?: grpc.ChannelCredentials;
    channelOptions?: Partial<grpc.ChannelOptions>;
}

export interface StratusClient {
    getStreamInfo(options?: CallOptions): Promise<StreamInfo>;
    reconcileCache(options?: CallOptions): Promise<Range>;
    add(records: InputRecord[], options?: CallOptions): Promise<AddResult>;
    readRange(
        startId: Uint64,
        endId: Uint64,
        options?: ReadRangeOptions,
    ): Promise<OutputRecord[]>;
    /** Server-streaming follow. Yields records as they land; `break` cancels the RPC. */
    readOffset(
        startId: Uint64,
        maxRecords: Uint64,
        options?: ReadOffsetOptions,
    ): AsyncGenerator<OutputRecord, void>;
    deleteUpTo(endId: Uint64, options?: CallOptions): Promise<DeleteResult>;
    close(): void;
}

function callUnary<Response>(
    invoke: (callback: UnaryCallback<Response>) => void,
): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
        invoke((error, response) => {
            if (error) {
                reject(error);
                return;
            }

            if (response === undefined) {
                reject(new Error("stratus: call completed without a response"));
                return;
            }

            resolve(response);
        });
    });
}

function toCallOptions(options: CallOptions | undefined): grpc.CallOptions {
    const deadlineMs = options?.deadlineMs;

    return deadlineMs === undefined ? {} : { deadline: Date.now() + deadlineMs };
}

export function createStratusClient(
    options: StratusClientOptions = {},
): StratusClient {
    const StreamService = loadStreamService();
    const client = new StreamService(
        options.address ?? DEFAULT_ADDRESS,
        options.credentials ?? grpc.credentials.createInsecure(),
        options.channelOptions,
    );

    return {
        async getStreamInfo(callOptions) {
            const response = await callUnary<WireGetStreamInfoResponse>((callback) => {
                client.GetStreamInfo({}, toCallOptions(callOptions), callback);
            });

            return decodeStreamInfo(response.info);
        },

        async reconcileCache(callOptions) {
            const response = await callUnary<WireReconcileCacheResponse>((callback) => {
                client.ReconcileCache({}, toCallOptions(callOptions), callback);
            });

            return decodeRange(response.range);
        },

        async add(records, callOptions) {
            if (records.length === 0) {
                throw new Error("stratus: add requires at least one record");
            }

            const response = await callUnary<WireAddResponse>((callback) => {
                client.Add(
                    { records: records.map(encodeInputRecord) },
                    toCallOptions(callOptions),
                    callback,
                );
            });

            return decodeAddResult(response);
        },

        async readRange(startId, endId, callOptions) {
            const request: WireReadRangeRequest = {
                startId: encodeUint64(startId, "startId"),
                endId: encodeUint64(endId, "endId"),
            };

            if (callOptions?.serverTimeoutMs !== undefined) {
                request.timeout = encodeDuration(callOptions.serverTimeoutMs);
            }

            const response = await callUnary<WireReadResponse>((callback) => {
                client.ReadRange(request, toCallOptions(callOptions), callback);
            });

            return decodeRecords(response.records);
        },

        async *readOffset(startId, maxRecords, callOptions) {
            const request: WireReadOffsetRequest = {
                startId: encodeUint64(startId, "startId"),
                maxRecords: encodeUint64(maxRecords, "maxRecords"),
            };

            if (callOptions?.serverTimeoutMs !== undefined) {
                request.timeout = encodeDuration(callOptions.serverTimeoutMs);
            }

            const stream = client.ReadOffset(request, toCallOptions(callOptions));
            // Readable's own asyncIterator signature widens the element to `any`,
            // so re-narrow it before iterating.
            const responses: AsyncIterable<WireReadResponse> = stream;

            try {
                for await (const response of responses) {
                    yield* decodeRecords(response.records);
                }
            } finally {
                stream.cancel();
            }
        },

        async deleteUpTo(endId, callOptions) {
            const response = await callUnary<WireDeleteResponse>((callback) => {
                client.Delete(
                    { endId: encodeUint64(endId, "endId") },
                    toCallOptions(callOptions),
                    callback,
                );
            });

            return decodeDeleteResult(response);
        },

        close() {
            client.close();
        },
    };
}
