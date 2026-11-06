// The equivalence check. Compares the deployment archive built from the
// projection with the one built from every workspace package whole. Turbopack
// names chunks by content and modules by path, so the two archives match byte
// for byte apart from per-build secrets and sandbox paths. Any other
// difference means the projection dropped or changed something Next reads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";

// Absolute paths into the action's sandbox, which differ for every action.
// Loader requests in module names carry them URL-encoded.
const EXECROOT = /(?:\/[\w.@+~-]+)*\/execroot\/_main\//g;
const ENCODED_EXECROOT = /(?:%2F[\w.@+~-]+)*%2Fexecroot%2F_main%2F/g;
// Next generates new server action and preview mode secrets for every build.
// Their JSON appears compact, indented and escaped inside a JavaScript string.
const SECRET =
  /(\\*"(?:encryptionKey|bypassToken|previewModeId|previewModeSigningKey|previewModeEncryptionKey)\\*":\s*\\*")[^"\\]*/g;
// Vercel's and Next's build traces hold timings and random ids.
const SKIPPED = ["diagnostics/", "static/_next/__private/trace"];

export function normalize(text: string) {
  return text
    .replace(EXECROOT, "<execroot>/")
    .replace(ENCODED_EXECROOT, "<execroot>%2F")
    .replace(SECRET, "$1<secret>");
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
  const dir = fs.mkdtempSync(path.join(process.env.TEST_TMPDIR || os.tmpdir(), "archive-"));
  tar.x({ file: archive, cwd: dir, sync: true, preservePaths: false });
  return dir;
}

function read(file: string) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) return "link:" + fs.readlinkSync(file);
  return normalize(fs.readFileSync(file).toString("latin1"));
}

// The first line where two texts differ, with a little context.
function firstDifference(a: string, b: string) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  const from = Math.max(0, i - 80);
  return `  projected: ${JSON.stringify(a.slice(from, i + 80))}\n  whole:     ${JSON.stringify(b.slice(from, i + 80))}`;
}

export function compare(projectedArchive: string, wholeArchive: string): string[] {
  const projected = extract(projectedArchive);
  const whole = extract(wholeArchive);
  const left = new Map(files(projected).map((f) => [normalize(f), f]));
  const right = new Map(files(whole).map((f) => [normalize(f), f]));
  const problems: string[] = [];
  for (const name of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const a = left.get(name);
    const b = right.get(name);
    if (!a || !b) {
      problems.push(`${name}: only in the ${a ? "projected" : "whole"} build`);
      continue;
    }
    const x = read(path.join(projected, a));
    const y = read(path.join(whole, b));
    if (x !== y) problems.push(`${name}: contents differ\n${firstDifference(x, y)}`);
  }
  return problems;
}

if (import.meta.main) {
  const [projected, whole] = process.argv.slice(2) as [string, string];
  const problems = compare(projected, whole);
  if (problems.length) {
    console.error(`The projected build differs from the build of whole workspace packages in ${problems.length} files:\n`);
    console.error(problems.join("\n\n"));
    process.exitCode = 1;
  } else console.log("The projected build matches the build of whole workspace packages.");
}
