# Architecture

The Worker accepts authenticated requests and starts a durable Workflow. The Workflow records the request and calls an authenticated runner service. The Worker does not run a shell.

The runner receives only a server-approved repository identifier, immutable commit SHA, run ID, and idempotency key. It resolves the repository from a server-side allowlist. It creates a fresh temporary directory, checks out the exact SHA, runs the fixed test command, classifies one supported missing-module failure, applies one fixed template, reruns the same command, derives the actual diff, and destroys the workspace.

The receipt contains observed command status, bounded output digests, hashes, timestamps, the checked-out SHA, the actual diff, and a digest of the complete receipt. The receipt is immutable after completion.

## Failure behavior

A malformed request receives a generic client error. An unknown repository, SHA mismatch, unsupported failure, runner timeout, or unavailable runner stops without repair. A duplicate idempotency key returns the original result and does not start another repair. A retry cannot exceed one repair.

## Local and production execution

`runner/local-runner.ts` provides the local Node implementation. `runner/server.ts` is a local HTTP boundary for that runner. Its completed-run map lives in process memory and is lost on restart. Production requires an external runner service with durable replay storage, authenticated requests, and replay-resistant IDs. Cloudflare Workflows coordinates execution but does not provide filesystem or subprocess access.

The initial repair policy creates one known generated module. It does not edit arbitrary files, install dependencies, commit changes, push changes, or open pull requests.
