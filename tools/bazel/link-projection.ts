// Puts a projection where the repository keeps its packages, inside the
// current action. Each package lands at its own directory, such as
// packages/ui, next to the package's npm links that the action declares. The
// app's node_modules links to it, as pnpm links a workspace package. Modules
// then resolve their dependencies, and Next names them, exactly as in a build
// of the whole repository.
import fs from "node:fs";
import path from "node:path";

interface Manifest {
  app: string[];
  packages: { name: string; dir: string; links: string[] }[];
}

function link(target: string, at: string) {
  if (fs.lstatSync(at, { throwIfNoEntry: false }))
    throw new Error(`${at} already exists. The projection links workspace packages only in a sandboxed action.`);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(path.relative(path.dirname(at), target), at, "dir");
}

/**
 * Copies the projection's packages under `root` and links them from the app.
 * Refuses to write over existing files: outside a sandbox, packages/ui holds
 * other actions' outputs.
 */
export default function linkProjection(projection: string, root: string, app: string) {
  const manifest = JSON.parse(fs.readFileSync(path.join(projection, "projection.json"), "utf8")) as Manifest;
  const dirs = new Map(manifest.packages.map((pkg) => [pkg.name, path.join(root, pkg.dir)]));
  for (const pkg of manifest.packages) {
    const target = dirs.get(pkg.name)!;
    if (fs.existsSync(path.join(target, "package.json")))
      throw new Error(`${pkg.dir}/package.json already exists. The projection links workspace packages only in a sandboxed action.`);
    // The projection's files are links into Bazel's output tree. Copies keep
    // every path inside the action, where Node's module resolution stays.
    fs.cpSync(path.join(projection, pkg.dir), target, { recursive: true, dereference: true });
  }
  for (const pkg of manifest.packages)
    for (const dep of pkg.links) link(dirs.get(dep)!, path.join(dirs.get(pkg.name)!, "node_modules", dep));
  for (const name of manifest.app) link(dirs.get(name)!, path.join(root, app, "node_modules", name));
}
