import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
export { RunIndex } from "./run-index.js";

export interface Env {
  DEPLOY_SHA: string;
  OPERATOR_TOKEN: string;
  RUNNER_URL: string;
  RUNNER_TOKEN: string;
  REPOSITORY_ALLOWLIST: string;
  MAX_CONCURRENT_RUNS: string;
  RUN_INDEX: DurableObjectNamespace;
  SELF_HEAL: Workflow<RunParameters>;
}

export type RunParameters = {
  repositoryId: string;
  requestedSha: string;
  idempotencyKey: string;
  workflowId: string;
};

type StoredReceipt = {
  schema: "self-healing-ci.receipt.v1";
  runId: string;
  idempotencyKey: string;
  repository: { id: string; requestedSha: string; checkedOutSha: string };
  receiptSha256: string;
  terminalOutcome: string;
  finalHead: string;
  finalDirty: boolean;
  steps: Array<{ name: string; startedAt: string; completedAt: string }>;
};

const shaPattern = /^[0-9a-f]{40}$/i;
const idPattern = /^[A-Za-z0-9._:-]{1,128}$/;

function json(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...init.headers,
    },
  });
}

async function equalSecret(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(a);
  const rightBytes = new Uint8Array(b);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < leftBytes.length; index += 1) difference |= leftBytes[index] ^ (rightBytes[index] ?? 0);
  return difference === 0;
}

async function authenticated(request: Request, token: string): Promise<boolean> {
  const value = request.headers.get("authorization") ?? "";
  if (!value.startsWith("Bearer ") || !token) return false;
  return equalSecret(value.slice(7), token);
}

function parseAllowlist(raw: string): Record<string, { sha: string }> {
  try {
    const value = JSON.parse(raw) as Record<string, { sha?: unknown }>;
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item && typeof item.sha === "string" && shaPattern.test(item.sha)).map(([id, item]) => [id, { sha: item.sha as string }]));
  } catch {
    return {};
  }
}

async function workflowId(idempotencyKey: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(idempotencyKey));
  return `run-${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function validReceipt(value: unknown): Promise<boolean> {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<StoredReceipt>;
  const candidate = value as Record<string, unknown>;
  const initial = candidate.initialCommand as Record<string, unknown> | undefined;
  const retry = candidate.retryCommand as Record<string, unknown> | undefined;
  const repair = candidate.repair as Record<string, unknown> | undefined;
  const diff = candidate.diff as Record<string, unknown> | undefined;
  const repository = candidate.repository as Record<string, unknown> | undefined;
  if (receipt.schema !== "self-healing-ci.receipt.v1" || typeof receipt.runId !== "string" || typeof receipt.idempotencyKey !== "string" || typeof receipt.receiptSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(receipt.receiptSha256) || typeof receipt.terminalOutcome !== "string" || typeof receipt.finalHead !== "string" || receipt.finalDirty !== true || !Array.isArray(receipt.steps) || typeof repository?.id !== "string" || typeof repository.requestedSha !== "string" || typeof repository.checkedOutSha !== "string" || !initial || !retry || typeof initial.exitStatus !== "number" || typeof retry.exitStatus !== "number" || !repair || typeof repair.path !== "string" || typeof repair.afterSha256 !== "string" || !diff || typeof diff.normalized !== "string" || typeof diff.sha256 !== "string") return false;
  const receiptSha256 = receipt.receiptSha256;
  const unsigned = { ...receipt } as Record<string, unknown>;
  delete unsigned.receiptSha256;
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(unsigned)));
  const computed = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return computed === receiptSha256.toLowerCase();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!(await authenticated(request, env.OPERATOR_TOKEN))) return json({ error: "unauthorized" }, { status: 401 });
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/version") return json({ sha: env.DEPLOY_SHA });
    if (request.method === "POST" && url.pathname === "/run") {
      const idempotencyKey = request.headers.get("idempotency-key") ?? "";
      if (!idPattern.test(idempotencyKey)) return json({ error: "invalid request" }, { status: 400 });
      let body: { repositoryId?: unknown; sha?: unknown };
      try { body = await request.json() as { repositoryId?: unknown; sha?: unknown }; } catch { return json({ error: "invalid request" }, { status: 400 }); }
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !["repositoryId", "sha"].includes(key)) || typeof body.repositoryId !== "string" || typeof body.sha !== "string" || !idPattern.test(body.repositoryId) || !shaPattern.test(body.sha)) return json({ error: "invalid request" }, { status: 400 });
      const allowlist = parseAllowlist(env.REPOSITORY_ALLOWLIST);
      if (Object.keys(allowlist).length === 0) return json({ error: "run unavailable" }, { status: 503 });
      const allowed = allowlist[body.repositoryId];
      if (!allowed || allowed.sha.toLowerCase() !== body.sha.toLowerCase()) return json({ error: "repository or commit is not allowlisted" }, { status: 403 });
      const id = await workflowId(idempotencyKey);
      const reservationResponse = await env.RUN_INDEX.get(env.RUN_INDEX.idFromName("global")).fetch("https://run-index/reserve", { method: "POST", body: JSON.stringify({ runId: id, idempotencyKey, limit: Number(env.MAX_CONCURRENT_RUNS) || 1 }) });
      if (reservationResponse.status === 429) return json({ error: "too many concurrent runs" }, { status: 429 });
      if (!reservationResponse.ok) return json({ error: "run unavailable" }, { status: 503 });
      try {
        await env.SELF_HEAL.create({ id, params: { repositoryId: body.repositoryId, requestedSha: body.sha, idempotencyKey, workflowId: id } });
      } catch {
        try { await (await env.SELF_HEAL.get(id)).status(); } catch { return json({ error: "run unavailable" }, { status: 503 }); }
      }
      return json({ runId: id, idempotencyKey }, { status: 202 });
    }
    if (request.method === "GET" && url.pathname.startsWith("/status/")) {
      const id = decodeURIComponent(url.pathname.slice("/status/".length));
      if (!idPattern.test(id)) return json({ error: "not found" }, { status: 404 });
      const lookup = await env.RUN_INDEX.get(env.RUN_INDEX.idFromName("global")).fetch("https://run-index/lookup", { method: "POST", body: JSON.stringify({ runId: id }) });
      if (!lookup.ok) return json({ error: "not found" }, { status: 404 });
      try {
        const instance = await env.SELF_HEAL.get(id);
        const status = await instance.status();
        return json({ runId: id, status: status.status, receipt: await validReceipt(status.output) ? status.output : null });
      } catch {
        return json({ error: "not found" }, { status: 404 });
      }
    }
    return json({ error: "not found" }, { status: 404 });
  },
};

export class SelfHealWorkflow extends WorkflowEntrypoint<Env, RunParameters> {
  override async run(event: WorkflowEvent<RunParameters>, step: WorkflowStep): Promise<StoredReceipt> {
    return step.do("runner-execution", async () => {
      let completed = false;
      try {
        const response = await fetch(`${this.env.RUNNER_URL.replace(/\/$/, "")}/v1/runs`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.env.RUNNER_TOKEN}`, "content-type": "application/json", "idempotency-key": event.payload.idempotencyKey },
          body: JSON.stringify({ runId: event.payload.workflowId, idempotencyKey: event.payload.idempotencyKey, repositoryId: event.payload.repositoryId, sha: event.payload.requestedSha }),
        });
        if (!response.ok) throw new Error("runner unavailable");
        const receipt = await response.json() as unknown;
        if (!(await validReceipt(receipt))) throw new Error("runner returned an invalid receipt");
        const verifiedReceipt = receipt as StoredReceipt;
        if (verifiedReceipt.runId !== event.payload.workflowId || verifiedReceipt.idempotencyKey !== event.payload.idempotencyKey) throw new Error("runner receipt identity mismatch");
        const completeResponse = await this.env.RUN_INDEX.get(this.env.RUN_INDEX.idFromName("global")).fetch("https://run-index/complete", { method: "POST", body: JSON.stringify({ idempotencyKey: event.payload.idempotencyKey }) });
        if (!completeResponse.ok) throw new Error("run index completion failed");
        completed = true;
        return verifiedReceipt;
      } finally {
        if (!completed) await this.env.RUN_INDEX.get(this.env.RUN_INDEX.idFromName("global")).fetch("https://run-index/release", { method: "POST", body: JSON.stringify({ idempotencyKey: event.payload.idempotencyKey }) });
      }
    });
  }
}
