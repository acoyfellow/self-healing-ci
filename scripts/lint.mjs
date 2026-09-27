import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
const privateAccountIdentifier = ["31b91e7f", "9954ad8a", "a334d46f", "012bd8ed"].join("");
const forbidden = [
  { pattern: /shell\s*:\s*true/, message: "shell execution is forbidden" },
  { pattern: /[/]Users[/]|[/]home[/]|[/]private[/]var[/]/, message: "machine-specific absolute path is forbidden" },
  { pattern: new RegExp(privateAccountIdentifier), message: "private account identifier is forbidden" },
];
const failures = [];
for (const file of files) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch { continue; }
  for (const rule of forbidden) if (rule.pattern.test(text)) failures.push(`${file}: ${rule.message}`);
}
if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`PASS lint scanned ${files.length} tracked files\n`);
