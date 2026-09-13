export interface Range {
    start: bigint;
    end: bigint;
}

export interface StreamInfo {
    range: Range;
    cachedRecords: bigint;
    fsRecords: bigint;
}

export interface InputRecord {
    dedupKey: Uint64;
    rawData: Uint8Array;
}

export interface OutputRecord {
    id: bigint;
    rawData: Uint8Array;
}

export interface AddResult {
    addedRecords: Range;
    streamRecords: Range;
    duplicateRecords: bigint;
}

export interface DeleteResult {
    deletedRecords: Range;
    streamRecords: Range;
}

export interface CallOptions {
    deadlineMs?: number;
}

export interface ServerCallOptions extends CallOptions {
    serverTimeoutMs?: number;
}

export type ReadRangeOptions = ServerCallOptions;
export type ReadOffsetOptions = ServerCallOptions;

export type Uint64 = bigint | number;
