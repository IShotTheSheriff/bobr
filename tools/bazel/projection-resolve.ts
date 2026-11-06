// Module resolution for the projection. It answers the same question as the
// bundler and TypeScript, "which file does this import load?", and returns
// every file any of them could pick: each export condition Next or TypeScript
// uses, every extension, both `x.ts` and `x/index.ts`. A file that is only
// possibly loaded still enters the projection, which costs a rebuild but never
// drops code a build reads.
import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import ts from "typescript";

export interface PackageJson {
  name?: string;
  exports?: unknown;
  imports?: unknown;
  main?: unknown;
  module?: unknown;
  browser?: unknown;
  sideEffects?: unknown;
  dependencies?: Record<string, string>;
}

export interface WorkspacePackage {
  name: string;
  /** Where this action reads the package, the npm_package output. */
  source: string;
  /** Directory relative to the repository root, where builds see the package. */
  dir: string;
  json: PackageJson;
}

export const CODE_EXTENSIONS = [".tsx", ".ts", ".mts", ".cts", ".jsx", ".js", ".mjs", ".cjs"];
export const STYLE_EXTENSIONS = [".css", ".scss", ".sass", ".less"];
const RESOLVE_EXTENSIONS = [...CODE_EXTENSIONS, ".json"];
// TypeScript and Next both load `x.ts` for an import of `x.js`.
const SOURCE_FOR: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

// The condition sets of Next's client, server components, SSR and edge
// layers, and TypeScript's. Packages resolve under each one, and the union of
// the results enters the projection.
export const RUNTIME_CONDITIONS = [
  ["browser", "import", "module", "webpack", "production", "default"],
  ["react-server", "node", "import", "module", "webpack", "production", "default"],
  ["node", "import", "require", "module", "webpack", "production", "default"],
  ["edge-light", "worker", "browser", "import", "module", "webpack", "production", "default"],
];
export const TYPE_CONDITIONS = [
  ["types", "import", "default"],
  ["types", "require", "default"],
  ...RUNTIME_CONDITIONS,
];
const STYLE_CONDITIONS = [
  ["style", "browser", "import", "default"],
  ["sass", "style", "import", "default"],
];

export type Resolved =
  | { kind: "files"; files: string[] }
  | { kind: "external"; name: string }
  | { kind: "unresolved" };

export function isFile(file: string) {
  return fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;
}

export function isDirectory(dir: string) {
  return fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

export function readJson(file: string): PackageJson {
  return JSON.parse(fs.readFileSync(file, "utf8")) as PackageJson;
}

/** Files a path can stand for: itself, its TypeScript source, extensions and index files. */
export function fileCandidates(base: string, extensions = RESOLVE_EXTENSIONS): string[] {
  const found = new Set<string>();
  const add = (file: string) => {
    if (isFile(file)) found.add(file);
  };
  add(base);
  const ext = path.extname(base);
  for (const source of SOURCE_FOR[ext] ?? []) add(base.slice(0, -ext.length) + source);
  for (const extension of extensions) {
    add(base + extension);
    add(path.join(base, "index" + extension));
  }
  return [...found];
}

/** Sass and Less partials: `@use "a/b"` loads `a/_b.scss` or `a/b/_index.scss`. */
export function styleCandidates(base: string): string[] {
  const found = new Set(fileCandidates(base, STYLE_EXTENSIONS));
  const dir = path.dirname(base);
  const name = path.basename(base);
  for (const extension of ["", ...STYLE_EXTENSIONS]) {
    for (const file of [
      path.join(dir, "_" + name + extension),
      path.join(base, "_index" + extension),
    ])
      if (isFile(file)) found.add(file);
  }
  return [...found];
}

// Node's PATTERN_KEY_COMPARE: the longer prefix wins, then the longer key.
function patternMatch(map: Record<string, unknown>, key: string) {
  if (!key.includes("*") && Object.hasOwn(map, key)) return { target: map[key], star: "" };
  let best: { key: string; prefix: string; suffix: string } | undefined;
  for (const candidate of Object.keys(map)) {
    const star = candidate.indexOf("*");
    if (star === -1 || candidate.indexOf("*", star + 1) !== -1) continue;
    const prefix = candidate.slice(0, star);
    const suffix = candidate.slice(star + 1);
    if (
      key.startsWith(prefix) &&
      key !== prefix &&
      key.endsWith(suffix) &&
      key.length >= candidate.length &&
      (!best ||
        prefix.length > best.prefix.length ||
        (prefix.length === best.prefix.length && candidate.length > best.key.length))
    )
      best = { key: candidate, prefix, suffix };
  }
  if (best)
    return {
      target: map[best.key],
      star: key.slice(best.prefix.length, key.length - best.suffix.length),
    };
  // Deprecated folder mappings such as "./utils/": "./src/utils/".
  const folder = Object.keys(map)
    .filter((candidate) => candidate.endsWith("/") && key.startsWith(candidate))
    .sort((a, b) => b.length - a.length)[0];
  if (folder) return { target: map[folder], star: "", rest: key.slice(folder.length) };
  return undefined;
}

type Target = { file: string } | { bare: string };

// A target under every condition set. Arrays are fallbacks, which webpack tries
// in order when a file is missing, so the union keeps them all.
function targets(target: unknown, star: string, rest: string, root: string, conditions: string[][]): Target[] {
  if (typeof target === "string") {
    const value = target.replaceAll("*", star) + rest;
    return value.startsWith("./") ? [{ file: path.join(root, value) }] : [{ bare: value }];
  }
  if (Array.isArray(target)) return target.flatMap((item) => targets(item, star, rest, root, conditions));
  if (!target || typeof target !== "object") return [];
  const found: Target[] = [];
  for (const set of conditions) {
    for (const [condition, value] of Object.entries(target)) {
      if (condition !== "default" && !set.includes(condition)) continue;
      const resolved = targets(value, star, rest, root, conditions);
      found.push(...resolved);
      // Node stops at the first matching condition, even when it maps to null.
      break;
    }
  }
  return found;
}

function exportsMap(exports: unknown): Record<string, unknown> {
  if (typeof exports === "string" || Array.isArray(exports)) return { ".": exports };
  if (exports && typeof exports === "object") {
    const keys = Object.keys(exports);
    if (keys.length && keys.every((key) => !key.startsWith("."))) return { ".": exports };
    return exports as Record<string, unknown>;
  }
  return {};
}

export interface ResolverOptions {
  app: string;
  packages: WorkspacePackage[];
  conditions: string[][];
}

export class Resolver {
  readonly app: string;
  readonly packages: WorkspacePackage[];
  readonly conditions: string[][];
  readonly appJson: PackageJson;
  private readonly paths: Record<string, string[]>;
  private readonly pathsBase: string;
  readonly verbatimModuleSyntax: boolean;
  readonly tsFiles: string[];

  constructor({ app, packages, conditions }: ResolverOptions) {
    this.app = app;
    this.packages = packages;
    this.conditions = conditions;
    this.appJson = isFile(path.join(app, "package.json")) ? readJson(path.join(app, "package.json")) : {};
    const config = path.join(app, "tsconfig.json");
    const parsed = isFile(config) ? parseTsconfig(config) : undefined;
    this.paths = (parsed?.options.paths as Record<string, string[]> | undefined) ?? {};
    this.pathsBase = (parsed?.options.pathsBasePath as string | undefined) ?? app;
    this.verbatimModuleSyntax = parsed?.options.verbatimModuleSyntax === true;
    this.tsFiles = parsed?.fileNames ?? [];
  }

  /** The workspace package whose source holds `file`. */
  packageOf(file: string): WorkspacePackage | undefined {
    return this.packages.find((pkg) => file === pkg.source || file.startsWith(pkg.source + path.sep));
  }

  workspace(name: string) {
    return this.packages.find((pkg) => pkg.name === name);
  }

  /**
   * Where the package or app directory that holds `file` lives, for `#imports`.
   */
  private scope(file: string): { root: string; json: PackageJson } {
    const pkg = this.packageOf(file);
    return pkg ? { root: pkg.source, json: pkg.json } : { root: this.app, json: this.appJson };
  }

  resolve(specifier: string, from: string, style = false): Resolved {
    // A query or fragment ends the path, except the "#" that starts a package import.
    const request = specifier.replace(/(?!^)[?#].*$/s, "");
    if (!request) return { kind: "unresolved" };
    const candidates = style ? styleCandidates : fileCandidates;
    if (request.startsWith(".") || path.isAbsolute(request)) {
      const files = candidates(path.resolve(path.dirname(from), request));
      return files.length ? { kind: "files", files } : { kind: "unresolved" };
    }
    if (request.startsWith("node:") || isBuiltin(request)) return { kind: "external", name: request };
    if (request.startsWith("#")) return this.packageImports(request, from, style);
    // Next and TypeScript apply the app's tsconfig `paths` to every file,
    // shared packages included, and fall back to packages when nothing matches.
    const aliased = this.alias(request).flatMap((target) => candidates(target));
    if (aliased.length) return { kind: "files", files: aliased };
    return this.bare(request.startsWith("~") ? request.slice(1) : request, style);
  }

  private bare(request: string, style: boolean): Resolved {
    const parts = request.split("/");
    const name = request.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
    const pkg = this.workspace(name);
    if (!pkg) return { kind: "external", name };
    const subpath = "." + request.slice(name.length);
    const files = this.packageSubpath(pkg, subpath, style);
    return files.length ? { kind: "files", files } : { kind: "unresolved" };
  }

  packageSubpath(pkg: WorkspacePackage, subpath: string, style = false): string[] {
    const conditions = style ? [...STYLE_CONDITIONS, ...this.conditions] : this.conditions;
    const candidates = style ? styleCandidates : fileCandidates;
    if (pkg.json.exports !== undefined) {
      const match = patternMatch(exportsMap(pkg.json.exports), subpath);
      if (!match) return [];
      return [
        ...new Set(
          targets(match.target, match.star, match.rest ?? "", pkg.source, conditions).flatMap((target) =>
            "file" in target ? candidates(target.file) : [],
          ),
        ),
      ];
    }
    if (subpath !== ".") return candidates(path.join(pkg.source, subpath));
    const mains = [pkg.json.browser, pkg.json.module, pkg.json.main, "index"].filter(
      (main): main is string => typeof main === "string",
    );
    return [...new Set(mains.flatMap((main) => candidates(path.join(pkg.source, main))))];
  }

  private packageImports(request: string, from: string, style: boolean): Resolved {
    const { root, json } = this.scope(from);
    if (!json.imports || typeof json.imports !== "object") return { kind: "unresolved" };
    const match = patternMatch(json.imports as Record<string, unknown>, request);
    if (!match) return { kind: "unresolved" };
    const conditions = style ? [...STYLE_CONDITIONS, ...this.conditions] : this.conditions;
    const files = new Set<string>();
    for (const target of targets(match.target, match.star, match.rest ?? "", root, conditions)) {
      if ("file" in target) for (const file of (style ? styleCandidates : fileCandidates)(target.file)) files.add(file);
      else {
        const resolved = this.bare(target.bare, style);
        if (resolved.kind === "files") for (const file of resolved.files) files.add(file);
        else if (resolved.kind === "external") return resolved;
      }
    }
    return files.size ? { kind: "files", files: [...files] } : { kind: "unresolved" };
  }

  // tsconfig `paths`: as in TypeScript, the pattern with the longest prefix wins.
  private alias(specifier: string): string[] {
    let best: { prefix: string; suffix: string; wildcard: boolean; targets: string[] } | undefined;
    for (const [pattern, targets] of Object.entries(this.paths)) {
      const [prefix = "", suffix = ""] = pattern.split("*");
      const wildcard = pattern.includes("*");
      const matches = wildcard
        ? specifier.length >= prefix.length + suffix.length && specifier.startsWith(prefix) && specifier.endsWith(suffix)
        : specifier === pattern;
      if (matches && (!best || prefix.length > best.prefix.length)) best = { prefix, suffix, wildcard, targets };
    }
    if (!best) return [];
    const middle = best.wildcard ? specifier.slice(best.prefix.length, specifier.length - best.suffix.length) : "";
    return best.targets.map((target) => path.resolve(this.pathsBase, target.replace("*", middle)));
  }

  /**
   * Whether the bundler may skip `file` when nothing it exports is used:
   * `sideEffects: false`, or a list of globs that leaves the file out. Next
   * always keeps stylesheets.
   */
  sideEffectFree(file: string): boolean {
    if (STYLE_EXTENSIONS.includes(path.extname(file))) return false;
    const pkg = this.packageOf(file);
    if (!pkg) return false;
    const flag = pkg.json.sideEffects;
    if (flag === false) return true;
    if (!Array.isArray(flag)) return false;
    const relative = path.relative(pkg.source, file).split(path.sep).join("/");
    return !flag.some((pattern) => typeof pattern === "string" && sideEffectsGlob(pattern).test(relative));
  }
}

const BUILTINS = new Set(builtinModules);

function isBuiltin(request: string) {
  return BUILTINS.has(request.split("/")[0]!) || BUILTINS.has(request);
}

// webpack matches a pattern without a slash against the file name anywhere.
function sideEffectsGlob(pattern: string): RegExp {
  const normalized = pattern.replace(/^\.\//, "");
  const glob = normalized.includes("/") ? normalized : "**/" + normalized;
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === "*" && glob[i + 1] === "*") {
      source += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + source + "$");
}

export function parseTsconfig(config: string): ts.ParsedCommandLine {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    config,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    },
  )!;
  // TS18003 only reports that no file matched `include`.
  const errors = parsed.errors.filter((diagnostic) => diagnostic.code !== 18003);
  if (errors.length)
    throw new Error(errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n"));
  return parsed;
}
