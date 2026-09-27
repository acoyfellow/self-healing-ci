import { createHash } from "node:crypto";
import type { RunReceipt } from "./contracts.js";

export function receiptDigest(receipt: Omit<RunReceipt, "receiptSha256">): string {
  return createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
}

export function validateReceipt(value: unknown): value is RunReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<RunReceipt>;
  if (receipt.schema !== "self-healing-ci.receipt.v1" || typeof receipt.receiptSha256 !== "string" || !/^[0-9a-f]{64}$/.test(receipt.receiptSha256) || typeof receipt.runId !== "string" || typeof receipt.idempotencyKey !== "string" || !receipt.repository || !receipt.runner || !receipt.initialCommand || !receipt.classifiedFailure || !receipt.repair || !receipt.diff || !receipt.retryCommand || typeof receipt.finalHead !== "string" || receipt.finalDirty !== true || !Array.isArray(receipt.steps)) return false;
  const { receiptSha256, ...unsigned } = receipt as RunReceipt;
  return receiptDigest(unsigned) === receiptSha256;
}
