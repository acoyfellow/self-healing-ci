import { execFileSync } from "node:child_process";

const rules = [
  /\/Users\/[A-Za-z0-9._-]+/i,
  /(?:api[_-]?token|password|secret|private[_-]?key)\s*[:=]\s*[A-Za-z0-9._+/-]{24,}/i,
  /Bearer\s+[A-Za-z0-9._~+/-]{24,}/i,
];

const commits = execFileSync("git", ["rev-list", "--all"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
let findings = 0;
const findingCommits = [];
for (const commit of commits) {
  const text = execFileSync("git", ["show", "--format=", "--no-ext-diff", commit], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (rules.some((rule) => rule.test(text))) {
    findings += 1;
    findingCommits.push(commit);
  }
}
if (findings > 0) {
  console.error(`owner action needed: history scan found ${findings} commits: ${findingCommits.join(",")}`);
  process.exit(2);
}
console.log(`PASS history scan checked ${commits.length} commits`);
