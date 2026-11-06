// Reads one module and, for a set of export names, writes the part of it a
// bundler keeps. The output is the original text with whole top-level
// statements removed, so Next compiles kept code exactly as it would compile
// the source. A statement goes only when it cannot run code: a function, a
// class without static code, a constant with a literal value. Anything else
// stays, together with every declaration it refers to.
import path from "node:path";
import ts from "typescript";

export type Names = Set<string> | "all";

export type RefKind = "import" | "load" | "reexport" | "star" | "dynamic" | "asset";

export interface ModuleRef {
  specifier: string;
  kind: RefKind;
  /** Exports the importer uses. Empty when the importer only loads the module. */
  names: Names;
}

export interface ContextRef {
  /** Static start of a computed specifier, such as "./icons/". */
  prefix: string;
  /** Matches every specifier the computed import can produce. */
  pattern: RegExp;
}

export interface Untraceable {
  pattern: string;
  /** How far the projection widens: the module's directory, its package, or every package. */
  width: "directory" | "package" | "workspace";
}

interface Binding {
  local: string;
  imported: string; // "default", "*" or a name
  typeOnly: boolean;
}

interface StatementInfo {
  node: ts.Statement;
  declares: string[];
  droppable: boolean;
  valueRefs: Set<string>;
  typeRefs: Set<string>;
  refs: ModuleRef[];
  contexts: ContextRef[];
  untraceable: Untraceable[];
  import?: { specifier: string; bindings: Binding[]; typeOnly: boolean; bare: boolean };
  reexport?: { specifier: string; specs: { exported: string; imported: string; typeOnly: boolean }[]; typeOnly: boolean };
  star?: { specifier: string; as?: string; typeOnly: boolean };
  exportList?: { exported: string; local: string; typeOnly: boolean }[];
}

export interface ModuleInfo {
  file: string;
  /** Why the module is copied whole, when it is. */
  whole?: string;
  source: ts.SourceFile;
  statements: StatementInfo[];
  /** Exported name to local binding, for declarations and `export { a as b }`. */
  locals: Map<string, string>;
  exportNames: Set<string>;
  hasStar: boolean;
  /** Bindings any statement reads as a value. TypeScript keeps their imports. */
  valueRefs: Set<string>;
}

const FS_MODULES = new Set(["fs", "fs/promises", "node:fs", "node:fs/promises"]);
const DIRECTIVES = new Set(["use client", "use server"]);

export function scriptKind(file: string) {
  switch (path.extname(file)) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

export function parse(file: string, text: string) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind) {
  return ((ts.canHaveModifiers(node) && ts.getModifiers(node)) || []).some((m) => m.kind === kind);
}

function inTypePosition(node: ts.Node, stop: ts.Node) {
  for (let current = node.parent; current && current !== stop.parent; current = current.parent) {
    if (ts.isTypeNode(current) && !ts.isExpressionWithTypeArguments(current)) return true;
    if (ts.isInterfaceDeclaration(current) || ts.isTypeAliasDeclaration(current)) return true;
    if (ts.isHeritageClause(current) && current.token === ts.SyntaxKind.ImplementsKeyword) return true;
    if (ts.isExpressionWithTypeArguments(current) && current.parent && ts.isHeritageClause(current.parent))
      return current.parent.token === ts.SyntaxKind.ImplementsKeyword || ts.isInterfaceDeclaration(current.parent.parent);
  }
  return false;
}

// A name in a position that is not a reference: `a.name`, `{ name: 1 }`,
// `class { name() {} }`. Everything else counts, including names a nested scope
// declares again, which only keeps more than needed.
function isPropertyName(node: ts.Identifier) {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === node
  )
    return true;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return true;
  if (ts.isJsxAttribute(parent) && parent.name === node) return true;
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return true;
  return false;
}

// The trivia before a node holds only whitespace and comments. TypeScript's
// getLeadingCommentRanges skips a comment on the line of the previous token,
// which is where `= /*#__PURE__*/ f()` puts it.
function isPureAnnotated(node: ts.Node, source: ts.SourceFile) {
  return /[#@]__PURE__/.test(source.text.slice(node.pos, node.getStart(source)));
}

/**
 * Whether evaluating `node` can run code or throw. Conservative: only literals,
 * functions, references to the module's own bindings, and `/* @__PURE__ *\/`
 * calls with pure arguments count as pure, as they do for terser.
 */
function pure(node: ts.Expression, locals: Set<string>, source: ts.SourceFile): boolean {
  if (
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    ts.isBigIntLiteral(node) ||
    ts.isRegularExpressionLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  )
    return true;
  if (ts.isIdentifier(node)) return locals.has(node.text) || ["undefined", "NaN", "Infinity"].includes(node.text);
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node)
  )
    return pure(node.expression, locals, source);
  if (ts.isPrefixUnaryExpression(node))
    return [ts.SyntaxKind.MinusToken, ts.SyntaxKind.ExclamationToken, ts.SyntaxKind.TildeToken].includes(node.operator) &&
      (ts.isNumericLiteral(node.operand) || ts.isBigIntLiteral(node.operand) || node.operand.kind === ts.SyntaxKind.TrueKeyword || node.operand.kind === ts.SyntaxKind.FalseKeyword);
  // `typeof x` never throws, even for an undeclared global. `void x` can.
  if (ts.isTypeOfExpression(node)) return ts.isIdentifier(node.expression) || pure(node.expression, locals, source);
  if (ts.isVoidExpression(node)) return pure(node.expression, locals, source);
  if (ts.isConditionalExpression(node))
    return pure(node.condition, locals, source) && pure(node.whenTrue, locals, source) && pure(node.whenFalse, locals, source);
  if (ts.isArrayLiteralExpression(node)) return node.elements.every((e) => ts.isOmittedExpression(e) || (!ts.isSpreadElement(e) && pure(e, locals, source)));
  if (ts.isObjectLiteralExpression(node))
    return node.properties.every((p) => {
      if (p.name && ts.isComputedPropertyName(p.name) && !ts.isStringLiteralLike(p.name.expression) && !ts.isNumericLiteral(p.name.expression)) return false;
      if (ts.isPropertyAssignment(p)) return pure(p.initializer, locals, source);
      if (ts.isShorthandPropertyAssignment(p)) return locals.has(p.name.text);
      return ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p);
    });
  if (ts.isClassExpression(node)) return pureClass(node, locals, source);
  if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && isPureAnnotated(node, source))
    return (node.arguments ?? []).every((a) => !ts.isSpreadElement(a) && pure(a, locals, source));
  return false;
}

// A namespace that emits no JavaScript: interfaces, type aliases and such
// namespaces only. Anything else counts as code.
function typeOnlyNamespace(node: ts.ModuleDeclaration): boolean {
  const body = node.body;
  if (!body) return true;
  if (ts.isModuleDeclaration(body)) return typeOnlyNamespace(body);
  if (!ts.isModuleBlock(body)) return false;
  return body.statements.every(
    (statement) =>
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      (ts.isModuleDeclaration(statement) && typeOnlyNamespace(statement)),
  );
}

function pureClass(node: ts.ClassLikeDeclaration, locals: Set<string>, source: ts.SourceFile) {
  if (ts.getDecorators(node)?.length) return false;
  if (node.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ExtendsKeyword)) return false;
  return node.members.every((member) => {
    if (ts.isClassStaticBlockDeclaration(member)) return false;
    if (ts.canHaveDecorators(member) && ts.getDecorators(member)?.length) return false;
    if (member.name && ts.isComputedPropertyName(member.name) && !ts.isStringLiteralLike(member.name.expression)) return false;
    if (ts.isPropertyDeclaration(member) && hasModifier(member, ts.SyntaxKind.StaticKeyword))
      return !member.initializer || pure(member.initializer, locals, source);
    return true;
  });
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : bindingNames(e.name)));
}

function literalText(node: ts.Expression | undefined): string | undefined {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function escape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// `import(\`./icons/${name}.tsx\`)` and `import("./icons/" + name)`, which
// webpack turns into a context module over the files that match.
function context(node: ts.Expression): ContextRef | undefined {
  if (ts.isTemplateExpression(node)) {
    const prefix = node.head.text;
    const source = escape(prefix) + node.templateSpans.map((span) => ".*" + escape(span.literal.text)).join("");
    return prefix ? { prefix, pattern: new RegExp("^" + source + "$") } : undefined;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literalText(node.left);
    const right = literalText(node.right);
    if (left) return { prefix: left, pattern: new RegExp("^" + escape(left) + ".*" + (right ? escape(right) : "") + "$") };
  }
  return undefined;
}

function snippet(node: ts.Node) {
  return node.getText().replace(/\s+/g, " ").slice(0, 120);
}

/** Module references, computed imports and runtime file access inside `root`. */
function scan(root: ts.Node, info: Pick<StatementInfo, "refs" | "contexts" | "untraceable" | "valueRefs" | "typeRefs">, inPackage: boolean) {
  const stop = root;
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      if (!isPropertyName(node)) (inTypePosition(node, stop) ? info.typeRefs : info.valueRefs).add(node.text);
      if (inPackage && (node.text === "__dirname" || node.text === "__filename") && !isPropertyName(node))
        info.untraceable.push({ pattern: node.text, width: "directory" });
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      const isResolve =
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "require" &&
        callee.name.text === "resolve";
      if (isImport || isRequire || isResolve) {
        const argument = node.arguments[0];
        const specifier = literalText(argument);
        if (specifier !== undefined) {
          if (inPackage && FS_MODULES.has(specifier)) info.untraceable.push({ pattern: snippet(node), width: "directory" });
          info.refs.push({ specifier, kind: isResolve ? "asset" : "dynamic", names: "all" });
        } else if (argument && !isResolve && context(argument)) info.contexts.push(context(argument)!);
        else if (argument)
          info.untraceable.push({ pattern: snippet(node), width: isResolve ? "directory" : inPackage ? "package" : "workspace" });
      }
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "URL" &&
      node.arguments?.length === 2 &&
      isImportMetaUrl(node.arguments[1]!)
    ) {
      const specifier = literalText(node.arguments[0]);
      if (specifier !== undefined) info.refs.push({ specifier, kind: "asset", names: "all" });
      else info.untraceable.push({ pattern: snippet(node), width: "directory" });
      // The import.meta.url argument is accounted for.
      node.arguments[0] && ts.forEachChild(node.arguments[0], visit);
      return;
    }
    if (inPackage && ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      const property = ts.isPropertyAccessExpression(node.parent) ? node.parent.name.text : "";
      if (["url", "dirname", "filename"].includes(property))
        info.untraceable.push({ pattern: snippet(node.parent), width: "directory" });
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
}

function isImportMetaUrl(node: ts.Expression) {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.name.text === "url"
  );
}

function wholeReason(source: ts.SourceFile): string | undefined {
  const diagnostics = (source as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
  if (diagnostics?.length) return "does not parse";
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    if (DIRECTIVES.has(statement.expression.text)) return `has a "${statement.expression.text}" directive`;
  }
  let reason: string | undefined;
  const visit = (node: ts.Node) => {
    if (reason) return;
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) reason = "renders JSX";
    else if (ts.isExportAssignment(node) && node.isExportEquals) reason = "uses export =";
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) reason = "uses import = require()";
    else if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ((node.expression.text === "module" && node.name.text === "exports") || node.expression.text === "exports")
    )
      reason = "is CommonJS";
    else if (ts.isBlock(node) && ts.isFunctionLike(node.parent)) {
      const first = node.statements[0];
      if (first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === "use server")
        reason = 'has an inline "use server" function';
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (reason) return reason;
  const hasEsm = source.statements.some((s) => ts.isImportDeclaration(s) || ts.isExportDeclaration(s) || hasModifier(s, ts.SyntaxKind.ExportKeyword) || ts.isExportAssignment(s));
  const hasRequire = /\brequire\s*\(/.test(source.text);
  if (!hasEsm && hasRequire) return "is CommonJS";
  return undefined;
}

export function analyze(file: string, text: string, inPackage: boolean): ModuleInfo {
  const source = parse(file, text);
  const whole = wholeReason(source);
  const locals = new Map<string, string>();
  const exportNames = new Set<string>();
  const statements: StatementInfo[] = [];
  const declared = new Set<string>();
  let hasStar = false;

  // Pass 1: the names this module declares, which purity checks may read.
  for (const node of source.statements) {
    if (ts.isVariableStatement(node)) node.declarationList.declarations.forEach((d) => bindingNames(d.name).forEach((n) => declared.add(n)));
    else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) declared.add(node.name.text);
    else if (ts.isImportDeclaration(node) && node.importClause) {
      const clause = node.importClause;
      if (clause.name) declared.add(clause.name.text);
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) declared.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) bindings.elements.forEach((e) => declared.add(e.name.text));
    }
  }

  for (const node of source.statements) {
    const info: StatementInfo = {
      node,
      declares: [],
      droppable: false,
      valueRefs: new Set(),
      typeRefs: new Set(),
      refs: [],
      contexts: [],
      untraceable: [],
    };
    statements.push(info);
    const exported = hasModifier(node, ts.SyntaxKind.ExportKeyword);
    const isDefault = hasModifier(node, ts.SyntaxKind.DefaultKeyword);
    const declare = hasModifier(node, ts.SyntaxKind.DeclareKeyword);

    if (ts.isImportDeclaration(node)) {
      const specifier = (node.moduleSpecifier as ts.StringLiteral).text;
      const clause = node.importClause;
      const typeOnly = clause?.isTypeOnly ?? false;
      const bindings: Binding[] = [];
      if (clause?.name) bindings.push({ local: clause.name.text, imported: "default", typeOnly });
      const named = clause?.namedBindings;
      if (named && ts.isNamespaceImport(named)) bindings.push({ local: named.name.text, imported: "*", typeOnly });
      if (named && ts.isNamedImports(named))
        for (const e of named.elements)
          bindings.push({ local: e.name.text, imported: (e.propertyName ?? e.name).text, typeOnly: typeOnly || e.isTypeOnly });
      info.import = { specifier, bindings, typeOnly, bare: !clause };
      info.declares = bindings.map((b) => b.local);
      if (inPackage && FS_MODULES.has(specifier) && !typeOnly) info.untraceable.push({ pattern: snippet(node), width: "directory" });
      continue;
    }
    if (ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier && (node.moduleSpecifier as ts.StringLiteral).text;
      const clause = node.exportClause;
      if (specifier !== undefined && !clause) {
        hasStar = true;
        info.star = { specifier, typeOnly: node.isTypeOnly };
      } else if (specifier !== undefined && clause && ts.isNamespaceExport(clause)) {
        info.star = { specifier, as: clause.name.text, typeOnly: node.isTypeOnly };
        exportNames.add(clause.name.text);
      } else if (specifier !== undefined && clause && ts.isNamedExports(clause)) {
        info.reexport = {
          specifier,
          typeOnly: node.isTypeOnly,
          specs: clause.elements.map((e) => ({
            exported: e.name.text,
            imported: (e.propertyName ?? e.name).text,
            typeOnly: node.isTypeOnly || e.isTypeOnly,
          })),
        };
        clause.elements.forEach((e) => exportNames.add(e.name.text));
      } else if (clause && ts.isNamedExports(clause)) {
        info.exportList = clause.elements.map((e) => ({
          exported: e.name.text,
          local: (e.propertyName ?? e.name).text,
          typeOnly: node.isTypeOnly || e.isTypeOnly,
        }));
        for (const e of info.exportList) {
          locals.set(e.exported, e.local);
          exportNames.add(e.exported);
        }
      }
      continue;
    }

    scan(node, info, inPackage);
    if (ts.isExportAssignment(node)) {
      info.declares = ["default"];
      locals.set("default", "default");
      exportNames.add("default");
      info.droppable = pure(node.expression, declared, source);
    } else if (ts.isVariableStatement(node)) {
      info.declares = node.declarationList.declarations.flatMap((d) => bindingNames(d.name));
      info.droppable =
        declare ||
        node.declarationList.declarations.every((d) => ts.isIdentifier(d.name) && (!d.initializer || pure(d.initializer, declared, source)));
    } else if (ts.isFunctionDeclaration(node)) {
      info.declares = node.name ? [node.name.text] : [];
      info.droppable = true;
    } else if (ts.isClassDeclaration(node)) {
      info.declares = node.name ? [node.name.text] : [];
      info.droppable = declare || pureClass(node, declared, source);
    } else if (ts.isEnumDeclaration(node)) {
      info.declares = [node.name.text];
      info.droppable = declare;
    } else if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      info.declares = [node.name.text];
      info.droppable = true;
    } else if (ts.isModuleDeclaration(node)) {
      // `declare global` and `declare module "x"` change types everywhere.
      info.declares = ts.isIdentifier(node.name) ? [node.name.text] : [];
      info.droppable = info.declares.length > 0 && (declare || typeOnlyNamespace(node));
    } else if (ts.isEmptyStatement(node)) {
      info.droppable = true;
    }
    if (exported || ts.isExportAssignment(node)) {
      for (const name of info.declares) {
        const as = isDefault ? "default" : name;
        locals.set(as, name);
        exportNames.add(as);
      }
      if (isDefault && info.declares.length === 0) {
        info.declares = ["default"];
        locals.set("default", "default");
        exportNames.add("default");
      }
    }
  }

  const valueRefs = new Set<string>();
  for (const s of statements) for (const r of s.valueRefs) valueRefs.add(r);
  for (const s of statements) for (const e of s.exportList ?? []) if (!e.typeOnly) valueRefs.add(e.local);

  return { file, whole, source, statements, locals, exportNames, hasStar, valueRefs };
}

export interface SliceOptions {
  /** Types for the type view: every statement can go, runtime effects do not matter. */
  types: boolean;
  /** TypeScript keeps every import that is not `import type`. */
  verbatimModuleSyntax: boolean;
  /** The bundler may skip this specifier when the module uses nothing from it. */
  skippable: (specifier: string) => boolean;
  /** Export names of the module a specifier loads, or undefined when unknown. */
  exportsOf: (specifier: string) => Set<string> | undefined;
}

export interface Slice {
  text: string;
  refs: ModuleRef[];
  contexts: ContextRef[];
  untraceable: Untraceable[];
}

/** Every module reference of a module copied whole: all its imports count. */
export function wholeRefs(info: ModuleInfo, types: boolean): Slice {
  const refs: ModuleRef[] = [];
  const contexts: ContextRef[] = [];
  const untraceable: Untraceable[] = [];
  for (const s of info.statements) {
    contexts.push(...s.contexts);
    untraceable.push(...s.untraceable);
    refs.push(...s.refs);
    if (s.import && (types || !s.import.typeOnly)) {
      const bindings = s.import.bindings.filter((b) => types || !b.typeOnly);
      if (!s.import.bare && bindings.length === 0) continue;
      refs.push({
        specifier: s.import.specifier,
        kind: s.import.bare ? "load" : "import",
        names: bindings.some((b) => b.imported === "*") ? "all" : new Set(bindings.map((b) => b.imported)),
      });
    }
    if (s.reexport && (types || !s.reexport.typeOnly))
      refs.push({ specifier: s.reexport.specifier, kind: "reexport", names: new Set(s.reexport.specs.filter((e) => types || !e.typeOnly).map((e) => e.imported)) });
    if (s.star && (types || !s.star.typeOnly)) refs.push({ specifier: s.star.specifier, kind: "star", names: "all" });
  }
  return { text: info.source.text, refs, contexts, untraceable };
}

export function slice(info: ModuleInfo, requested: Names, options: SliceOptions): Slice {
  const { types } = options;
  const refs: ModuleRef[] = [];
  const contexts: ContextRef[] = [];
  const untraceable: Untraceable[] = [];
  const all = requested === "all";
  const wanted = (name: string) => all || (requested as Set<string>).has(name);

  const declaring = new Map<string, StatementInfo[]>();
  for (const s of info.statements) for (const name of s.declares) declaring.set(name, [...(declaring.get(name) ?? []), s]);

  const live = new Set<string>();
  const kept = new Set<StatementInfo>();
  const pending: StatementInfo[] = [];
  const keep = (s: StatementInfo) => {
    if (kept.has(s) || s.import) return;
    kept.add(s);
    pending.push(s);
  };
  const use = (name: string) => {
    if (live.has(name)) return;
    live.add(name);
    for (const s of declaring.get(name) ?? []) keep(s);
  };

  for (const [exported, local] of info.locals) if (wanted(exported)) use(local);
  for (const s of info.statements) {
    if (s.import || s.reexport || s.star || s.exportList) continue;
    if (!s.droppable && !(types && isRuntimeOnly(s.node))) keep(s);
    // Augmentations change types in every file that loads the module.
    if (types && ts.isModuleDeclaration(s.node) && !ts.isIdentifier(s.node.name)) keep(s);
    if (types && ts.isModuleDeclaration(s.node) && s.node.name.text === "global") keep(s);
  }
  while (pending.length) {
    const s = pending.pop()!;
    for (const name of s.valueRefs) use(name);
    if (types) for (const name of s.typeRefs) use(name);
  }

  // Names no declaration or explicit re-export provides may come from `export *`.
  const provided = new Set<string>(info.locals.keys());
  for (const s of info.statements) {
    for (const e of s.reexport?.specs ?? []) provided.add(e.exported);
    if (s.star?.as) provided.add(s.star.as);
  }
  const forwarded: Names = all ? "all" : new Set([...(requested as Set<string>)].filter((n) => !provided.has(n) && n !== "default"));

  const out: string[] = [];
  const original = info.source.text;
  let changed = false;
  const emit = (s: StatementInfo, text?: string) => {
    if (text === undefined) out.push(original.slice(s.node.getFullStart(), s.node.end));
    else {
      out.push("\n" + text);
      changed = true;
    }
  };
  const drop = () => {
    changed = true;
  };
  // A module loaded only for its effects, as the bundler would load it.
  const load = (s: StatementInfo, specifier: string, typeOnly: boolean, keptByTypeScript: boolean) => {
    if (types || typeOnly || !keptByTypeScript || options.skippable(specifier)) return drop();
    refs.push({ specifier, kind: "load", names: new Set() });
    emit(s, `import ${JSON.stringify(specifier)};`);
  };

  for (const s of info.statements) {
    if (s.import) {
      const { specifier, bindings, typeOnly, bare } = s.import;
      if (bare) {
        if (!types && options.skippable(specifier)) {
          drop();
          continue;
        }
        refs.push({ specifier, kind: "load", names: new Set() });
        emit(s);
        continue;
      }
      const used = bindings.filter((b) => live.has(b.local) && (types || !b.typeOnly));
      if (used.length && (types || !typeOnly)) {
        untraceable.push(...s.untraceable);
        refs.push({
          specifier,
          kind: "import",
          names: used.some((b) => b.imported === "*") ? "all" : new Set(used.map((b) => b.imported)),
        });
        emit(s);
        continue;
      }
      // TypeScript drops an import whose bindings no value reads. A read from a
      // statement the slice removes still kept the module in the full build.
      const keptByTypeScript =
        options.verbatimModuleSyntax ||
        scriptKind(info.file) === ts.ScriptKind.JS ||
        bindings.some((b) => !b.typeOnly && info.valueRefs.has(b.local));
      load(s, specifier, typeOnly, keptByTypeScript);
      continue;
    }
    if (s.reexport) {
      const specs = s.reexport.specs.filter((e) => wanted(e.exported) && (types || !e.typeOnly));
      if (specs.length && (types || !s.reexport.typeOnly)) {
        refs.push({ specifier: s.reexport.specifier, kind: "reexport", names: new Set(specs.map((e) => e.imported)) });
        if (specs.length === s.reexport.specs.length) emit(s);
        else emit(s, exportList(s.node as ts.ExportDeclaration, specs.map((e) => e.exported), s.reexport.specifier));
      } else load(s, s.reexport.specifier, s.reexport.typeOnly, true);
      continue;
    }
    if (s.star) {
      const { specifier, as, typeOnly } = s.star;
      if (as !== undefined) {
        if (wanted(as) && (types || !typeOnly)) {
          refs.push({ specifier, kind: "reexport", names: "all" });
          emit(s);
        } else load(s, specifier, typeOnly, true);
        continue;
      }
      const names = options.exportsOf(specifier);
      const needed: Names =
        forwarded === "all" ? "all" : new Set([...forwarded].filter((n) => !names || names.has(n)));
      if ((needed === "all" || needed.size) && (types || !typeOnly)) {
        refs.push({ specifier, kind: "star", names: needed });
        emit(s);
      } else load(s, specifier, typeOnly, true);
      continue;
    }
    if (s.exportList) {
      const specs = s.exportList.filter((e) => live.has(e.local) && (wanted(e.exported) || all) && (types || !e.typeOnly));
      if (specs.length === s.exportList.length) emit(s);
      else if (specs.length) emit(s, exportList(s.node as ts.ExportDeclaration, specs.map((e) => e.exported)));
      else drop();
      continue;
    }
    if (kept.has(s)) {
      emit(s);
      contexts.push(...s.contexts);
      untraceable.push(...s.untraceable);
      refs.push(...s.refs);
    } else drop();
  }
  const text = changed ? out.join("") + "\n" : original;
  return { text: normalizeTrivia(info.file, text), refs, contexts, untraceable };
}

// TypeScript erases these, so the type view keeps them only when referenced.
function isRuntimeOnly(node: ts.Statement) {
  return ts.isExpressionStatement(node) || ts.isIfStatement(node) || ts.isForStatement(node) || ts.isTryStatement(node) || ts.isBlock(node);
}

// The export clause rewritten to the given names, keeping each specifier's text.
function exportList(node: ts.ExportDeclaration, names: string[], from?: string) {
  const clause = node.exportClause as ts.NamedExports;
  const specs = clause.elements.filter((e) => names.includes(e.name.text)).map((e) => e.getText());
  const type = node.isTypeOnly ? "type " : "";
  return `export ${type}{ ${specs.join(", ")} }${from === undefined ? "" : ` from ${JSON.stringify(from)}`};`;
}

// Comments that change what a bundler or the type checker does with the code.
const KEPT_COMMENT =
  /^\/\/\/\s*<|^\/\*!|[#@]__[A-Z_]+__|\b(?:webpack|turbopack)[A-Z]\w*\s*:|@vite-ignore|@ts-|@jsx|@license|@preserve/;

type Trivia = { comment: string; line: boolean } | { space: "\n" | " " };

// Trivia holds only whitespace and comments: the parser put a token on each side.
function scanTrivia(text: string): Trivia[] {
  const items: Trivia[] = [];
  for (let i = 0; i < text.length; ) {
    if (text.startsWith("//", i) || text.startsWith("#!", i)) {
      const newline = text.slice(i).search(/[\n\r\u2028\u2029]/);
      const end = newline === -1 ? text.length : i + newline;
      items.push({ comment: text.slice(i, end), line: true });
      i = end;
    } else if (text.startsWith("/*", i)) {
      const close = text.indexOf("*/", i + 2);
      const end = close === -1 ? text.length : close + 2;
      items.push({ comment: text.slice(i, end), line: false });
      i = end;
    } else {
      items.push({ space: /[\n\r\u2028\u2029]/.test(text[i]!) ? "\n" : " " });
      i++;
    }
  }
  return items;
}

/**
 * The module's tokens without comments or indentation, so an edit to a comment
 * or to formatting leaves the projection unchanged. Whitespace between two
 * tokens becomes one space, or one newline where the source broke the line,
 * which keeps automatic semicolon insertion as it was. A dropped comment that
 * spans lines counts as a line break, as it does for the parser. Comments that
 * steer a bundler or the type checker stay.
 */
export function normalizeTrivia(file: string, text: string): string {
  const source = parse(file, text);
  if ((source as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics?.length) return text;
  const out: string[] = [];
  const trivia = (between: string) => {
    let space: "" | " " | "\n" = "";
    const flush = () => {
      out.push(space);
      space = "";
    };
    for (const item of scanTrivia(between)) {
      if ("space" in item) space = space === "\n" || item.space === "\n" ? "\n" : " ";
      else if (KEPT_COMMENT.test(item.comment) || item.comment.startsWith("#!")) {
        flush();
        out.push(item.comment);
        // A line comment ends at a line break, which the next item supplies.
      } else if (!item.line) space = space === "\n" || /[\n\r\u2028\u2029]/.test(item.comment) ? "\n" : space || " ";
    }
    flush();
  };
  let end = 0;
  const visit = (node: ts.Node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(source);
    if (children.length) return children.forEach(visit);
    if (node.kind === ts.SyntaxKind.SyntaxList) return;
    const start = node.getStart(source);
    if (start >= node.end && node.kind !== ts.SyntaxKind.EndOfFileToken) return;
    trivia(text.slice(end, start));
    out.push(text.slice(start, node.end));
    end = Math.max(end, node.end);
  };
  visit(source);
  return out.join("").replace(/^\s+/, "").replace(/\s*$/, "\n");
}
