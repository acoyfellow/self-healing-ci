import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { LocalNodeRunner } from "./local-runner.js";
import { validateReceipt } from "./receipt.js";
import type { RepositorySpec } from "./contracts.js";

const runFile = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runFile("git", args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: cwd } });
  return result.stdout.trim();
}

async function fixture(testSource = 'import "./generated.js";\n', addSymlink = false): Promise<{ root: string; spec: RepositorySpec; sha: string }> {
  const root = await mkdtemp(`${tmpdir()}/self-healing-fixture-`);
  await git(root, ["init", "--initial-branch", "main"]);
  await writeFile(`${root}/package.json`, '{"type":"module"}\n');
  await writeFile(`${root}/test.mjs`, testSource);
  if (addSymlink) await symlink("test.mjs", `${root}/linked-test.mjs`);
  await git(root, ["add", "."]);
  await git(root, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"]);
  const sha = await git(root, ["rev-parse", "HEAD"]);
  return {
    root,
    sha,
    spec: {
      id: "fixture",
      sourcePath: root,
      testCommand: ["node", "test.mjs"],
      generatedModulePath: "generated.js",
      generatedModuleContents: "export const generated = true;\n",
    },
  };
}

describe("LocalNodeRunner", () => {
  it("checks out an exact SHA, repairs the real failure, records evidence, and cleans up", async () => {
    const fixtureData = await fixture();
    try {
      const receipt = await new LocalNodeRunner().run(fixtureData.spec, fixtureData.sha, "run-1", "key-1");
      expect(receipt.repository.checkedOutSha).toBe(fixtureData.sha);
      expect(receipt.initialCommand.exitStatus).not.toBe(0);
      expect(receipt.classifiedFailure).toMatchObject({ kind: "missing-generated-module", modulePath: "generated.js" });
      expect(receipt.repair.beforeSha256).toBeNull();
      expect(receipt.repair.afterSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(receipt.diff.normalized).toContain("+++ b/generated.js");
      expect(receipt.diff.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(receipt.retryCommand.exitStatus).toBe(0);
      expect(receipt.finalHead).toBe(fixtureData.sha);
      expect(receipt.finalDirty).toBe(true);
      expect(receipt.receiptSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(validateReceipt(receipt)).toBe(true);
      expect(validateReceipt({ ...receipt, terminalOutcome: "tampered" })).toBe(false);
      expect(await git(fixtureData.root, ["status", "--porcelain"])).toBe("");
    } finally {
      await rm(fixtureData.root, { recursive: true, force: true });
    }
  });

  it("does not execute source-repository Git hooks", async () => {
    const fixtureData = await fixture();
    await writeFile(`${fixtureData.root}/.git/hooks/post-checkout`, "#!/bin/sh\necho hooked > hooked.txt\n", { mode: 0o755 });
    try {
      const receipt = await new LocalNodeRunner().run(fixtureData.spec, fixtureData.sha, "run-hooks", "key-hooks");
      expect(receipt.retryCommand.exitStatus).toBe(0);
      expect(receipt.diff.normalized).not.toContain("hooked.txt");
    } finally {
      await rm(fixtureData.root, { recursive: true, force: true });
    }
  });

  it("enforces workspace size limits", async () => {
    const fixtureData = await fixture();
    await writeFile(`${fixtureData.root}/big.bin`, "x".repeat(2048));
    await git(fixtureData.root, ["add", "big.bin"]);
    await git(fixtureData.root, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "big"]);
    try {
      await expect(new LocalNodeRunner({ workspaceBytes: 512 }).run(fixtureData.spec, await git(fixtureData.root, ["rev-parse", "HEAD"]), "run-size", "key-size")).rejects.toThrow("workspace size limit exceeded");
    } finally {
      await rm(fixtureData.root, { recursive: true, force: true });
    }
  });

  it("refuses a test command that is not the allowlisted node test", async () => {
    const fixtureData = await fixture();
    try {
      await expect(new LocalNodeRunner().run({ ...fixtureData.spec, testCommand: ["node", "other.mjs"] }, fixtureData.sha, "run-shell", "key-shell")).rejects.toThrow("test command is not allowlisted");
    } finally {
      await rm(fixtureData.root, { recursive: true, force: true });
    }
  });

  it("redacts secret-shaped command output", async () => {
    const fixtureData = await fixture('process.stdout.write("password=examplepasswordvalue\\n"); await import("./generated.js");\n');
    try {
      const receipt = await new LocalNodeRunner().run(fixtureData.spec, fixtureData.sha, "run-redact", "key-redact");
      expect(receipt.initialCommand.outputDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(receipt)).not.toContain("examplepasswordvalue");
    } finally {
      await rm(fixtureData.root, { recursive: true, force: true });
    }
  });

  it("rejects a SHA that is not the immutable fixture commit", async () => {
    const fixtureData = await fixture();
    try {
      await expect(new LocalNodeRunner().run(fixtureData.spec, "0".repeat(40), "run-2", "key-2")).rejects.toThrow("checkout failed");
    } finally {
      await rm(fixtureData.root, { recursive: true, force: true });
    }
  });

  it("bounds captured output while preserving the supported classification", async () => {
    const fixtureData = await fixture('process.stdout.write("x".repeat(100000)); await import("./generated.js");\n');
    try {
      const receipt = await new LocalNodeRunner({ outputBytes: 1024 }).run(fixtureData.spec, fixtureData.sha, "run-output", "key-output");
      expect(receipt.initialCommand.outputBytes).toBe(1024);
      expect(receipt.retryCommand.outputBytes).toBeLessThanOrEqual(1024);
    } finally {
      await rm(fixtureData.root, { recursive: true, force: true });
    }
  });

  it("stops without repair when the initial command times out", async () => {
    const fixtureData = await fixture("while (true) {}\n");
    try {
      await expect(new LocalNodeRunner({ commandTimeoutMs: 5_000 }).run(fixtureData.spec, fixtureData.sha, "run-timeout", "key-timeout")).rejects.toThrow("unsupported test result");
    } finally {
      await rm(fixtureData.root, { recursive: true, force: true });
    }
  });

  it("refuses an unsupported failure without repairing", async () => {
    const fixtureData = await fixture("process.exit(2);\n");
    try {
      await expect(new LocalNodeRunner().run(fixtureData.spec, fixtureData.sha, "run-unsupported", "key-unsupported")).rejects.toThrow("unsupported failure classification");
    } finally {
      await rm(fixtureData.root, { recursive: true, force: true });
    }
  });

  it("enforces workspace file limits before running tests", async () => {
    const fixtureData = await fixture('import "./generated.js";\n');
    await writeFile(`${fixtureData.root}/extra.txt`, "extra\n");
    await git(fixtureData.root, ["add", "extra.txt"]);
    await git(fixtureData.root, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "extra"]);
    try {
      await expect(new LocalNodeRunner({ files: 1 }).run(fixtureData.spec, await git(fixtureData.root, ["rev-parse", "HEAD"]), "run-files", "key-files")).rejects.toThrow("workspace file limit exceeded");
    } finally {
      await rm(fixtureData.root, { recursive: true, force: true });
    }
  });

  it("rejects symlinks in the checked-out workspace", async () => {
    const fixtureData = await fixture('import "./generated.js";\n', true);
    try {
      await expect(new LocalNodeRunner().run(fixtureData.spec, fixtureData.sha, "run-symlink", "key-symlink")).rejects.toThrow("workspace contains a symlink");
    } finally {
      await rm(fixtureData.root, { recursive: true, force: true });
    }
  });

  it("does not overwrite an existing generated module", async () => {
    const fixtureData = await fixture();
    await writeFile(`${fixtureData.root}/generated.js`, "export const generated = false;\n");
    await git(fixtureData.root, ["add", "generated.js"]);
    await git(fixtureData.root, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "generated"]);
    try {
      await expect(new LocalNodeRunner().run(fixtureData.spec, await git(fixtureData.root, ["rev-parse", "HEAD"]), "run-exists", "key-exists")).rejects.toThrow(/unsupported (test result|failure classification)|repair destination is not absent/);
    } finally {
      await rm(fixtureData.root, { recursive: true, force: true });
    }
  });

  it("does not repair when the initial test already passes", async () => {
    const fixtureData = await fixture("export {};\n");
    try {
      await expect(new LocalNodeRunner().run(fixtureData.spec, fixtureData.sha, "run-pass", "key-pass")).rejects.toThrow("unsupported test result");
    } finally {
      await rm(fixtureData.root, { recursive: true, force: true });
    }
  });

  it("refuses a repair destination that escapes the workspace", async () => {
    const fixtureData = await fixture();
    try {
      await expect(new LocalNodeRunner().run({ ...fixtureData.spec, generatedModulePath: "../generated.js" }, fixtureData.sha, "run-3", "key-3")).rejects.toThrow("repair path is outside workspace");
    } finally {
      await rm(fixtureData.root, { recursive: true, force: true });
    }
  });
});
