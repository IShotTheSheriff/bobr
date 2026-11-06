// The oracle. Compares a deployment archive CI reused from cache with a fresh
// build of the current tree. Turbopack names chunks by content and modules by
// path, so two builds of the same inputs match byte for byte apart from
// per-build secrets and the checkout's absolute path. Any other difference
// means the cache key missed something Next reads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";

// Next generates new server action and preview mode secrets for every build.
// Their JSON appears compact, indented and escaped inside a JavaScript string.
const SECRET =
  /(\\*"(?:encryptionKey|bypassToken|previewModeId|previewModeSigningKey|previewModeEncryptionKey)\\*":\s*\\*")[^"\\]*/g;
// Vercel's and Next's build traces hold timings and random ids.
const SKIPPED = ["diagnostics/", "static/_next/__private/trace"];

export function normalize(text: string) {
  return text.replace(SECRET, "$1<secret>");
}

function files(dir: string, prefix = ""): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const relative = prefix + entry.name;
      if (SKIPPED.some((skipped) => relative === skipped || relative.startsWith(skipped))) return [];
      if (entry.isDirectory()) return files(path.join(dir, entry.name), relative + "/");
      return [relative];
    });
}

function extract(archive: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-"));
  tar.x({ file: archive, cwd: dir, sync: true, preservePaths: false });
  return dir;
}

// Next and Vercel record the checkout's absolute path, which differs between
// two clones. Next's server config names it as the tracing root.
function checkout(dir: string): string | undefined {
  for (const file of fs.globSync("functions/**/.next/required-server-files.json", { cwd: dir })) {
    const root = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")).config?.outputFileTracingRoot;
    if (typeof root === "string" && root.length > 1) return root;
  }
}

function read(file: string, root: string | undefined) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) return "link:" + fs.readlinkSync(file);
  const text = normalize(fs.readFileSync(file).toString("latin1"));
  return root ? text.replaceAll(root, "<checkout>") : text;
}

// The first line where two texts differ, with a little context.
function firstDifference(a: string, b: string) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  const from = Math.max(0, i - 80);
  return `  stored: ${JSON.stringify(a.slice(from, i + 80))}\n  fresh:  ${JSON.stringify(b.slice(from, i + 80))}`;
}

export function compare(storedArchive: string, freshArchive: string): string[] {
  const stored = extract(storedArchive);
  const fresh = extract(freshArchive);
  const left = new Map(files(stored).map((f) => [normalize(f), f]));
  const right = new Map(files(fresh).map((f) => [normalize(f), f]));
  const storedRoot = checkout(stored);
  const freshRoot = checkout(fresh);
  const problems: string[] = [];
  for (const name of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const a = left.get(name);
    const b = right.get(name);
    if (!a || !b) {
      problems.push(`${name}: only in the ${a ? "stored" : "fresh"} build`);
      continue;
    }
    const x = read(path.join(stored, a), storedRoot);
    const y = read(path.join(fresh, b), freshRoot);
    if (x !== y) problems.push(`${name}: contents differ\n${firstDifference(x, y)}`);
  }
  fs.rmSync(stored, { recursive: true });
  fs.rmSync(fresh, { recursive: true });
  return problems;
}

if (import.meta.main) {
  const [stored, fresh] = process.argv.slice(2) as [string, string];
  const problems = compare(stored, fresh);
  if (problems.length) {
    console.error(`The archives differ in ${problems.length} files:\n`);
    console.error(problems.join("\n\n"));
    process.exitCode = 1;
  } else console.log("The archives match.");
}
