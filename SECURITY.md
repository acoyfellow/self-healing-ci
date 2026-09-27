# Security

Report security issues privately to the repository owner before public disclosure.

This project is a reference implementation. It is not a general-purpose remote shell.

## Trust boundaries

```text
operator
  │ authenticated API request
  ▼
Cloudflare Worker and Workflow
  │ authenticated, replay-resistant runner request
  ▼
external runner or local Node runner
  │ isolated temporary workspace
  ▼
allowlisted repository at one immutable commit
```

The Worker must not execute shell commands. Cloudflare Workflows coordinate durable steps but do not provide a shell.

The runner is the only component allowed to start subprocesses. Public callers cannot choose a URL, command, branch, patch, environment variable, or filesystem path.

## Supported repair

The reference implementation supports one repair only: create one known generated module after the exact supported missing-module failure. Unknown failures stop without mutation. The runner never commits or pushes changes.

## Limits

The runner applies command time, output, file-count, and workspace-size limits. It disables Git hooks and unsafe system Git configuration. It rejects symlinks and paths outside the workspace. It removes every temporary workspace after the run. The local HTTP runner stores completed receipts in process memory. That map is not durable replay storage.

## Secrets

Do not place credentials in repository files, receipts, test fixtures, command output, or issue reports. Production configuration belongs in the deployment environment.
