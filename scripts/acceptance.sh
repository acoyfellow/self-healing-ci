#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

npm run lint
npm run typecheck
npm test
npm run test:deploy-sha
npx tsx runner/e2e.ts
node scripts/secret-scan.mjs
git diff --check
printf 'PASS acceptance gate\n'
