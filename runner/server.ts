import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { LocalNodeRunner } from "./local-runner.js";
import type { RepositorySpec, RunReceipt } from "./contracts.js";

export type RunnerServerConfig = {
  token: string;
  repository: RepositorySpec;
  maxConcurrent: number;
};

function equalSecret(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

function authorized(header: string | undefined, token: string): boolean {
  if (!token || typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  return equalSecret(header.slice(7), token);
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > 16_384) throw new Error("request too large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createRunnerServer(config: RunnerServerConfig): Server {
  const active = new Map<string, Promise<RunReceipt>>();
  const completed = new Map<string, RunReceipt>();
  return createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/runs" || !authorized(request.headers.authorization, config.token)) return respond(response, 401, { error: "unauthorized" });
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) return respond(response, 400, { error: "invalid request" });
    try {
      const value = await body(request) as { runId?: unknown; idempotencyKey?: unknown; repositoryId?: unknown; sha?: unknown };
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["runId", "idempotencyKey", "repositoryId", "sha"].includes(key)) || value.idempotencyKey !== idempotencyKey || typeof value.runId !== "string" || typeof value.repositoryId !== "string" || typeof value.sha !== "string" || value.repositoryId !== config.repository.id || !/^[0-9a-f]{40}$/i.test(value.sha)) return respond(response, 400, { error: "invalid request" });
      const completedResult = completed.get(idempotencyKey);
      if (completedResult) return respond(response, 200, completedResult);
      const existing = active.get(idempotencyKey);
      if (existing) return respond(response, 200, await existing);
      if (active.size >= Math.max(1, config.maxConcurrent)) return respond(response, 429, { error: "too many concurrent runs" });
      const execution = new LocalNodeRunner().run(config.repository, value.sha, value.runId, idempotencyKey);
      active.set(idempotencyKey, execution);
      try {
        const result = await execution;
        completed.set(idempotencyKey, result);
        while (completed.size > 1000) completed.delete(completed.keys().next().value as string);
        return respond(response, 200, result);
      } catch {
        return respond(response, 422, { error: "run failed" });
      } finally {
        active.delete(idempotencyKey);
      }
    } catch {
      return respond(response, 400, { error: "invalid request" });
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const repositoryPath = process.env.REPOSITORY_FIXTURE_PATH ?? "";
  const server = createRunnerServer({
    token: process.env.RUNNER_TOKEN ?? "",
    maxConcurrent: Number(process.env.MAX_CONCURRENT_RUNS ?? "1"),
    repository: {
      id: "fixture",
      sourcePath: repositoryPath,
      testCommand: ["node", "test.mjs"],
      generatedModulePath: "generated.js",
      generatedModuleContents: "export const generated = true;\n",
    },
  });
  server.listen(Number(process.env.RUNNER_PORT ?? "8788"), "127.0.0.1");
}
