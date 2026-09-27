# Contributing

Keep changes small and evidence-backed.

Before opening a pull request:

```sh
npm run typecheck
npm test
npm run test:deploy-sha
npm run scan:secrets
bash scripts/acceptance.sh
```

Do not add credentials, private account identifiers, machine-specific paths, deployment output, local receipts, or secret-scan artifacts.

Do not add a repair policy without a structured failure classification, a bounded test, and an independently reproducible receipt.

Do not claim production runner support unless the authenticated runner contract and failure behavior are tested.
