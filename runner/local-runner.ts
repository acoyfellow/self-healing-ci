import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, lstat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { CommandResult, RepositorySpec, Runner, RunnerLimits, RunReceipt } from "./contracts.js";
import { receiptDigest } from "./receipt.js";

const defaultLimits: RunnerLimits = {
  commandTimeoutMs: 30_000,
  outputBytes: 64 * 1024,
  files: 2_000,
  workspaceBytes: 128 * 1024 * 1024,
};

const runnerVersion = "local-node-runner.v1";
const shaPattern = /^[0-9a-f]{40}$/i;
const allowedTestCommand = ["node", "test.mjs"] as const;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeOutput(value: string, limit: number): string {
  return value
    .slice(0, limit)
    .replace(/bearer\s+[A-Za-z0-9._~+\/-]+/gi, "bearer [REDACTED]")
    .replace(/(token|secret|password|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function inspectTree(root: string, limits: RunnerLimits): Promise<void> {
  let files = 0;
  let bytes = 0;
  async function visit(path: string): Promise<void> {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(path, entry.name);
      const info = await lstat(child);
      if (info.isSymbolicLink()) throw new Error("workspace contains a symlink");
      if (info.isDirectory()) await visit(child);
      else if (info.isFile()) {
        files += 1;
        bytes += info.size;
        if (files > limits.files) throw new Error("workspace file limit exceeded");
        if (bytes > limits.workspaceBytes) throw new Error("workspace size limit exceeded");
      }
    }
  }
  await visit(root);
}

async function command(root: string, args: readonly string[], limits: RunnerLimits): Promise<CommandResult & { output: string }> {
  if (args.length === 0 || !["node", "/usr/bin/node", "/opt/homebrew/bin/node", "git", "/usr/bin/git", "/opt/homebrew/bin/git"].includes(args[0])) {
    throw new Error("command is not allowlisted");
  }
  const startedAt = new Date().toISOString();
  const output: string[] = [];
  let outputBytes = 0;
  let outputTail = "";
  const result = await new Promise<{ exitStatus: number | null; timedOut: boolean }>((resolvePromise, reject) => {
    const child = spawn(args[0], args.slice(1), {
      cwd: root,
      shell: false,
      env: { GIT_CONFIG_NOSYSTEM: "1", HOME: root, PATH: "/usr/bin:/bin:/opt/homebrew/bin" },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, limits.commandTimeoutMs);
    const collect = (chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      const text = chunk.toString("utf8");
      if (output.join("").length < Math.floor(limits.outputBytes / 2)) output.push(text.slice(0, Math.floor(limits.outputBytes / 2) - output.join("").length));
      outputTail = (outputTail + text).slice(-Math.floor(limits.outputBytes / 2));
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", reject);
    child.on("close", (exitStatus) => {
      clearTimeout(timer);
      resolvePromise({ exitStatus, timedOut });
    });
  });
  const completedAt = new Date().toISOString();
  const bounded = safeOutput(outputBytes > limits.outputBytes ? `${output.join("")}\n[TRUNCATED]\n${outputTail}` : output.join(""), limits.outputBytes);
  return {
    command: args,
    exitStatus: result.exitStatus,
    outputDigest: digest(bounded),
    outputBytes: Math.min(outputBytes, limits.outputBytes),
    startedAt,
    completedAt,
    timedOut: result.timedOut,
    output: bounded,
  };
}

function validateTestCommand(args: readonly string[]): void {
  if (args.length !== allowedTestCommand.length || args.some((value, index) => value !== allowedTestCommand[index])) throw new Error("test command is not allowlisted");
}

function classifyMissingGeneratedModule(output: string, modulePath: string): boolean {
  const escaped = modulePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:Cannot find module[\\s\\S]*${escaped}[\\s\\S]*imported from|ERR_MODULE_NOT_FOUND[\\s\\S]*${escaped})`, "i").test(output);
}

async function git(root: string, args: readonly string[], limits: RunnerLimits): Promise<CommandResult & { output: string }> {
  return command(root, ["git", "-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=always", ...args], limits);
}

function step(name: string, startedAt: string, completedAt: string): { name: string; startedAt: string; completedAt: string } {
  return { name, startedAt, completedAt };
}

function publicCommand(result: CommandResult & { output: string }): CommandResult {
  const { output: _output, ...publicResult } = result;
  return publicResult;
}

export class LocalNodeRunner implements Runner {
  private readonly limits: RunnerLimits;
  private readonly id: string;

  constructor(limits: Partial<RunnerLimits> = {}, id = "local") {
    this.limits = { ...defaultLimits, ...limits };
    this.id = id;
  }

  async run(spec: RepositorySpec, requestedSha: string, runId: string, idempotencyKey: string): Promise<RunReceipt> {
    if (!shaPattern.test(requestedSha)) throw new Error("requested SHA is invalid");
    validateTestCommand(spec.testCommand);
    const workspace = await mkdtemp(join(tmpdir(), "self-healing-runner-"));
    const steps: Array<{ name: string; startedAt: string; completedAt: string }> = [];
    try {
      const checkoutStarted = new Date().toISOString();
      const clone = await command(workspace, ["git", "clone", "--no-local", "--no-hardlinks", "--config", "core.hooksPath=/dev/null", spec.sourcePath, "."], this.limits);
      if (clone.exitStatus !== 0) throw new Error("checkout failed");
      const checkout = await git(workspace, ["checkout", "--detach", "--force", requestedSha], this.limits);
      if (checkout.exitStatus !== 0) throw new Error("checkout failed");
      const head = await git(workspace, ["rev-parse", "HEAD"], this.limits);
      if (head.exitStatus !== 0 || !shaPattern.test(head.output.trim())) throw new Error("checkout verification failed");
      await inspectTree(workspace, this.limits);
      const checkedOutSha = head.output.trim();
      if (checkedOutSha !== requestedSha) throw new Error("checkout SHA mismatch");
      steps.push(step("checkout", checkoutStarted, new Date().toISOString()));
      const initial = await command(workspace, spec.testCommand, this.limits);
      steps.push(step("initial-test", initial.startedAt, initial.completedAt));
      if (initial.exitStatus === 0 || initial.timedOut) throw new Error("unsupported test result");
      const repairPath = resolve(workspace, spec.generatedModulePath);
      if (!inside(workspace, repairPath) || resolve(dirname(repairPath)) !== resolve(workspace)) throw new Error("repair path is outside workspace");
      let beforeSha256: string | null = null;
      try {
        beforeSha256 = digest(await readFile(repairPath, "utf8"));
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      }
      if (beforeSha256 !== null) throw new Error("repair destination is not absent");
      if (!classifyMissingGeneratedModule(initial.output, spec.generatedModulePath)) throw new Error("unsupported failure classification");
      await writeFile(repairPath, spec.generatedModuleContents, { mode: 0o644, flag: "wx" });
      await inspectTree(workspace, this.limits);
      steps.push(step("repair", new Date().toISOString(), new Date().toISOString()));
      const markDiff = await git(workspace, ["add", "--intent-to-add", "--", spec.generatedModulePath], this.limits);
      if (markDiff.exitStatus !== 0) throw new Error("diff preparation failed");
      const diffResult = await git(workspace, ["diff", "--no-ext-diff", "--binary", "--", spec.generatedModulePath], this.limits);
      if (diffResult.exitStatus !== 0) throw new Error("diff failed");
      const diff = diffResult.output.replace(/\r\n/g, "\n");
      if (!diff) throw new Error("repair produced no diff");
      const afterSha256 = digest(spec.generatedModuleContents);
      const retry = await command(workspace, spec.testCommand, this.limits);
      steps.push(step("retry-test", retry.startedAt, retry.completedAt));
      if (retry.exitStatus !== 0 || retry.timedOut) throw new Error("retry failed");
      const finalHeadResult = await git(workspace, ["rev-parse", "HEAD"], this.limits);
      const dirtyResult = await git(workspace, ["status", "--porcelain", "--untracked-files=all"], this.limits);
      if (finalHeadResult.exitStatus !== 0 || dirtyResult.exitStatus !== 0) throw new Error("final state inspection failed");
      const finalHead = finalHeadResult.output.trim();
      const finalDirty = dirtyResult.output.trim().length > 0;
      if (finalHead !== requestedSha || !finalDirty) throw new Error("final workspace assertion failed");
      const receiptWithoutDigest = {
        schema: "self-healing-ci.receipt.v1" as const,
        runId,
        idempotencyKey,
        repository: { id: spec.id, requestedSha, checkedOutSha },
        runner: { id: this.id, version: runnerVersion },
        initialCommand: publicCommand(initial),
        classifiedFailure: { kind: "missing-generated-module" as const, modulePath: spec.generatedModulePath, command: spec.testCommand },
        repair: { policy: "missing-generated-module.v1" as const, path: spec.generatedModulePath, beforeSha256, afterSha256 },
        diff: { normalized: diff, sha256: digest(diff) },
        retryCommand: publicCommand(retry),
        finalHead,
        finalDirty,
        terminalOutcome: "repaired-and-passed" as const,
        steps,
      };
      return { ...receiptWithoutDigest, receiptSha256: receiptDigest(receiptWithoutDigest) };
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}
