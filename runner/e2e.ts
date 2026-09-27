import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { LocalNodeRunner } from "./local-runner.js";
import type { RepositorySpec } from "./contracts.js";

const runFile = promisify(execFile);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runFile("git", args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: cwd },
  });
  return result.stdout.trim();
}

const root = await mkdtemp(`${tmpdir()}/self-healing-ci-e2e-`);
const baseline = new Set(await readdir(tmpdir()));
try {
  await git(root, ["init", "--initial-branch", "main"]);
  await writeFile(`${root}/test.mjs`, 'import "./generated.js";\n');
  await git(root, ["add", "."]);
  await runFile("git", ["-c", "user.name=reference", "-c", "user.email=reference@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture"], { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: root } });
  const requestedSha = await git(root, ["rev-parse", "HEAD"]);
  const spec: RepositorySpec = {
    id: "fixture",
    sourcePath: root,
    testCommand: ["node", "test.mjs"],
    generatedModulePath: "generated.js",
    generatedModuleContents: "export const generated = true;\n",
  };
  const receipt = await new LocalNodeRunner().run(spec, requestedSha, "e2e-run", "e2e-key");
  if (receipt.repository.checkedOutSha !== requestedSha) throw new Error("checked-out SHA mismatch");
  if (receipt.initialCommand.exitStatus === 0) throw new Error("initial command did not fail");
  if (receipt.repair.beforeSha256 !== null) throw new Error("repair destination existed");
  if (receipt.repair.afterSha256 !== sha256(spec.generatedModuleContents)) throw new Error("after hash mismatch");
  if (receipt.diff.sha256 !== sha256(receipt.diff.normalized)) throw new Error("diff hash mismatch");
  if (receipt.retryCommand.exitStatus !== 0) throw new Error("retry did not pass");
  if (receipt.finalHead !== requestedSha || !receipt.finalDirty) throw new Error("final workspace assertion mismatch");
  const { receiptSha256, ...unsigned } = receipt;
  if (receiptSha256 !== sha256(JSON.stringify(unsigned))) throw new Error("receipt hash mismatch");
  if ((await git(root, ["status", "--porcelain"])) !== "") throw new Error("source repository changed");
  const remaining = (await readdir(tmpdir())).filter((name) => !baseline.has(name) && name.startsWith("self-healing-runner-"));
  if (remaining.length !== 0) throw new Error("temporary runner workspace remained");
  process.stdout.write("PASS real local end-to-end repair proof\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
