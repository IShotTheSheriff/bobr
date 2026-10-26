const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const esbuild = require("esbuild");

// Next loads these folders and files itself. Other app files count only when
// one of them imports them.
const ENTRY_DIRS = ["app", "pages", "src/app", "src/pages"];
const ENTRY_FILE =
  /^(middleware|proxy|instrumentation|instrumentation-client|mdx-components)\.[cm]?[jt]sx?$/;
const NOT_TYPE_ROOTS = new Set(["node_modules", ".next", "ui_runtime", "ui_types"]);

function compilerOptions(app) {
  const config = path.join(app, "tsconfig.json");
  if (!fs.existsSync(config)) return {};
  const parsed = ts.getParsedCommandLineOfConfigFile(
    config,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText));
      },
    },
  );
  // TS18003 only reports that no file matched `include`.
  const errors = parsed.errors.filter((diagnostic) => diagnostic.code !== 18003);
  if (errors.length)
    throw new Error(
      errors
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
        .join("\n"),
    );
  return parsed.options;
}

function files(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) =>
      e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );
}

function parse(file) {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}

function checkExports(source) {
  const metadata = JSON.parse(
    fs.readFileSync(path.join(source, "package.json"), "utf8"),
  );
  if (
    metadata.exports?.["./utils"] !== "./src/utils/index.ts" ||
    metadata.exports?.["./*"] !== "./src/*.tsx" ||
    Object.keys(metadata.exports || {}).some(
      (key) => !["./utils", "./*", "./utils/*"].includes(key),
    )
  ) {
    throw new Error(
      "Update the projection when @repo/ui package exports change",
    );
  }
}

// Follows imports from Next's entry files into the UI package. With `types`,
// type-only imports count too: the type check needs them, the runtime does not.
function trace(app, source, { types = false, output } = {}) {
  checkExports(source);
  const utils = path.join(source, "src/utils");
  const uiRoot = path.join(source, "src");
  const names = new Set();
  let wholeNamespace = false;
  let imported = false;
  const reachable = new Set();
  // tsc checks every script the tsconfig includes, tests among them, so the
  // type view starts from all of them.
  const generated = [source, output].filter(Boolean);
  const queue = types
    ? files(app).filter(
        (file) =>
          /\.[cm]?[jt]sx?$/.test(file) &&
          !generated.some((dir) => file.startsWith(dir + path.sep)) &&
          !path
            .relative(app, file)
            .split(path.sep)
            .some((part) => NOT_TYPE_ROOTS.has(part)),
      )
    : [
        ...ENTRY_DIRS.map((dir) => path.join(app, dir))
          .filter((dir) => fs.existsSync(dir))
          .flatMap(files),
        ...[app, path.join(app, "src")]
          .filter((dir) => fs.existsSync(dir))
          .flatMap((dir) =>
            fs
              .readdirSync(dir)
              .filter((name) => ENTRY_FILE.test(name))
              .sort()
              .map((name) => path.join(dir, name)),
          ),
      ];
  const visited = new Set();
  const { paths = {}, pathsBasePath = app } = compilerOptions(app);
  // tsconfig `paths`, such as create-next-app's "@/*": ["./*"]. As in
  // TypeScript, the pattern with the longest prefix wins.
  function aliasTargets(specifier) {
    let best;
    for (const [pattern, targets] of Object.entries(paths)) {
      const [prefix, suffix = ""] = pattern.split("*");
      const wildcard = pattern.includes("*");
      if (
        wildcard
          ? specifier.length >= prefix.length + suffix.length &&
            specifier.startsWith(prefix) &&
            specifier.endsWith(suffix)
          : specifier === pattern
      )
        if (!best || prefix.length > best.prefix.length)
          best = { prefix, suffix, wildcard, targets };
    }
    if (!best) return null;
    const middle = best.wildcard
      ? specifier.slice(best.prefix.length, specifier.length - best.suffix.length)
      : "";
    return best.targets.map((target) =>
      path.resolve(pathsBasePath, target.replace("*", middle)),
    );
  }
  function follow(specifier, importer) {
    let candidates;
    if (specifier.startsWith("@repo/ui/")) {
      candidates = [
        path.join(uiRoot, specifier.slice("@repo/ui/".length) + ".tsx"),
      ];
    } else if (specifier.startsWith(".")) {
      candidates = [path.resolve(path.dirname(importer), specifier)];
    } else {
      candidates = aliasTargets(specifier);
      if (!candidates) {
        if (specifier === "@repo/ui" || specifier.startsWith("@/"))
          throw new Error(
            `${importer}: unsupported projection alias ${specifier}`,
          );
        return; // External npm dependency, declared separately in the Next action.
      }
    }
    const options = candidates.flatMap((candidate) => {
      const options = [candidate];
      // Match TypeScript's .js-to-source resolution and extensionless imports.
      if (candidate.endsWith(".js"))
        options.unshift(
          candidate.slice(0, -3) + ".ts",
          candidate.slice(0, -3) + ".tsx",
        );
      if (!path.extname(candidate))
        for (const ext of [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".json"])
          options.push(candidate + ext, path.join(candidate, "index" + ext));
      return options;
    });
    const resolved = options.find(
      (f) => fs.existsSync(f) && fs.statSync(f).isFile(),
    );
    if (!resolved) throw new Error(`${importer}: cannot resolve ${specifier}`);
    if (resolved.startsWith(uiRoot + path.sep)) reachable.add(resolved);
    else if (!resolved.startsWith(app + path.sep))
      throw new Error(
        `${importer}: local import outside declared app/UI sources: ${specifier}`,
      );
    queue.push(resolved);
  }
  for (const file of queue) {
    if (visited.has(file)) continue;
    visited.add(file);
    // CSS can load assets and other stylesheets. Until that graph is supported,
    // fail explicitly instead of publishing an incomplete UI projection.
    if (reachable.has(file) && /\.(css|scss|sass|less)$/.test(file))
      throw new Error(
        `${file}: shared UI styles need explicit projection support`,
      );
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    const tree = parse(file);
    function visit(node) {
      if (
        ts.isMetaProperty(node) ||
        (ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "require")
      ) {
        throw new Error(
          `${file}: import.meta and require helpers need explicit projection support`,
        );
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require")) &&
        (!node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0]))
      ) {
        throw new Error(
          `${file}: computed imports need explicit projection support`,
        );
      }
      const parent = node.parent;
      const importType =
        types &&
        parent &&
        ts.isLiteralTypeNode(parent) &&
        ts.isImportTypeNode(parent.parent) &&
        parent.parent.argument === parent;
      const isModuleSpecifier =
        importType ||
        (parent &&
          (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)
            ? parent.moduleSpecifier === node
            : ts.isExternalModuleReference(parent)
              ? parent.expression === node
              : ts.isCallExpression(parent) &&
                parent.arguments[0] === node &&
                (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
                  (ts.isIdentifier(parent.expression) &&
                    parent.expression.text === "require"))));
      if (ts.isStringLiteralLike(node) && isModuleSpecifier) {
        if (
          !types &&
          ((ts.isImportDeclaration(parent) && parent.importClause?.isTypeOnly) ||
            (ts.isExportDeclaration(parent) && parent.isTypeOnly))
        )
          return;
        let utilityImport = node.text === "@repo/ui/utils";
        if (node.text.startsWith("@repo/ui/utils/"))
          throw new Error(
            `${file}: direct utility imports are outside this projection; import the barrel`,
          );
        if (node.text.startsWith(".")) {
          const resolved = path.resolve(path.dirname(file), node.text);
          if (resolved === utils || resolved.startsWith(utils + path.sep)) {
            // These paths still resolve after index.ts becomes index.js.
            if (
              ![
                utils,
                path.join(utils, "index"),
                path.join(utils, "index.js"),
              ].includes(resolved)
            )
              throw new Error(
                `${file}: relative utility imports must use the barrel directory or index.js`,
              );
            utilityImport = true;
          }
        }
        if (!utilityImport) {
          follow(node.text, file);
          return;
        }
        if (ts.isImportDeclaration(parent)) {
          const clause = parent.importClause;
          imported = true;
          if (clause?.name) names.add("default");
          const bindings = clause?.namedBindings;
          if (bindings && ts.isNamedImports(bindings)) {
            for (const item of bindings.elements)
              if (types || !item.isTypeOnly)
                names.add((item.propertyName || item.name).text);
          } else if (bindings) wholeNamespace = true;
        } else {
          imported = true;
          wholeNamespace = true;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
  return { utils, uiRoot, reachable, names, wholeNamespace, imported };
}

function copyReachable({ uiRoot, reachable }, output) {
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  for (const file of [...reachable].sort()) {
    const target = path.join(output, path.relative(uiRoot, file));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
  }
}

// This boundary covers ordinary TypeScript utilities. React modules keep their
// original files and directives so Next owns client/server compilation.
async function projectUi(app, source, output) {
  const traced = trace(app, source);
  const { utils, names, wholeNamespace, imported } = traced;
  copyReachable(traced, output);
  // Ignore sideEffects:false and PURE annotations. Actual module evaluation
  // remains part of the output, including effects in unused barrel branches.
  const entry = wholeNamespace
    ? 'export * from "./index.ts";'
    : names.size
      ? `export { ${[...names].sort().join(", ")} } from "./index.ts";`
      : imported
        ? 'import "./index.ts";'
        : "";
  const result = await esbuild.build({
    ...(wholeNamespace
      ? { entryPoints: [path.join(utils, "index.ts")] }
      : {
          stdin: {
            contents: entry,
            resolveDir: utils,
            sourcefile: "entry.ts",
            loader: "ts",
          },
        }),
    absWorkingDir: utils,
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    preserveSymlinks: true,
    treeShaking: true,
    ignoreAnnotations: true,
    minifyWhitespace: true,
    sourcemap: false,
    legalComments: "none",
    plugins: [
      {
        name: "utility-boundary",
        setup(build) {
          build.onLoad({ filter: /.*/ }, async (args) => {
            if (
              !args.path.startsWith(utils + path.sep) ||
              !/\.ts$/.test(args.path)
            ) {
              throw new Error(
                `Utility projection supports local .ts modules only: ${args.path}`,
              );
            }
            const tree = parse(args.path);
            function validate(node) {
              if (
                ts.isStringLiteral(node) &&
                ["use client", "use server"].includes(node.text)
              ) {
                throw new Error(
                  `Keep React/server directives outside projected utilities: ${args.path}`,
                );
              }
              if (
                (ts.isCallExpression(node) &&
                  (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                    (ts.isIdentifier(node.expression) &&
                      ["require", "eval"].includes(node.expression.text)))) ||
                ts.isMetaProperty(node)
              ) {
                throw new Error(
                  `Utility projection requires static ESM imports: ${args.path}`,
                );
              }
              ts.forEachChild(node, validate);
            }
            validate(tree);
            return { contents: tree.text, loader: "ts" };
          });
        },
      },
    ],
  });
  if (result.warnings.length)
    throw new Error("Resolve esbuild warnings before projecting utilities");
  fs.mkdirSync(path.join(output, "utils"), { recursive: true });
  fs.writeFileSync(
    path.join(output, "utils/index.js"),
    result.outputFiles[0].contents,
  );
  // An explicit side-effect declaration prevents Next from dropping retained effects.
  fs.writeFileSync(
    path.join(output, "package.json"),
    JSON.stringify({ name: "@repo/ui", private: true, sideEffects: true }) +
      "\n",
  );
}

// Relative module specifiers in a declaration file, resolved to other
// declaration files in `emitted`.
function declarationImports(file, text, emitted) {
  const found = [];
  function visit(node) {
    const specifier =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
        ? node.moduleSpecifier
        : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
          ? node.argument.literal
          : null;
    if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith(".")) {
      const base = path.posix.join(path.posix.dirname(file), specifier.text);
      const stem = base.replace(/\.(js|ts)$/, "");
      const match = [`${stem}.d.ts`, `${stem}/index.d.ts`].find((f) =>
        emitted.has(f),
      );
      if (match) found.push(match);
    }
    ts.forEachChild(node, visit);
  }
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
  return found;
}

// Declarations for the utility exports the app names. Unnamed exports and
// function bodies are left out, so they cannot invalidate the app's type check.
function utilityDeclarations(utils, names, wholeNamespace) {
  const out = path.join(utils, "__declarations__");
  const roots = files(utils).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && !f.endsWith(".test.ts"),
  );
  const program = ts.createProgram(roots, {
    declaration: true,
    emitDeclarationOnly: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    strict: true,
    skipLibCheck: true,
    types: [],
    rootDir: utils,
    outDir: out,
  });
  const emitted = new Map();
  program.emit(
    undefined,
    (file, text) =>
      emitted.set(path.relative(out, file).split(path.sep).join("/"), text),
    undefined,
    true,
  );
  const checker = program.getTypeChecker();
  const relative = (file) =>
    path.relative(utils, file).split(path.sep).join("/").replace(/\.ts$/, "");
  const modules = program
    .getSourceFiles()
    .filter((f) => !f.isDeclarationFile && f.fileName.startsWith(utils + "/"))
    .map((f) => ({ file: f, symbol: checker.getSymbolAtLocation(f) }))
    .filter((m) => m.symbol);
  const barrel = modules.find((m) => relative(m.file.fileName) === "index");
  const resolve = (symbol) =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const barrelExports = barrel ? checker.getExportsOfModule(barrel.symbol) : [];
  const entry = [];
  const needed = new Set();
  const requested = wholeNamespace
    ? barrelExports.map((s) => s.name)
    : [...names].sort();
  for (const name of requested) {
    const exported = barrelExports.find((s) => s.name === name);
    // The app's type check reports names the barrel does not export.
    if (!exported) continue;
    const target = resolve(exported);
    const declaring = target.declarations?.[0]?.getSourceFile();
    // Prefer the module that declares the value, then any non-barrel module.
    const candidates = [...modules].sort(
      (a, b) =>
        (b.file === declaring) - (a.file === declaring) ||
        (a === barrel) - (b === barrel),
    );
    for (const module of candidates) {
      const local = checker
        .getExportsOfModule(module.symbol)
        .find((s) => resolve(s) === target);
      if (!local) continue;
      const from = relative(module.file.fileName);
      needed.add(`${from}.d.ts`);
      entry.push(
        `export { ${local.name === name ? name : `${local.name} as ${name}`} } from "./__declarations__/${from}";`,
      );
      break;
    }
  }
  const keep = new Set();
  const stack = [...needed];
  while (stack.length) {
    const file = stack.pop();
    if (keep.has(file) || !emitted.has(file)) continue;
    keep.add(file);
    stack.push(...declarationImports(file, emitted.get(file), emitted));
  }
  return {
    index: entry.length ? entry.join("\n") + "\n" : "export {};\n",
    declarations: [...keep].sort().map((file) => [file, emitted.get(file)]),
  };
}

// The view the app's type check compiles against: reachable components,
// including type-only imports, and declarations for the named utilities.
function projectUiTypes(app, source, output) {
  const traced = trace(app, source, { types: true, output });
  copyReachable(traced, output);
  const { utils, names, wholeNamespace, imported } = traced;
  if (!imported) return;
  const { index, declarations } = utilityDeclarations(utils, names, wholeNamespace);
  for (const [file, text] of declarations) {
    const target = path.join(output, "utils/__declarations__", file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  fs.mkdirSync(path.join(output, "utils"), { recursive: true });
  fs.writeFileSync(path.join(output, "utils/index.d.ts"), index);
}

module.exports = projectUi;
module.exports.projectUiTypes = projectUiTypes;
if (require.main === module) {
  const args = process.argv.slice(2);
  const types = args[0] === "--types";
  const [app, source, output] = args.slice(types ? 1 : 0).map((p) => path.resolve(p));
  Promise.resolve()
    .then(() => (types ? projectUiTypes : projectUi)(app, source, output))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
