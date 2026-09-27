#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_URL="${SELF_HEAL_URL:-}"
EXPECTED_SHA="${EXPECTED_SHA:-}"
TOKEN="${SELF_HEAL_TOKEN:-}"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
[[ "$BASE_URL" =~ ^https://[^[:space:]]+$ ]] || fail "SELF_HEAL_URL must be an https URL"
[[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "EXPECTED_SHA must be a full commit SHA"
[[ -n "$TOKEN" ]] || fail "SELF_HEAL_TOKEN is required"

actual_sha="$(curl --fail --silent --show-error --connect-timeout 10 --max-time 20 -H "authorization: Bearer $TOKEN" "$BASE_URL/version" | node -e '
let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { body += chunk; });
process.stdin.on("end", () => {
  try {
    const value = JSON.parse(body).sha;
    if (typeof value !== "string" || !/^[0-9a-f]{40}$/i.test(value)) throw new Error("invalid SHA");
    process.stdout.write(value.toLowerCase());
  } catch { process.exit(1); }
});
' )" || fail "version endpoint unavailable"

[[ "$actual_sha" == "${EXPECTED_SHA,,}" ]] || fail "deployed SHA does not match expected SHA"
printf 'PASS deployed SHA matches %s\n' "$EXPECTED_SHA"
