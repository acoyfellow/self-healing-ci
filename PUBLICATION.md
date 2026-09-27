# Publication assessment

Status: not ready.

The implementation is a bounded repair reference. It is not an autonomous repair service. It does not commit, push, or open pull requests.

## Verified

- The coordinator requires an operator bearer token.
- Repository identifiers and exact commit SHAs are allowlisted.
- The runner uses a fresh temporary Git checkout.
- The runner uses an argument allowlist and does not invoke a shell.
- Local runner replay is process-local and is not a production durable store.
- Tests, repair, retry, diff capture, hashes, receipt validation, and cleanup use real local execution.
- The acceptance command checks current files. History scanning is a separate owner publication check.

## Owner action needed

- Choose and approve a license.
- Review the external runner deployment boundary.
- Review the repository and commit allowlist configuration.
- Decide whether the historical machine-specific path in the acceptance scan may be removed by an authorized history rewrite.
- Create the public repository only after these actions are complete.

Until these actions are complete, do not describe the project as open-source ready or as an autonomous repair system.
