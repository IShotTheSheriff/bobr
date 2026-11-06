"""Shared Next, projection and test rules for the Bóbr monorepo."""

load("@aspect_rules_js//js:defs.bzl", "js_run_binary", "js_test")
load("@aspect_rules_js//npm:defs.bzl", "npm_package")
load("@npm//:defs.bzl", "npm_link_targets")
load("@workspace_packages//:packages.bzl", "WORKSPACE_PACKAGES")

# Files in an app package that no build or check reads. Every other file is an
# input, so new source folders, configs and .env files need no rule changes.
# Markdown pages (`pageExtensions`) would need "**/*.md" removed from this list.
_NOT_SOURCES = [
    "**/*.md",
    "**/.gitignore",
    "BUILD.bazel",
    "eslint.config.*",
    "next-env.d.ts",
    "*.tsbuildinfo",
    "node_modules/**",
    ".next/**",
    ".vercel/**",
    "vercel_output/**",
    "out/**",
    "coverage/**",
]

# Tests are type-checked but never part of `next build`.
_NOT_BUILD_INPUTS = _NOT_SOURCES + ["**/*.test.*"]

# Only the lint check loads ESLint and the shared config.
_LINT_ONLY_DEPS = ["@repo/eslint-config", "eslint"]

# The projection writes into the app's node_modules, which Tailwind's source
# detection, tsc's `exclude` and ESLint all skip.
_PROJECTION = "node_modules/.projection/"

def _dep_name(label):
    return label.rsplit(":node_modules/", 1)[1]

def package_deps(lint = False):
    """Returns the calling package's npm links from pnpm-lock.yaml.

    Args:
      lint: keep ESLint and the shared ESLint config, which only lint reads.
    """
    return [
        dep
        for dep in npm_link_targets()
        if lint or _dep_name(dep) not in _LINT_ONLY_DEPS
    ]

def projected_packages(links):
    """Workspace packages in `dependencies`, and the ones they depend on in turn.

    Packages in `devDependencies`, such as shared configs, stay whole.

    Args:
      links: the app's production npm links.
    """
    names = [_dep_name(link) for link in links if _dep_name(link) in WORKSPACE_PACKAGES]
    found = []

    # Starlark has no while loop. Each pass adds at least one package or ends.
    for _ in WORKSPACE_PACKAGES:
        if not names:
            break
        reached = []
        for name in names:
            if name in found:
                continue
            found.append(name)
            for link in npm_link_targets(package = WORKSPACE_PACKAGES[name], dev = False):
                dep = _dep_name(link)
                if dep in WORKSPACE_PACKAGES and dep not in found:
                    reached.append(dep)
        names = reached
    return sorted(found)

def _package_links(projected, dev):
    # The projected packages' own npm links. Links between projected packages
    # come from the projection instead, so their sources stay out.
    links = []
    for name in projected:
        for link in npm_link_targets(package = WORKSPACE_PACKAGES[name], dev = dev):
            if _dep_name(link) not in projected and link not in links:
                links.append(link)
    return links

def _strict():
    return select({
        "//tools/bazel:strict_projection": ["--strict"],
        "//conditions:default": [],
    })

def next_app():
    """Builds, tests and archives the Next app in the calling package.

    Inputs come from the package's files and its package.json dependencies, so
    adding pages, folders or npm packages needs no BUILD changes.
    """
    package = native.package_name()
    checked = native.glob(["**/*"], exclude = _NOT_SOURCES)
    sources = native.glob(["**/*"], exclude = _NOT_BUILD_INPUTS)
    links = package_deps()

    # The projection replaces each workspace package in `dependencies` for the
    # build and the type check.
    projected = projected_packages(npm_link_targets(dev = False))
    deps = [dep for dep in links if _dep_name(dep) not in projected]
    packages = ["//%s:pkg" % WORKSPACE_PACKAGES[name] for name in projected]
    package_args = [
        "--package=%s=$(rootpath //%s:pkg)=%s" % (name, WORKSPACE_PACKAGES[name], WORKSPACE_PACKAGES[name])
        for name in projected
    ]
    runtime_links = _package_links(projected, dev = False)
    type_links = _package_links(projected, dev = True)

    # The projection reads tsconfig `paths`, which can come from an extended config.
    configs = [dep for dep in deps if _dep_name(dep) in WORKSPACE_PACKAGES]

    _projection("projection", "runtime", sources + packages + configs, "Projection", package_args)

    # Components and utility declarations the app's own code and tests reach.
    _projection("types_projection", "types", checked + packages + configs + type_links, "TypesProjection", package_args)
    typecheck(
        srcs = checked + deps + type_links + [":types_projection"],
        projection = package + "/" + _PROJECTION + "types",
    )

    # ESLint reads no workspace package source, so their edits never rerun an
    # app's lint.
    lint(srcs = checked + native.glob(["eslint.config.*"]) + [
        dep
        for dep in package_deps(lint = True)
        if _dep_name(dep) not in projected
    ])

    # Next consumes the projection. Identical projection bytes reuse the
    # cached Next artifact even though a fresh Next build is not reproducible.
    _next_build("next_build", "vercel_output.tar", sources + deps + runtime_links + [":projection"], "runtime")
    _build_output(
        name = "vercel_archive",
        src = ":next_build",
        basename = "vercel_output.tar",
        visibility = ["//visibility:public"],
    )

    # The equivalence check builds the app once more, against every workspace
    # package whole, and compares the archive with the projected build's.
    # A difference means the projection dropped something Next reads.
    # Turbopack names modules by their path under the build root, which is
    # the same in both sandboxes. CI runs the check on a schedule and when the
    # projection or a bundler changes.
    _projection("projection_whole", "copy", ["package.json"] + packages, "ProjectionCopy", package_args, tags = ["manual"])
    _next_build("next_build_whole", "vercel_output_whole.tar", sources + deps + runtime_links + [":projection_whole"], "copy", tags = ["manual"])
    js_test(
        name = "equivalence_test",
        entry_point = "//tools/bazel:compare_archives",
        data = [":next_build", ":next_build_whole", "//:node_modules/tar"],
        args = ["$(rootpath :next_build)", "$(rootpath :next_build_whole)"],
        size = "large",
        tags = ["manual", "equivalence"],
    )

    unit_tests(srcs = sources + links)

    # Required so the workspace:* link that the e2e package declares resolves.
    npm_package(
        name = "pkg",
        srcs = sources,
        visibility = ["//visibility:public"],
    )

def _projection(name, mode, srcs, mnemonic, package_args, tags = []):
    package = native.package_name()
    js_run_binary(
        name = name,
        srcs = srcs,
        args = [
            "--mode=" + mode,
            "--app=" + package,
            "--out=%s/%s%s" % (package, _PROJECTION, mode),
            "--report=%s/%s%s.json" % (package, _PROJECTION, mode),
        ] + package_args + _strict(),
        out_dirs = [_PROJECTION + mode],
        # The report is a separate output, so a changed report never reruns a
        # build.
        outs = [_PROJECTION + mode + ".json"],
        mnemonic = mnemonic,
        tool = "//tools/bazel:project",
        tags = tags,
    )

def _next_build(name, archive, srcs, mode, tags = []):
    js_run_binary(
        name = name,
        srcs = srcs,
        chdir = native.package_name(),
        env = select({
            "//tools/bazel:production": _next_env("production", mode, archive),
            "//conditions:default": _next_env("preview", mode, archive),
        }),
        mnemonic = "NextBuild",
        # The archive is the only output. Leaving `.next` undeclared keeps the
        # shared cache to one file per Next build.
        outs = [archive],
        tool = "//tools/bazel:build_next",
        visibility = ["//visibility:public"],
        use_execroot_entry_point = True,
        tags = tags,
    )

def shared_package():
    """Packages, tests, type-checks and lints a shared package with a src/ folder.

    Apps link the package through package.json. Each check reads the package's
    own files, so edits elsewhere never rerun them.
    """
    files = ["package.json"] + native.glob(["src/**/*"])
    sources = ["package.json"] + native.glob(["src/**/*"], exclude = ["src/**/*.test.*"])
    npm_package(
        name = "pkg",
        srcs = sources,
        visibility = ["//visibility:public"],
    )
    unit_tests(srcs = sources + package_deps())
    if native.glob(["tsconfig.json"], allow_empty = True):
        typecheck(srcs = files + ["tsconfig.json"] + package_deps())
    lint_config = native.glob(["eslint.config.*"], allow_empty = True)
    if lint_config:
        lint(srcs = files + lint_config + package_deps(lint = True))

def typecheck(srcs, projection = None):
    """Type-checks the calling package with its tsconfig.json as a cached test.

    Args:
      srcs: the package's files and the npm links its types come from.
      projection: the app's type view of its workspace packages, which
        replaces their sources.
    """
    package = native.package_name()
    js_test(
        name = "typecheck",
        entry_point = "//tools/bazel:typecheck",
        data = srcs + ["//tools/bazel:link_projection"],
        args = [package] + ([projection] if projection else []),
    )

def lint(srcs):
    """Lints the calling package with its eslint.config file as a cached test.

    Args:
      srcs: the files to lint, the config and the npm links it loads.
    """
    js_test(
        name = "lint",
        entry_point = "//tools/bazel:lint",
        data = srcs,
        args = [native.package_name()],
    )

def unit_tests(srcs):
    """Creates a cached test for each `*.test.ts(x)` file in the calling package.

    esbuild bundles each test with only the code it reaches. The bundle is the
    test's only input, so edits to code the test never reaches reuse its result.

    Args:
      srcs: files and npm links the tests may import.
    """
    package = native.package_name()
    for test in native.glob(
        ["**/*.test.ts", "**/*.test.tsx"],
        exclude = ["node_modules/**"],
        allow_empty = True,
    ):
        name = test.rsplit(".", 1)[0]
        bundle = name + ".bundle.cjs"
        js_run_binary(
            name = name + "_bundle",
            srcs = srcs + [test],
            args = [package + "/" + test, package + "/" + bundle],
            outs = [bundle],
            mnemonic = "BundleTest",
            tool = "//tools/bazel:bundle_test",
        )
        js_test(
            name = name,
            entry_point = bundle,
        )

def _build_output_impl(ctx):
    return [DefaultInfo(files = depset([f for f in ctx.attr.src[DefaultInfo].files.to_list() if f.basename == ctx.attr.basename]))]

_build_output = rule(
    implementation = _build_output_impl,
    attrs = {"src": attr.label(mandatory = True), "basename": attr.string(mandatory = True)},
)

def next_app_e2e(app):
    """Tests the cached deployable artifact in a pinned browser."""
    js_test(
        name = "test",
        entry_point = "//tools/bazel:test_runner",
        data = native.glob(["src/**"]) + [
            "playwright.config.ts",
            ":node_modules/@playwright/test",
            "//tools/bazel:artifact_helpers",
            "//apps/%s:vercel_archive" % app,
            "@chromium//:files",
            "@chromium//:chrome-headless-shell",
        ],
        args = [
            "$(rootpath //apps/%s:vercel_archive)" % app,
            "$(rootpath @chromium//:chrome-headless-shell)",
            "$(rootpath :playwright.config.ts)",
        ],
        no_copy_to_bin = ["@chromium//:files"],
        size = "large",
        # CI runs these after the other checks, so it can retry them once the
        # browser system libraries finish installing.
        tags = ["browser"],
    )

def _next_env(target, mode, archive):
    return {
        "NEXT_TELEMETRY_DISABLED": "1",
        "NODE_ENV": "production",
        "BOBR_BUILD_ID": "bobr-static",
        "BOBR_PROJECTION": _PROJECTION + mode,
        "BOBR_ARCHIVE": archive,
        "BOBR_DEPLOY_ENV": target,
    }
