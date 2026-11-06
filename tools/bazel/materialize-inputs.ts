// Turbopack refuses a symlink that points outside its root. Bazel's sandbox
// gives every input as an absolute symlink into the execroot, outside the
// sandbox, so a Turbopack build stops at the first file it reads. This script
// replaces each such link under a root with the file it points to: a clone
// where the file system supports clones, such as APFS, a hard link elsewhere.
// Relative links stay. They hold the pnpm layout of node_modules and point
// inside the root.
//
// Run it in a process with rules_js's fs patch off (JS_BINARY__PATCH_NODE_FS=0).
// The patch shows links that leave the sandbox as regular files, so a patched
// process finds nothing to replace. Turbopack reads files in Rust, past the
// patch, and sees the links.
import fs from "node:fs";
import path from "node:path";

type Place = (from: string, to: string) => void;

// libuv implements a forced clone only on Linux. On macOS it clones through
// copyfile(3), which copies where the file system cannot clone.
const clone: Place = (from, to) =>
  fs.copyFileSync(
    from,
    to,
    process.platform === "darwin" ? fs.constants.COPYFILE_FICLONE : fs.constants.COPYFILE_FICLONE_FORCE,
  );
const hardLink: Place = (from, to) => fs.linkSync(from, to);
const copy: Place = (from, to) => fs.copyFileSync(from, to);

function inside(root: string, file: string) {
  const relative = path.relative(root, file);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Replaces every link under `root` whose absolute target lies outside `root`. */
export default function materializeInputs(root: string) {
  let place: Place | undefined;
  // The first file picks the fastest method that works on this file system.
  const placeFile = (from: string, to: string) => {
    if (place) return place(from, to);
    for (const candidate of [clone, hardLink]) {
      try {
        candidate(from, to);
        place = candidate;
        return;
      } catch {
        fs.rmSync(to, { force: true });
      }
    }
    place = copy;
    copy(from, to);
  };
  const put = (from: string, to: string) => {
    let stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) {
      // A hard link to a link would copy the link, not the file.
      from = fs.realpathSync.native(from);
      stat = fs.statSync(from);
    }
    if (!stat.isDirectory()) return placeFile(from, to);
    fs.mkdirSync(to);
    for (const name of fs.readdirSync(from)) put(path.join(from, name), path.join(to, name));
  };
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const at = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(at);
      else if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(at);
        if (!path.isAbsolute(target) || inside(root, target)) continue;
        fs.unlinkSync(at);
        put(target, at);
      }
    }
  };
  walk(root);
}

if (import.meta.main) materializeInputs(path.resolve(process.argv[2]!));
