# Self-Healing CI Reference

This repository is a bounded reference implementation for authenticated CI repair.

It supports exactly one repair policy:

1. Check out one allowlisted repository at one exact immutable commit.
2. Run one fixed test command in a fresh temporary workspace.
3. Recognize one structured missing-generated-module failure.
4. Create one known generated module from a fixed template.
5. Run the same test command again.
6. Return a durable receipt derived from the observed execution.
7. Destroy the temporary workspace.

It refuses unknown failures, arbitrary commands, arbitrary patches, branches, URLs, environment variables, source-repository mutation, commits, pushes, and pull requests. It is not a general autonomous repair system and it does not claim AI or agent reasoning.

## Execution model

The Cloudflare Worker and Workflow are durable coordinators. They do not provide a shell or a filesystem. Production execution requires an authenticated external runner with replay-resistant run IDs and bounded request and response schemas.

`runner/local-runner.ts` provides the real local Node runner. It uses a fresh temporary Git checkout, exact SHA verification, `shell: false`, fixed executable checks, bounded output, command time, file count, workspace size, Git hook suppression, symlink rejection, path containment, actual Git diff capture, and cleanup.

## Receipt

The versioned receipt records the run ID, idempotency key, repository ID, requested and checked-out SHA, runner identity, command results and output digests, failure classification, repair policy, before and after hashes, actual diff and digest, retry result, final HEAD, dirty-state assertion, step timestamps, terminal outcome, and receipt digest.

## Local development

```sh
npm install
npm run typecheck
npm test
npm run test:deploy-sha
```

The complete acceptance command will run the checks in order:

```sh
bash scripts/acceptance.sh
```

The acceptance command must be run from a clean, configured checkout. It does not deploy or publish.

## Interruption and replay

A command timeout terminates the subprocess and produces no repair. A runner timeout or unavailable runner produces a terminal failure. Workflow replay must reuse the same run ID and idempotency key. The runner must return the stored result for a duplicate key and must not execute a second repair.

## Publication

The package currently uses `UNLICENSED` because ownership and licensing policy have not been confirmed. Choosing and adding an open-source license is the remaining human and legal publication decision.

See [ARCHITECTURE.md](ARCHITECTURE.md), [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [PUBLICATION.md](PUBLICATION.md).
