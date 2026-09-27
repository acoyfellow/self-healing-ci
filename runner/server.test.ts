import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createRunnerServer } from "./server.js";

const runFile = promisify(execFile);
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function start(sourcePath = ""): Promise<string> {
  const server = createRunnerServer({
    token: "runner-test-token",
    maxConcurrent: 1,
    repository: {
      id: "fixture",
      sourcePath,
      testCommand: ["node", "test.mjs"],
      generatedModulePath: "generated.js",
      generatedModuleContents: "export const generated = true;\n",
    },
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/v1/runs`;
}

async function fixtureRepo(): Promise<{ root: string; sha: string }> {
  const root = await mkdtemp(`${tmpdir()}/self-healing-server-`);
  await runFile("git", ["init", "--initial-branch", "main"], { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: root } });
  await writeFile(`${root}/package.json`, '{"type":"module"}\n');
  await writeFile(`${root}/test.mjs`, 'import "./generated.js";\n');
  await runFile("git", ["add", "."], { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: root } });
  await runFile("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"], { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: root } });
  const sha = (await runFile("git", ["rev-parse", "HEAD"], { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: root } })).stdout.trim();
  return { root, sha };
}

describe("runner server boundary", () => {
  it("requires the runner credential", async () => {
    const url = await start();
    const response = await fetch(url, { method: "POST", headers: { "idempotency-key": "key-1" }, body: "{}" });
    expect(response.status).toBe(401);
  });

  it("rejects arbitrary repository and command data", async () => {
    const url = await start();
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer runner-test-token", "idempotency-key": "key-1", "content-type": "application/json" },
      body: JSON.stringify({ runId: "run-1", idempotencyKey: "key-1", repositoryId: "other", sha: "0".repeat(40), command: ["sh"] }),
    });
    expect(response.status).toBe(400);
  });

  it("replays a completed run for the same idempotency key", async () => {
    const { root, sha } = await fixtureRepo();
    const url = await start(root);
    const payload = { runId: "run-replay", idempotencyKey: "key-replay", repositoryId: "fixture", sha };
    const headers = { authorization: "Bearer runner-test-token", "idempotency-key": "key-replay", "content-type": "application/json" };
    try {
      const first = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
      expect(first.status).toBe(200);
      const firstBody = await first.json() as { receiptSha256: string };
      const second = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
      expect(second.status).toBe(200);
      expect((await second.json() as { receiptSha256: string }).receiptSha256).toBe(firstBody.receiptSha256);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a second concurrent run", async () => {
    const { root, sha } = await fixtureRepo();
    const url = await start(root);
    const headers = { authorization: "Bearer runner-test-token", "content-type": "application/json" };
    try {
      const first = fetch(url, { method: "POST", headers: { ...headers, "idempotency-key": "key-a" }, body: JSON.stringify({ runId: "run-a", idempotencyKey: "key-a", repositoryId: "fixture", sha }) });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const second = await fetch(url, { method: "POST", headers: { ...headers, "idempotency-key": "key-b" }, body: JSON.stringify({ runId: "run-b", idempotencyKey: "key-b", repositoryId: "fixture", sha }) });
      expect(second.status).toBe(429);
      expect((await first).status).toBe(200);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
