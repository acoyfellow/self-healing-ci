import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { RunIndex } from "../src/run-index.js";

const authorization = { authorization: "Bearer test-operator-token" };
const sha = "0123456789abcdef0123456789abcdef01234567";

describe("RunIndex", () => {
  it("limits active runs and preserves completed idempotency keys", async () => {
    const records = new Map<string, unknown>();
    const storage = {
      get: async (key: string) => records.get(key),
      put: async (key: string, value: unknown) => { records.set(key, value); },
      delete: async (key: string) => records.delete(key),
      list: async ({ prefix }: { prefix: string }) => new Map([...records].filter(([key]) => key.startsWith(prefix))),
    };
    const index = new RunIndex({ storage } as never);
    const reserve = (runId: string, key: string) => index.fetch(new Request("https://index/reserve", { method: "POST", body: JSON.stringify({ runId, idempotencyKey: key, limit: 1 }) }));
    expect((await reserve("run-1", "key-1")).status).toBe(200);
    expect((await reserve("run-2", "key-2")).status).toBe(429);
    await index.fetch(new Request("https://index/complete", { method: "POST", body: JSON.stringify({ idempotencyKey: "key-1" }) }));
    const duplicate = await reserve("run-1b", "key-1");
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ existing: true, runId: "run-1" });
    expect((await reserve("run-2", "key-2")).status).toBe(200);
  });
});

describe("authenticated coordinator API", () => {
  it("rejects unauthenticated requests", async () => {
    const response = await SELF.fetch("https://self-healing-ci.test/run", { method: "POST" });
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects unknown repositories, short SHAs, and extra command fields", async () => {
    const malformed = await SELF.fetch("https://self-healing-ci.test/run", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json", "idempotency-key": "key-1" },
      body: JSON.stringify({ repositoryId: "fixture", sha: "bad" }),
    });
    expect(malformed.status).toBe(400);

    const extraField = await SELF.fetch("https://self-healing-ci.test/run", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json", "idempotency-key": "key-extra" },
      body: JSON.stringify({ repositoryId: "fixture", sha, command: ["sh"] }),
    });
    expect(extraField.status).toBe(400);

    const forbidden = await SELF.fetch("https://self-healing-ci.test/run", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json", "idempotency-key": "key-2" },
      body: JSON.stringify({ repositoryId: "unknown", sha }),
    });
    expect(forbidden.status).toBe(403);
  });

  it("returns an authenticated version response", async () => {
    const response = await SELF.fetch("https://self-healing-ci.test/version", { headers: authorization });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json())).toMatchObject({ sha: expect.any(String) });
  });
});
