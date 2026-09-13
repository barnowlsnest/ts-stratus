import assert from "node:assert/strict";
import { test } from "node:test";

import {
    decodeAddResult,
    decodeRange,
    decodeRecords,
    decodeStreamInfo,
    decodeUint64,
    encodeDuration,
    encodeInputRecord,
    encodeUint64,
} from "./codec.ts";

test("encodeUint64 accepts bigint and number", () => {
    assert.equal(encodeUint64(42n, "id"), "42");
    assert.equal(encodeUint64(42, "id"), "42");
    assert.equal(encodeUint64(0n, "id"), "0");
});

test("encodeUint64 round-trips values beyond Number.MAX_SAFE_INTEGER", () => {
    const beyondDouble = 18446744073709551615n;

    assert.equal(encodeUint64(beyondDouble, "id"), "18446744073709551615");
    assert.equal(decodeUint64(encodeUint64(beyondDouble, "id")), beyondDouble);
});

test("encodeUint64 rejects out-of-range and unsafe values", () => {
    assert.throws(() => encodeUint64(-1n, "id"), RangeError);
    assert.throws(() => encodeUint64(2n ** 64n, "id"), RangeError);
    assert.throws(() => encodeUint64(1.5, "id"), RangeError);
    assert.throws(() => encodeUint64(Number.MAX_SAFE_INTEGER + 2, "id"), RangeError);
});

test("decodeUint64 treats a missing field as zero", () => {
    assert.equal(decodeUint64(undefined), 0n);
    assert.equal(decodeUint64("7"), 7n);
});

test("decodeUint64 rejects non-decimal and out-of-range values", () => {
    assert.throws(() => decodeUint64("-1"), SyntaxError);
    assert.throws(() => decodeUint64("0x10"), SyntaxError);
    assert.throws(() => decodeUint64("1.5"), SyntaxError);
    assert.throws(() => decodeUint64("18446744073709551616"), RangeError);
});

test("encodeDuration splits milliseconds into seconds and nanos", () => {
    assert.deepEqual(encodeDuration(0), { seconds: "0", nanos: 0 });
    assert.deepEqual(encodeDuration(1500), { seconds: "1", nanos: 500_000_000 });
    assert.deepEqual(encodeDuration(999), { seconds: "0", nanos: 999_000_000 });
    assert.deepEqual(encodeDuration(61_000), { seconds: "61", nanos: 0 });
});

test("encodeDuration rejects negative timeouts", () => {
    assert.throws(() => encodeDuration(-1), RangeError);
});

test("decodeRange defaults an absent message to a zero range", () => {
    assert.deepEqual(decodeRange(null), { start: 0n, end: 0n });
    assert.deepEqual(decodeRange({ start: "3", end: "9" }), { start: 3n, end: 9n });
});

test("decodeStreamInfo mirrors a live GetStreamInfo payload", () => {
    const info = decodeStreamInfo({
        range: { start: "0", end: "0" },
        cachedRecords: "0",
        fsRecords: "1",
    });

    assert.deepEqual(info, {
        range: { start: 0n, end: 0n },
        cachedRecords: 0n,
        fsRecords: 1n,
    });
});

test("decodeRecords preserves payload bytes", () => {
    const [withPayload, withoutPayload] = decodeRecords([
        { id: "1", rawData: new Uint8Array([104, 105]) },
        { id: "2" },
    ]);

    assert.ok(withPayload);
    assert.ok(withoutPayload);
    assert.equal(withPayload.id, 1n);
    assert.equal(Buffer.from(withPayload.rawData).toString(), "hi");
    assert.equal(withoutPayload.id, 2n);
    assert.equal(withoutPayload.rawData.length, 0);
});

test("decodeAddResult surfaces the duplicate count", () => {
    const result = decodeAddResult({
        addedRecords: { start: "1", end: "3" },
        streamRecords: { start: "1", end: "3" },
        duplicateRecords: "2",
    });

    assert.deepEqual(result.addedRecords, { start: 1n, end: 3n });
    assert.equal(result.duplicateRecords, 2n);
});

test("encodeInputRecord converts the dedup key to a wire string", () => {
    const encoded = encodeInputRecord({
        dedupKey: 99,
        rawData: new Uint8Array([1, 2, 3]),
    });

    assert.deepEqual(encoded, { dedupKey: "99", rawData: new Uint8Array([1, 2, 3]) });
});
