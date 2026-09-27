import { describe, expect, it } from "vitest";
import { receiptDigest, validateReceipt } from "./receipt.js";
import type { RunReceipt } from "./contracts.js";

function sample(): Omit<RunReceipt, "receiptSha256"> {
  return {
    schema: "self-healing-ci.receipt.v1",
    runId: "run-1",
    idempotencyKey: "key-1",
    repository: { id: "fixture", requestedSha: "0".repeat(40), checkedOutSha: "0".repeat(40) },
    runner: { id: "local", version: "local-node-runner.v1" },
    initialCommand: { command: ["node", "test.mjs"], exitStatus: 1, outputDigest: "a".repeat(64), outputBytes: 8, startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:01.000Z", timedOut: false },
    classifiedFailure: { kind: "missing-generated-module", modulePath: "generated.js", command: ["node", "test.mjs"] },
    repair: { policy: "missing-generated-module.v1", path: "generated.js", beforeSha256: null, afterSha256: "b".repeat(64) },
    diff: { normalized: "diff --git a/generated.js b/generated.js\n", sha256: "c".repeat(64) },
    retryCommand: { command: ["node", "test.mjs"], exitStatus: 0, outputDigest: "d".repeat(64), outputBytes: 0, startedAt: "2026-01-01T00:00:02.000Z", completedAt: "2026-01-01T00:00:03.000Z", timedOut: false },
    finalHead: "0".repeat(40),
    finalDirty: true,
    terminalOutcome: "repaired-and-passed",
    steps: [{ name: "checkout", startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:00.500Z" }],
  };
}

describe("receipt validation", () => {
  it("accepts a digest-matching receipt and rejects tampering", () => {
    const unsigned = sample();
    const receipt = { ...unsigned, receiptSha256: receiptDigest(unsigned) };
    expect(validateReceipt(receipt)).toBe(true);
    expect(validateReceipt({ ...receipt, runId: "other" })).toBe(false);
    expect(validateReceipt({ ...receipt, receiptSha256: "e".repeat(64) })).toBe(false);
  });

  it("rejects incomplete or wrong-schema values", () => {
    expect(validateReceipt(null)).toBe(false);
    expect(validateReceipt({})).toBe(false);
    expect(validateReceipt({ ...sample(), schema: "other", receiptSha256: "f".repeat(64) })).toBe(false);
    expect(validateReceipt({ ...sample(), finalDirty: false, receiptSha256: "f".repeat(64) })).toBe(false);
  });
});
