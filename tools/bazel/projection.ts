// The projection: the part of each workspace package an app reaches, written
// at the package's own path. Next builds and the type check read it instead of
// the full packages, so an edit an app cannot reach leaves the app's inputs
// byte-identical and Bazel reuses the app's build, tests and deployment.
//
// Modules keep their file names and their text. A file whose code needs
// Next's own compilation (JSX, "use client", CommonJS, styles, assets) is
// copied whole. Other modules lose the top-level statements that no used
// export reaches and that cannot run code (projection-slice.ts). When the
// projection meets a pattern it cannot follow, it widens the input instead of
// failing and records the case in the report. `--strict` makes every such
// case an error.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  CODE_EXTENSIONS,
  RUNTIME_CONDITIONS,
  Resolver,
  STYLE_EXTENSIONS,
  TYPE_CONDITIONS,
  isDirectory,
  isFile,
  readJson,
  type WorkspacePackage,
} from "./projection-resolve.ts";
import {
  analyze,
  parse,
  slice,
  wholeRefs,
  type ContextRef,
  type ModuleInfo,
  type ModuleRef,
  type Names,
  type Slice,
  type Untraceable,
} from "./projection-slice.ts";

export type { WorkspacePackage } from "./projection-resolve.ts";

export type Mode = "runtime" | "types" | "copy";

export interface ProjectOptions {
  mode: Mode;
  app: string;
  packages: WorkspacePackage[];
  out: string;
  report?: string;
  strict?: boolean;
  /** Paths in the report are relative to this directory. */
  root?: string;
}

export interface Fallback {
  file: string;
  pattern: string;
  width: Untraceable["width"] | "scanned";
  included: string[];
}

export interface Report {
  app: string;
  mode: Mode;
  packages: Record<string, { files: number; whole: number; sliced: number }>;
  fallbacks: Fallback[];
  unresolved: { file: string; specifier: string }[];
}

export interface Manifest {
  /** Workspace packages the app links from its own node_modules. */
  app: string[];
  packages: { name: string; dir: string; links: string[] }[];
}

// App Router files Next compiles by convention. Next 16; check on every major.
const APP_FILES = new Set([
  "page", "layout", "template", "loading", "error", "global-error", "not-found",
  "global-not-found", "forbidden", "unauthorized", "default", "route", "icon",
  "apple-icon", "opengraph-image", "twitter-image", "sitemap", "robots", "manifest",
]);
const ROOT_FILES = new Set(["middleware", "proxy", "instrumentation", "instrumentation-client", "mdx-components"]);
const DEFAULT_PAGE_EXTENSIONS = ["tsx", "ts", "jsx", "js"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".vercel", ".git"]);

function walk(dir: string): string[] {
  if (!isDirectory(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : walk(full);
      return entry.isFile() || entry.isSymbolicLink() ? [full] : [];
    });
}

const isCode = (file: string) => CODE_EXTENSIONS.includes(path.extname(file)) && !file.endsWith(".d.ts");
const isStyle = (file: string) => STYLE_EXTENSIONS.includes(path.extname(file));
const toPosix = (file: string) => file.split(path.sep).join("/");

/**
 * Files Next compiles without an import: App Router and Pages Router files for
 * the app's `pageExtensions`, root convention files and `next.config`.
 */
export function nextEntries(app: string): { files: string[]; notes: string[] } {
  const notes: string[] = [];
  const configs = fs.readdirSync(app).filter((name) => /^next\.config\.[cm]?[jt]s$/.test(name));
  let extensions = DEFAULT_PAGE_EXTENSIONS;
  for (const config of configs) {
    const text = fs.readFileSync(path.join(app, config), "utf8");
    if (!/\bpageExtensions\b/.test(text)) continue;
    const match = /\bpageExtensions\s*:\s*\[([^\]]*)\]/.exec(text);
    const values = match ? [...match[1]!.matchAll(/["']([\w.]+)["']/g)].map((m) => m[1]!) : [];
    if (values.length) extensions = values;
    else {
      // Without the list, every file in the route folders counts.
      extensions = [];
      notes.push(`${config} sets pageExtensions in a way the projection cannot read`);
    }
  }
  const pageExtension = (file: string) => {
    const name = path.basename(file);
    return extensions.length === 0 ? isCode(file) : extensions.some((ext) => name.endsWith("." + ext));
  };
  const stem = (file: string) => {
    const name = path.basename(file);
    const ext = extensions.find((e) => name.endsWith("." + e));
    return ext ? name.slice(0, -ext.length - 1) : name.replace(/\.[^.]+$/, "");
  };
  const files = new Set<string>();
  for (const dir of ["app", "src/app"])
    for (const file of walk(path.join(app, dir)))
      if (extensions.length === 0 ? isCode(file) : pageExtension(file) && APP_FILES.has(stem(file))) files.add(file);
  for (const dir of ["pages", "src/pages"])
    for (const file of walk(path.join(app, dir))) if (pageExtension(file) || (extensions.length === 0 && isCode(file))) files.add(file);
  for (const dir of [app, path.join(app, "src")]) {
    if (!isDirectory(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      if (isCode(file) && ROOT_FILES.has(name.replace(/\.[^.]+$/, ""))) files.add(file);
    }
  }
  for (const config of configs) files.add(path.join(app, config));
  return { files: [...files].sort(), notes };
}

// The ES module lines of an MDX page, which import its components.
function mdxModule(text: string) {
  return text
    .split("\n")
    .filter((line) => /^(import|export)\s/.test(line))
    .join("\n");
}

const merge = (a: Names | undefined, b: Names): Names => {
  if (a === "all" || b === "all") return "all";
  return new Set([...(a ?? []), ...b]);
};
const sameNames = (a: Names, b: Names) =>
  a === "all" ? b === "all" : b !== "all" && a.size === b.size && [...a].every((n) => b.has(n));

class Projection {
  readonly resolver: Resolver;
  readonly report: Report;
  private readonly requests = new Map<string, Names>();
  private readonly whole = new Set<string>();
  private readonly texts = new Map<string, string>();
  private readonly seen = new Set<string>();
  private readonly queue: string[] = [];
  private readonly infos = new Map<string, ModuleInfo | null>();
  private readonly declarations = new Map<string, Map<string, string | undefined>>();

  readonly options: ProjectOptions;
  readonly app: string;
  readonly root: string;

  constructor(options: ProjectOptions, app: string, root: string) {
    this.options = options;
    this.app = app;
    this.root = root;
    const types = options.mode === "types";
    this.resolver = new Resolver({ app, packages: options.packages, conditions: types ? TYPE_CONDITIONS : RUNTIME_CONDITIONS });
    this.report = {
      app: toPosix(path.relative(root, app)) || ".",
      mode: options.mode,
      packages: {},
      fallbacks: [],
      unresolved: [],
    };
  }

  get types() {
    return this.options.mode === "types";
  }

  /** A path as the repository sees it: workspace files at their package directory. */
  display(file: string) {
    const pkg = this.resolver.packageOf(file);
    if (pkg) return toPosix(path.join(pkg.dir, path.relative(pkg.source, file)));
    return toPosix(path.relative(this.root, file));
  }

  run(entries: string[]) {
    for (const entry of entries) this.request(entry, "all");
    for (let file = this.queue.shift(); file; file = this.queue.shift()) this.process(file);
  }

  request(file: string, names: Names) {
    const pkg = this.resolver.packageOf(file);
    if (!pkg) {
      if (!this.seen.has(file)) {
        this.seen.add(file);
        this.queue.push(file);
      }
      return;
    }
    const before = this.requests.get(file);
    const after = merge(before, names);
    if (before !== undefined && sameNames(before, after)) return;
    this.requests.set(file, after);
    this.queue.push(file);
  }

  private info(file: string): ModuleInfo | null {
    if (!this.infos.has(file)) {
      let text = fs.readFileSync(file, "utf8");
      if (/\.mdx?$/.test(file)) text = mdxModule(text);
      const parsed = analyze(file.replace(/\.mdx?$/, ".tsx"), text, !!this.resolver.packageOf(file));
      this.infos.set(file, parsed);
    }
    return this.infos.get(file)!;
  }

  private process(file: string) {
    if (isStyle(file)) return this.style(file);
    if (!isCode(file) && !/\.mdx?$/.test(file)) return;
    const info = this.info(file);
    if (!info) return;
    const pkg = this.resolver.packageOf(file);
    let result: Slice;
    if (!pkg || info.whole || this.whole.has(file)) result = wholeRefs(info, this.types);
    else {
      const names = this.requests.get(file) ?? new Set<string>();
      const declared = this.types ? this.declaration(pkg, file) : undefined;
      if (this.types && declared === undefined) result = wholeRefs(info, true);
      else {
        const target = declared ? analyze(file, declared, true) : info;
        result = slice(target, names, {
          types: this.types,
          verbatimModuleSyntax: this.resolver.verbatimModuleSyntax,
          skippable: (specifier) => this.skippable(specifier, file),
          exportsOf: (specifier) => this.exportsOf(specifier, file),
        });
        this.texts.set(file, result.text);
      }
    }
    if (this.types) for (const ref of typeReferences(file, result.text)) result.refs.push(ref);
    for (const ref of result.refs) this.follow(ref, file);
    for (const ref of result.contexts) this.context(ref, file);
    for (const item of result.untraceable) this.widen(item, file);
  }

  private follow(ref: ModuleRef, from: string) {
    const resolved = this.resolver.resolve(ref.specifier, from);
    if (resolved.kind === "unresolved") return this.unresolved(from, ref.specifier);
    if (resolved.kind === "external") return;
    for (const file of resolved.files) this.request(file, ref.kind === "asset" ? "all" : ref.names);
  }

  private unresolved(from: string, specifier: string) {
    const entry = { file: this.display(from), specifier };
    if (this.options.strict) throw new Error(`${entry.file}: cannot resolve ${specifier}`);
    if (!this.report.unresolved.some((u) => u.file === entry.file && u.specifier === specifier)) this.report.unresolved.push(entry);
  }

  // Whether the bundler skips every file this specifier can load when nothing
  // from it is used, so the projection can skip them too.
  private skippable(specifier: string, from: string) {
    const resolved = this.resolver.resolve(specifier, from);
    return resolved.kind === "files" && resolved.files.every((file) => this.resolver.sideEffectFree(file));
  }

  private exportsOf(specifier: string, from: string, seen = new Set<string>()): Set<string> | undefined {
    const resolved = this.resolver.resolve(specifier, from);
    if (resolved.kind !== "files") return undefined;
    const names = new Set<string>();
    for (const file of resolved.files) {
      if (seen.has(file)) continue;
      seen.add(file);
      if (!isCode(file)) return undefined;
      const info = this.info(file);
      if (!info || (info.whole && info.whole.includes("CommonJS"))) return undefined;
      for (const name of info.exportNames) names.add(name);
      for (const s of info.statements) {
        if (!s.star || s.star.as !== undefined) continue;
        const nested = this.exportsOf(s.star.specifier, file, seen);
        if (!nested) return undefined;
        for (const name of nested) if (name !== "default") names.add(name);
      }
    }
    return names;
  }

  // webpack's context module: every file under the static prefix that the
  // computed specifier can match.
  private context(ref: ContextRef, from: string) {
    const dirPart = ref.prefix.slice(0, ref.prefix.lastIndexOf("/") + 1);
    if (!dirPart.startsWith(".")) {
      const name = ref.prefix.startsWith("@") ? ref.prefix.split("/").slice(0, 2).join("/") : ref.prefix.split("/")[0]!;
      const pkg = this.resolver.workspace(name);
      if (pkg) this.widen({ pattern: `import(\`${ref.prefix}...\`)`, width: "package" }, from, pkg);
      return;
    }
    const dir = path.resolve(path.dirname(from), dirPart);
    for (const file of walk(dir)) {
      const specifier = dirPart + toPosix(path.relative(dir, file));
      if (ref.pattern.test(specifier)) this.request(file, "all");
    }
  }

  /** Includes a directory, a package or every package whole, for a pattern the projection cannot follow. */
  widen(item: Untraceable | { pattern: string; width: "scanned" }, from: string, pkg = this.resolver.packageOf(from), dir?: string) {
    let dirs: string[];
    if (item.width === "workspace") dirs = this.options.packages.map((p) => p.source);
    else if (item.width === "package") dirs = pkg ? [pkg.source] : this.options.packages.map((p) => p.source);
    else dirs = [dir ?? path.dirname(from)];
    const fallback: Fallback = {
      file: this.display(from),
      pattern: item.pattern,
      width: item.width,
      included: dirs.map((d) => this.display(d)),
    };
    const known = this.report.fallbacks.some((f) => f.file === fallback.file && f.pattern === fallback.pattern);
    if (!known) {
      if (this.options.strict && item.width !== "scanned")
        throw new Error(`${fallback.file}: ${fallback.pattern} needs ${fallback.included.join(", ")} whole (${item.width} fallback)`);
      this.report.fallbacks.push(fallback);
    }
    for (const d of dirs)
      for (const file of walk(d)) {
        if (!this.resolver.packageOf(file)) continue;
        if (!this.whole.has(file)) {
          this.whole.add(file);
          this.requests.delete(file);
        }
        this.request(file, "all");
      }
  }

  // Stylesheets: `@import`, Sass `@use`, `url()`, CSS modules `composes`, and
  // Tailwind's `@plugin`, `@config`, `@source` and `source()`.
  private style(file: string) {
    const text = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
    for (const m of text.matchAll(/@(import|use|forward|reference)\s+(?:url\(\s*)?(["'])([^"']+)\2/g)) {
      const resolved = this.resolver.resolve(m[3]!, file, true);
      if (resolved.kind === "files") resolved.files.forEach((f) => this.request(f, new Set()));
      else if (resolved.kind === "unresolved" && !/^(https?:)?\/\//.test(m[3]!)) this.unresolved(file, m[3]!);
    }
    for (const m of text.matchAll(/@(plugin|config)\s+(["'])([^"']+)\2/g)) this.follow({ specifier: m[3]!, kind: "dynamic", names: "all" }, file);
    for (const m of text.matchAll(/composes\s*:[^;]*?\bfrom\s+(["'])([^"']+)\1/g)) {
      const resolved = this.resolver.resolve(m[2]!, file, true);
      if (resolved.kind === "files") resolved.files.forEach((f) => this.request(f, new Set()));
    }
    for (const m of text.matchAll(/(?<!@import\s[^;]*)\burl\(\s*(["']?)([^"')]+)\1\s*\)/g)) {
      const url = m[2]!.trim();
      if (/^(data:|https?:|\/|#)/.test(url)) continue;
      const target = path.resolve(path.dirname(file), url.replace(/[?#].*$/, ""));
      if (isFile(target)) this.request(target, new Set());
      else this.unresolved(file, url);
    }
    for (const m of text.matchAll(/@source\s+(?!not\b|inline\()(["'])([^"']+)\1|\bsource\(\s*(["'])([^"']+)\3\s*\)/g))
      this.scanned(m[2] ?? m[4]!, file, m[0]);
  }

  /**
   * A directory Tailwind scans for class names. Its files must match the
   * source byte for byte, so the projection copies them whole.
   */
  scanned(pattern: string, from: string, directive: string) {
    if (pattern === "none") return;
    const glob = pattern.search(/[*?{[]/);
    const base = path.resolve(path.dirname(from), glob === -1 ? pattern : pattern.slice(0, glob));
    const dir = this.sourceDir(isFile(base) ? path.dirname(base) : base);
    for (const target of dir) this.widen({ pattern: directive, width: "scanned" }, from, this.resolver.packageOf(target), target);
  }

  // Where a repository path inside a workspace package, or behind its
  // node_modules link, sits in this action. A path above packages, such as the
  // repository root, covers every package.
  private sourceDir(target: string): string[] {
    if (this.resolver.packageOf(target)) return [target];
    const relative = toPosix(path.relative(this.root, target));
    const found: string[] = [];
    for (const pkg of this.options.packages) {
      if (relative === pkg.dir || relative.startsWith(pkg.dir + "/")) found.push(path.join(pkg.source, relative.slice(pkg.dir.length)));
      else if (relative === "" || pkg.dir.startsWith(relative + "/") || relative === "..") found.push(pkg.source);
      const link = relative.split("/node_modules/")[1];
      if (link && (link === pkg.name || link.startsWith(pkg.name + "/"))) found.push(path.join(pkg.source, link.slice(pkg.name.length)));
    }
    return found;
  }

  /** Tailwind 3 `content` globs that point into a workspace package. */
  tailwindContent() {
    for (const name of fs.readdirSync(this.app)) {
      if (!/^tailwind\.config\.[cm]?[jt]s$/.test(name)) continue;
      const file = path.join(this.app, name);
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(/(["'`])([^"'`\n]*[*/][^"'`\n]*)\1/g)) {
        const target = path.resolve(this.app, m[2]!);
        if (path.relative(this.app, target).startsWith("..") || m[2]!.includes("node_modules/"))
          this.scanned(m[2]!, file, `content: ${m[0]}`);
      }
    }
  }

  // Declarations for every TypeScript module of a package, emitted once. A
  // file whose declarations TypeScript cannot emit cleanly maps to undefined
  // and is copied whole, so the type check sees its full source.
  private declaration(pkg: WorkspacePackage, file: string): string | undefined {
    if (!/\.(tsx?|mts|cts)$/.test(file)) return undefined;
    let emitted = this.declarations.get(pkg.source);
    if (!emitted) {
      emitted = new Map();
      this.declarations.set(pkg.source, emitted);
      const roots = walk(pkg.source).filter((f) => /\.(tsx?|mts|cts)$/.test(f) && !f.endsWith(".d.ts"));
      const typeRoots = nearestTypeRoots(pkg.source);
      const program = ts.createProgram(roots, {
        declaration: true,
        emitDeclarationOnly: true,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.Preserve,
        strict: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        ...(typeRoots ? { typeRoots } : { types: [] }),
        rootDir: pkg.source,
        outDir: path.join(pkg.source, "__declarations__"),
      });
      const out = path.join(pkg.source, "__declarations__");
      const texts = new Map<string, string>();
      program.emit(undefined, (name, text) => texts.set(path.relative(out, name), text), undefined, true);
      for (const root of roots) {
        const source = program.getSourceFile(root);
        const clean =
          source &&
          program.getSyntacticDiagnostics(source).length === 0 &&
          program.getSemanticDiagnostics(source).length === 0 &&
          program.getDeclarationDiagnostics(source).length === 0;
        const key = path.relative(pkg.source, root).replace(/\.(tsx?|mts|cts)$/, (ext) => (ext === ".mts" ? ".d.mts" : ext === ".cts" ? ".d.cts" : ".d.ts"));
        emitted.set(root, clean ? texts.get(key) : undefined);
      }
    }
    return emitted.get(file);
  }

  write() {
    const { out, mode } = this.options;
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    const manifest: Manifest = { app: [], packages: [] };
    const appDeps = { ...this.resolver.appJson.dependencies, ...(mode === "types" ? (this.resolver.appJson as { devDependencies?: Record<string, string> }).devDependencies : {}) };
    for (const pkg of [...this.options.packages].sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(out, pkg.dir);
      fs.mkdirSync(target, { recursive: true });
      if (mode === "copy") fs.copyFileSync(path.join(pkg.source, "package.json"), path.join(target, "package.json"));
      else {
        // Resolvers read exports, imports, main fields, types and sideEffects.
        // No bundler or type checker reads these two, which change often.
        const { scripts: _scripts, devDependencies: _devDependencies, ...read } = pkg.json as Record<string, unknown>;
        fs.writeFileSync(path.join(target, "package.json"), JSON.stringify(read, null, 2) + "\n");
      }
      const counts = { files: 0, whole: 0, sliced: 0 };
      const files = mode === "copy" ? walk(pkg.source) : [...this.requests.keys(), ...this.whole].filter((f) => this.resolver.packageOf(f) === pkg);
      for (const file of [...new Set(files)].sort()) {
        const relative = path.relative(pkg.source, file);
        if (relative === "package.json") continue;
        const destination = path.join(target, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const text = this.whole.has(file) ? undefined : this.texts.get(file);
        if (text === undefined) {
          fs.copyFileSync(file, destination);
          counts.whole++;
        } else {
          fs.writeFileSync(destination, text);
          counts.sliced++;
        }
        counts.files++;
      }
      this.report.packages[pkg.name] = counts;
      const links = Object.keys(pkg.json.dependencies ?? {}).filter((name) => this.resolver.workspace(name));
      manifest.packages.push({ name: pkg.name, dir: pkg.dir, links: links.sort() });
      if (pkg.name in appDeps) manifest.app.push(pkg.name);
    }
    fs.writeFileSync(path.join(out, "projection.json"), JSON.stringify(manifest, null, 2) + "\n");
    if (this.options.report) {
      fs.mkdirSync(path.dirname(this.options.report), { recursive: true });
      fs.writeFileSync(this.options.report, JSON.stringify(this.report, null, 2) + "\n");
    }
  }
}

// `/// <reference path>` and `import("x")` types in declarations.
function typeReferences(file: string, text: string): ModuleRef[] {
  const source = parse(file, text);
  const refs: ModuleRef[] = source.referencedFiles.map((r) => ({ specifier: r.fileName.startsWith(".") ? r.fileName : "./" + r.fileName, kind: "import", names: "all" }));
  const visit = (node: ts.Node) => {
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      const first = node.qualifier && (ts.isIdentifier(node.qualifier) ? node.qualifier.text : leftmost(node.qualifier));
      refs.push({ specifier: node.argument.literal.text, kind: "import", names: first ? new Set([first]) : "all" });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return refs;
}

function leftmost(name: ts.EntityName): string {
  return ts.isIdentifier(name) ? name.text : leftmost(name.left);
}

function nearestTypeRoots(dir: string): string[] | undefined {
  for (let current = dir; ; current = path.dirname(current)) {
    const candidate = path.join(current, "node_modules", "@types");
    if (isDirectory(candidate)) return [candidate];
    if (path.dirname(current) === current) return undefined;
  }
}

export default function project(options: ProjectOptions): Report {
  const root = path.resolve(options.root ?? process.cwd());
  const app = path.resolve(options.app);
  const projection = new Projection(options, app, root);
  if (options.mode === "copy") {
    projection.write();
    return projection.report;
  }
  let entries: string[];
  if (options.mode === "types") {
    // tsc checks every file the tsconfig includes, tests among them. Next
    // writes .next/types after the projection, so a local .next is left over
    // from another build.
    entries = projection.resolver.tsFiles.filter(
      (file) => isFile(file) && !path.relative(app, file).split(path.sep).some((part) => SKIP_DIRS.has(part)),
    );
    if (!entries.length) entries = walk(app).filter(isCode);
  } else {
    const found = nextEntries(app);
    entries = found.files;
    for (const note of found.notes) {
      if (options.strict) throw new Error(note);
      projection.report.fallbacks.push({ file: projection.display(app), pattern: note, width: "directory", included: [] });
    }
    projection.tailwindContent();
  }
  projection.run(entries.map((file) => path.resolve(file)));
  projection.write();
  return projection.report;
}

export function packageArgument(value: string): WorkspacePackage {
  const [name, source, dir] = value.split("=");
  if (!name || !source || !dir) throw new Error(`--package expects name=source=dir, not ${value}`);
  const resolved = path.resolve(source);
  return { name, source: resolved, dir, json: readJson(path.join(resolved, "package.json")) };
}

if (import.meta.main) {
  const options: ProjectOptions = { mode: "runtime", app: "", packages: [], out: "" };
  for (const arg of process.argv.slice(2)) {
    const [key, value = ""] = arg.split(/=(.*)/s);
    if (key === "--mode") options.mode = value as Mode;
    else if (key === "--app") options.app = value;
    else if (key === "--out") options.out = value;
    else if (key === "--report") options.report = value;
    else if (key === "--strict") options.strict = true;
    else if (key === "--package") options.packages.push(packageArgument(value));
    else throw new Error(`Unknown argument ${arg}`);
  }
  try {
    const report = project(options);
    for (const fallback of report.fallbacks)
      console.error(`projection: ${fallback.file}: ${fallback.pattern} -> ${fallback.included.join(", ") || "all route files"} (${fallback.width})`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
