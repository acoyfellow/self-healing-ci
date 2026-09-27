# Publication assessment

Status: public reference. Not a production service.

The implementation is a bounded repair reference. It is not an autonomous repair service. It does not commit, push, or open pull requests.

## Verified

- The coordinator requires an operator bearer token.
- Repository identifiers and exact commit SHAs are allowlisted.
- The runner uses a fresh temporary Git checkout.
- The runner uses an argument allowlist and does not invoke a shell.
- Local runner replay is process-local and is not a production durable store.
- Tests, repair, retry, diff capture, hashes, receipt validation, and cleanup use real local execution.
- The license is MIT.
- The public history is a single squashed commit with no machine-specific paths.
- `workers_dev` is disabled. No public deployment exists.

## Open before production use

- Review the external runner deployment boundary.
- Review the repository and commit allowlist configuration.

Do not describe the project as an autonomous repair system.
