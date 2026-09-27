#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$PROJECT_DIR/proof/deploy-exact-sha.sh"

expected_sha="0123456789abcdef0123456789abcdef01234567"
mismatched_sha="fedcba9876543210fedcba9876543210fedcba98"
short_sha="0123456789ab"

if ! compare_exact_sha "$expected_sha" "$expected_sha"; then
  printf 'matching full SHA must pass\n' >&2
  exit 1
fi

if compare_exact_sha "$expected_sha" "$mismatched_sha"; then
  printf 'mismatched full SHA must fail\n' >&2
  exit 1
fi

if compare_exact_sha "$expected_sha" "$short_sha"; then
  printf 'short SHA must fail\n' >&2
  exit 1
fi

printf 'PASS exact SHA comparison rejects mismatched and short SHAs\n'
