#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_INTENT_SHA_FILE="$PROJECT_DIR/.deploy-intended-sha"
DEPLOY_VERSION_FILE="$PROJECT_DIR/.deploy-version"
DEPLOY_SHA_FILE="$PROJECT_DIR/.deploy-sha"
DEPLOY_URL_FILE="$PROJECT_DIR/.deploy-url"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

compare_exact_sha() {
  local expected_sha="$1"
  local actual_sha="$2"
  local sha_pattern='^[0-9a-f]{40}([0-9a-f]{24})?$'

  if ! [[ "$expected_sha" =~ $sha_pattern ]]; then
    printf 'Expected deployment SHA is not a full commit SHA: %s\n' "$expected_sha" >&2
    return 1
  fi

  if ! [[ "$actual_sha" =~ $sha_pattern ]]; then
    printf 'Live deployment SHA is not a full commit SHA: %s\n' "$actual_sha" >&2
    return 1
  fi

  if [[ "$expected_sha" != "$actual_sha" ]]; then
    printf 'Live deployment SHA mismatch: expected %s, received %s\n' "$expected_sha" "$actual_sha" >&2
    return 1
  fi
}

write_value() {
  local output_file="$1"
  local value="$2"
  local temporary_file

  umask 077
  temporary_file="$(mktemp "${output_file}.XXXXXX")"
  printf '%s\n' "$value" >"$temporary_file"
  mv "$temporary_file" "$output_file"
}

assert_clean_commit() {
  if ! git -C "$PROJECT_DIR" diff --quiet || ! git -C "$PROJECT_DIR" diff --cached --quiet; then
    fail "deployment inputs must match HEAD; commit or discard tracked changes before deployment"
  fi
}

read_deploy_url() {
  local deploy_output_file="$1"

  node -e '
const fs = require("fs");
const output = fs.readFileSync(process.argv[1], "utf8");
const urls = output.match(/https:\/\/[^\s]+/g) ?? [];
const url = urls.find((value) => value.includes("workers.dev")) ?? urls[0] ?? "";
process.stdout.write(url.replace(/\/$/, ""));
' "$deploy_output_file"
}

read_deploy_version() {
  local deploy_output_file="$1"

  node -e '
const fs = require("fs");
const output = fs.readFileSync(process.argv[1], "utf8");
const match = output.match(/Current Version ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
process.stdout.write(match?.[1] ?? "");
' "$deploy_output_file"
}

read_live_sha() {
  local deploy_url="$1"

  curl --fail --silent --show-error --connect-timeout 10 --max-time 20 "$deploy_url/version" |
    node -e '
let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { body += chunk; });
process.stdin.on("end", () => {
  try {
    const response = JSON.parse(body);
    if (typeof response.sha !== "string") throw new Error("sha is missing");
    process.stdout.write(response.sha.trim());
  } catch (error) {
    console.error(`Invalid /version response: ${error.message}`);
    process.exit(1);
  }
});
'
}

verify_live_sha() {
  local expected_sha="$1"
  local deploy_url="$2"
  local maximum_attempts="${DEPLOY_SHA_VERIFY_ATTEMPTS:-12}"
  local attempt
  local live_sha=""

  if ! [[ "$maximum_attempts" =~ ^[1-9][0-9]*$ ]]; then
    fail "DEPLOY_SHA_VERIFY_ATTEMPTS must be a positive integer"
  fi

  for ((attempt = 1; attempt <= maximum_attempts; attempt += 1)); do
    if live_sha="$(read_live_sha "$deploy_url")" && compare_exact_sha "$expected_sha" "$live_sha"; then
      return 0
    fi

    if (( attempt < maximum_attempts )); then
      sleep 1
    fi
  done

  printf 'FAIL: deployed worker did not report expected SHA after %s attempts: expected %s, received %s\n' \
    "$maximum_attempts" "$expected_sha" "${live_sha:-unavailable}" >&2
  return 1
}

main() {
  local deploy_sha
  local deploy_output_file
  local deploy_url
  local deploy_version

  deploy_sha="$(git -C "$PROJECT_DIR" rev-parse --verify HEAD)" || fail "could not resolve HEAD"
  compare_exact_sha "$deploy_sha" "$deploy_sha" || fail "HEAD is not a full commit SHA"
  assert_clean_commit
  write_value "$DEPLOY_INTENT_SHA_FILE" "$deploy_sha"

  deploy_output_file="$(mktemp)"
  trap 'rm -f "$deploy_output_file"' RETURN
  if ! (cd "$PROJECT_DIR" && npx wrangler deploy --var "DEPLOY_SHA:$deploy_sha" "$@" | tee "$deploy_output_file"); then
    fail "wrangler deploy failed for SHA $deploy_sha"
  fi

  deploy_url="$(read_deploy_url "$deploy_output_file")"
  deploy_version="$(read_deploy_version "$deploy_output_file")"
  [[ -n "$deploy_url" ]] || fail "wrangler deploy did not report a deployed URL"
  [[ -n "$deploy_version" ]] || fail "wrangler deploy did not report a deployed version"
  verify_live_sha "$deploy_sha" "$deploy_url" || fail "post-deploy SHA verification failed"

  write_value "$DEPLOY_VERSION_FILE" "$deploy_version"
  write_value "$DEPLOY_SHA_FILE" "$deploy_sha"
  write_value "$DEPLOY_URL_FILE" "$deploy_url"
  printf 'DEPLOY-PASS sha=%s url=%s\n' "$deploy_sha" "$deploy_url"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
