export type RepositoryId = "fixture";

export type CommandName = "test" | "git";

export type RepositorySpec = {
  id: RepositoryId;
  sourcePath: string;
  testCommand: readonly [string, ...string[]];
  generatedModulePath: string;
  generatedModuleContents: string;
};

export type RunnerLimits = {
  commandTimeoutMs: number;
  outputBytes: number;
  files: number;
  workspaceBytes: number;
};

export type CommandResult = {
  command: readonly string[];
  exitStatus: number | null;
  outputDigest: string;
  outputBytes: number;
  startedAt: string;
  completedAt: string;
  timedOut: boolean;
};

export type ClassifiedFailure = {
  kind: "missing-generated-module";
  modulePath: string;
  command: readonly string[];
};

export type RunReceipt = {
  schema: "self-healing-ci.receipt.v1";
  runId: string;
  idempotencyKey: string;
  repository: { id: RepositoryId; requestedSha: string; checkedOutSha: string };
  runner: { id: string; version: string };
  initialCommand: CommandResult;
  classifiedFailure: ClassifiedFailure;
  repair: {
    policy: "missing-generated-module.v1";
    path: string;
    beforeSha256: string | null;
    afterSha256: string;
  };
  diff: { normalized: string; sha256: string };
  retryCommand: CommandResult;
  finalHead: string;
  finalDirty: boolean;
  terminalOutcome: "repaired-and-passed";
  steps: Array<{ name: string; startedAt: string; completedAt: string }>;
  receiptSha256: string;
};

export interface Runner {
  run(spec: RepositorySpec, requestedSha: string, runId: string, idempotencyKey: string): Promise<RunReceipt>;
}
