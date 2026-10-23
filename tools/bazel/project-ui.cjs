const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const esbuild = require("esbuild");

// This boundary covers ordinary TypeScript utilities. React modules keep their
// original files and directives so Next owns client/server compilation.
async function projectUi(app, source, output) {
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
  const utils = path.join(source, "src/utils");
  const names = new Set();
  let wholeNamespace = false;
  let imported = false;
  function files(dir) {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((e) =>
        e.isDirectory()
          ? files(path.join(dir, e.name))
          : [path.join(dir, e.name)],
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
  const uiRoot = path.join(source, "src");
  const reachable = new Set();
  const queue = files(app);
  const visited = new Set();
  function follow(specifier, importer) {
    let candidate;
    if (specifier.startsWith("@repo/ui/")) {
      candidate = path.join(
        uiRoot,
        specifier.slice("@repo/ui/".length) + ".tsx",
      );
    } else if (specifier.startsWith(".")) {
      candidate = path.resolve(path.dirname(importer), specifier);
    } else {
      if (specifier === "@repo/ui" || specifier.startsWith("@/"))
        throw new Error(
          `${importer}: unsupported projection alias ${specifier}`,
        );
      return; // External npm dependency, declared separately in the Next action.
    }
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
      const isModuleSpecifier =
        parent &&
        (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)
          ? parent.moduleSpecifier === node
          : ts.isExternalModuleReference(parent)
            ? parent.expression === node
            : ts.isCallExpression(parent) &&
              parent.arguments[0] === node &&
              (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(parent.expression) &&
                  parent.expression.text === "require")));
      if (ts.isStringLiteralLike(node) && isModuleSpecifier) {
        if (
          (ts.isImportDeclaration(parent) && parent.importClause?.isTypeOnly) ||
          (ts.isExportDeclaration(parent) && parent.isTypeOnly)
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
          if (clause?.isTypeOnly) return;
          imported = true;
          if (clause?.name) names.add("default");
          const bindings = clause?.namedBindings;
          if (bindings && ts.isNamedImports(bindings)) {
            for (const item of bindings.elements)
              if (!item.isTypeOnly)
                names.add((item.propertyName || item.name).text);
          } else if (bindings) wholeNamespace = true;
        } else if (ts.isExportDeclaration(parent) && parent.isTypeOnly) {
          return;
        } else {
          imported = true;
          wholeNamespace = true;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  for (const file of [...reachable].sort()) {
    const target = path.join(output, path.relative(uiRoot, file));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
  }
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
module.exports = projectUi;
if (require.main === module) {
  projectUi(...process.argv.slice(2).map((p) => path.resolve(p))).catch(
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
