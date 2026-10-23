"""Shared Next, projection and test rules for the Bóbr monorepo."""

load("@aspect_rules_js//js:defs.bzl", "js_run_binary", "js_test")
load("@aspect_rules_js//npm:defs.bzl", "npm_package")
load("@npm//:defs.bzl", "npm_link_targets")

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
    "tsconfig.bazel-typecheck.json",
    "node_modules/**",
    ".next/**",
    ".vercel/**",
    "vercel_output/**",
    "ui_runtime/**",
    "ui_types/**",
    "out/**",
    "coverage/**",
]

# Tests are type-checked but never part of `next build`.
_NOT_BUILD_INPUTS = _NOT_SOURCES + ["**/*.test.*"]

# The projection replaces @repo/ui, and `next build` does not run ESLint.
_NOT_BUILD_DEPS = ["@repo/ui", "@repo/eslint-config", "eslint"]

def _dep_name(label):
    return label.rsplit(":node_modules/", 1)[1]

def next_app():
    """Builds, tests and archives the Next app in the calling package.

    Inputs come from the package's files and its package.json dependencies, so
    adding pages, folders or npm packages needs no BUILD changes.
    """
    package = native.package_name()
    checked = native.glob(["**/*"], exclude = _NOT_SOURCES)
    sources = native.glob(["**/*"], exclude = _NOT_BUILD_INPUTS)
    links = npm_link_targets()
    deps = [dep for dep in links if _dep_name(dep) not in _NOT_BUILD_DEPS]

    # The projection reads tsconfig `paths`, which can come from an extended config.
    tsconfig_deps = [dep for dep in deps if _dep_name(dep) == "@repo/typescript-config"]
    js_run_binary(
        name = "ui_projection",
        srcs = sources + ["//packages/ui:pkg"] + tsconfig_deps,
        args = [package, "$(rootpath //packages/ui:pkg)", package + "/ui_runtime"],
        out_dirs = ["ui_runtime"],
        mnemonic = "UiProjection",
        tool = "//tools/bazel:project_ui",
    )

    # Components and utility declarations the app's own code and tests reach.
    js_run_binary(
        name = "ui_types",
        srcs = checked + ["//packages/ui:pkg"] + tsconfig_deps,
        args = ["--types", package, "$(rootpath //packages/ui:pkg)", package + "/ui_types"],
        out_dirs = ["ui_types"],
        mnemonic = "UiTypes",
        tool = "//tools/bazel:project_ui",
    )
    typecheck(srcs = checked + deps + [":ui_types"], ui_types = package + "/ui_types")

    # ESLint reads no @repo/ui source, so UI edits never rerun an app's lint.
    lint(srcs = checked + native.glob(["eslint.config.*"]) + [
        dep
        for dep in links
        if _dep_name(dep) != "@repo/ui"
    ])

    # Next consumes the generated UI tree. Identical projection bytes reuse the
    # cached Next artifact even though a fresh Next build is not reproducible.
    js_run_binary(
        name = "next_build",
        srcs = sources + deps + [":ui_projection"],
        chdir = package,
        env = select({
            "//tools/bazel:production": _next_env("production"),
            "//conditions:default": _next_env("preview"),
        }),
        mnemonic = "NextBuild",
        out_dirs = [".next"],
        outs = ["vercel_output.tar"],
        tool = "//tools/bazel:build_next",
        visibility = ["//visibility:public"],
        use_execroot_entry_point = True,
    )

    _build_output(
        name = "vercel_archive",
        src = ":next_build",
        basename = "vercel_output.tar",
        visibility = ["//visibility:public"],
    )

    unit_tests(srcs = sources + links)

    # Required so the workspace:* link that the e2e package declares resolves.
    npm_package(
        name = "pkg",
        srcs = sources,
        visibility = ["//visibility:public"],
    )

def typecheck(srcs, ui_types = None):
    """Type-checks the calling package with its tsconfig.json as a cached test.

    Args:
      srcs: the package's files and the npm links its types come from.
      ui_types: the app's projected UI types, which replace @repo/ui sources.
    """
    package = native.package_name()
    js_test(
        name = "typecheck",
        entry_point = "//tools/bazel:typecheck",
        data = srcs,
        args = [package] + ([ui_types] if ui_types else []),
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
    )

def _next_env(target):
    return {
        "NEXT_TELEMETRY_DISABLED": "1",
        "NODE_ENV": "production",
        "BOBR_BUILD_ID": "bobr-static",
        "BOBR_UI_PROJECTION": "ui_runtime",
        "BOBR_DEPLOY_ENV": target,
    }
