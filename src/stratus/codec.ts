import type {
    AddResult,
    DeleteResult,
    InputRecord,
    OutputRecord,
    Range,
    StreamInfo,
    Uint64,
} from "./types.ts";

// The loader is configured with `longs: String`, so every uint64 arrives as a
// decimal string and has to be widened to bigint before the caller sees it.
export interface WireDuration {
    seconds: string;
    nanos: number;
}

export interface WireRange {
    start?: string;
    end?: string;
}

export interface WireStreamInfo {
    range?: WireRange | null;
    cachedRecords?: string;
    fsRecords?: string;
}

export interface WireOutputRecord {
    id?: string;
    rawData?: Uint8Array;
}

export interface WireInputRecord {
    dedupKey: string;
    rawData: Uint8Array;
}

export interface WireGetStreamInfoResponse {
    info?: WireStreamInfo | null;
}

export interface WireReconcileCacheResponse {
    range?: WireRange | null;
}

export interface WireReadResponse {
    records?: WireOutputRecord[];
}

export interface WireAddResponse {
    addedRecords?: WireRange | null;
    streamRecords?: WireRange | null;
    duplicateRecords?: string;
}

export interface WireDeleteResponse {
    deletedRecords?: WireRange | null;
    streamRecords?: WireRange | null;
}

const MAX_UINT64 = 2n ** 64n - 1n;
const NANOS_PER_MS = 1_000_000n;
const MS_PER_SECOND = 1000n;

export function encodeUint64(value: Uint64, field: string): string {
    const asBigInt = typeof value === "bigint" ? value : safeInteger(value, field);

    if (asBigInt < 0n || asBigInt > MAX_UINT64) {
        throw new RangeError(`${field} must fit in uint64, got ${asBigInt.toString()}`);
    }

    return asBigInt.toString();
}

function safeInteger(value: number, field: string): bigint {
    if (!Number.isSafeInteger(value)) {
        throw new RangeError(
            `${field} must be a safe integer or bigint, got ${String(value)}`,
        );
    }

    return BigInt(value);
}

export function decodeUint64(value: string | undefined): bigint {
    if (value === undefined) {
        return 0n;
    }

    if (!/^\d+$/.test(value)) {
        throw new SyntaxError(`uint64 field must be a decimal string, got ${JSON.stringify(value)}`);
    }

    const asBigInt = BigInt(value);

    if (asBigInt > MAX_UINT64) {
        throw new RangeError(`uint64 field must fit in uint64, got ${asBigInt.toString()}`);
    }

    return asBigInt;
}

export function encodeDuration(milliseconds: number): WireDuration {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        throw new RangeError(
            `timeout must be a non-negative number of milliseconds, got ${String(milliseconds)}`,
        );
    }

    const total = BigInt(Math.round(milliseconds));

    return {
        seconds: (total / MS_PER_SECOND).toString(),
        nanos: Number((total % MS_PER_SECOND) * NANOS_PER_MS),
    };
}

export function decodeRange(wire: WireRange | null | undefined): Range {
    return {
        start: decodeUint64(wire?.start),
        end: decodeUint64(wire?.end),
    };
}

export function decodeStreamInfo(wire: WireStreamInfo | null | undefined): StreamInfo {
    return {
        range: decodeRange(wire?.range),
        cachedRecords: decodeUint64(wire?.cachedRecords),
        fsRecords: decodeUint64(wire?.fsRecords),
    };
}

export function decodeRecords(wire: WireOutputRecord[] | undefined): OutputRecord[] {
    return (wire ?? []).map((record) => ({
        id: decodeUint64(record.id),
        rawData: record.rawData ?? new Uint8Array(0),
    }));
}

export function decodeAddResult(wire: WireAddResponse): AddResult {
    return {
        addedRecords: decodeRange(wire.addedRecords),
        streamRecords: decodeRange(wire.streamRecords),
        duplicateRecords: decodeUint64(wire.duplicateRecords),
    };
}

export function decodeDeleteResult(wire: WireDeleteResponse): DeleteResult {
    return {
        deletedRecords: decodeRange(wire.deletedRecords),
        streamRecords: decodeRange(wire.streamRecords),
    };
}

export function encodeInputRecord(record: InputRecord): WireInputRecord {
    return {
        dedupKey: encodeUint64(record.dedupKey, "dedupKey"),
        rawData: record.rawData,
    };
}
