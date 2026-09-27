import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
const rules = [
  /CLOUDFLARE_API_TOKEN\s*=/i,
  /Bearer\s+[A-Za-z0-9._~+\/-]{20,}/i,
  /(?:token|secret|password|authorization|api[_-]?key)\s*[:=]\s*[A-Za-z0-9._~+\/-]{24,}/i,
  /[/]Users[/]|[/]home[/]|[/]private[/]var[/]/,
  new RegExp(["31b91e7f", "9954ad8a", "a334d46f", "012bd8ed"].join("")),
];
const findings = [];
for (const file of files) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch { continue; }
  if (file === "package-lock.json") continue;
  const scanText = text.split("\n").filter((line) => !line.includes("process.env.")).join("\n");
  for (const rule of rules) if (rule.test(scanText)) findings.push(file);
}
if (findings.length) {
  process.stderr.write(`secret scan failed for ${[...new Set(findings)].length} files\n`);
  process.exit(1);
}
process.stdout.write(`PASS secret scan checked ${files.length} files\n`);
