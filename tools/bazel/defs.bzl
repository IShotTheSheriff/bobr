"""Shared TypeScript and Next build rules for the Bóbr cache experiment."""

load("@aspect_rules_js//js:defs.bzl", "js_run_binary", "js_test")

_TS_COMPILER_OPTIONS = {
    "module": "commonjs",
    "moduleResolution": "node",
    "ignoreDeprecations": "6.0",
    "target": "es2022",
    "esModuleInterop": True,
    "strict": True,
    "isolatedModules": True,
    "skipLibCheck": True,
}

def bazel_ts_tsconfig(types = None):
    """Returns a `ts_project(tsconfig = ...)` dict for the Bazel TS layer.

    Args:
      types: optional `compilerOptions.types` list (e.g. `["node"]` for the app
        logic targets, which import `node:assert`). Omitted for the pure-utility
        leaf targets, which need no ambient types.
    """
    opts = dict(_TS_COMPILER_OPTIONS)
    if types != None:
        opts["types"] = types
    return {"compilerOptions": opts}

# Inputs the `next build` action needs beyond the app's own `app/**` + `public/**`
# sources: the config files plus every runtime/build npm dependency. Identical
# for both apps; the relative `:node_modules/...` labels resolve against the
# calling package (each app runs `npm_link_all_packages()`, which creates them).
NEXT_BUILD_INPUTS = [
    "next.config.js",
    "vercel-build.json",
    "postcss.config.mjs",
    "tsconfig.json",
    "package.json",
    ":node_modules/next",
    ":node_modules/react",
    ":node_modules/react-dom",
    ":ui_projection",
    ":node_modules/clsx",
    ":node_modules/framer-motion",
    ":node_modules/lucide-react",
    ":node_modules/sonner",
    ":node_modules/tailwind-merge",
    ":node_modules/@tailwindcss/postcss",
    ":node_modules/tailwindcss",
    ":node_modules/autoprefixer",
    ":node_modules/postcss",
    # Next loads the tsconfig and TypeScript tooling even with checking skipped.
    ":node_modules/@repo/typescript-config",
    ":node_modules/typescript",
    ":node_modules/@types/node",
    ":node_modules/@types/react",
    ":node_modules/@types/react-dom",
]

# Paths excluded from a first-party Next.js app's `npm_package` glob (build
# outputs, the Bazel TS layer, and the BUILD file itself).
NEXT_APP_PKG_EXCLUDE = [
    "node_modules/**",
    ".next/**",
    ".vercel/**",
    "vercel_output/**",
    "bazel/**",
    "next-env.d.ts",
    "ui_runtime/**",
    "BUILD.bazel",
]


def next_app_build():
    """Builds the app from a deterministic UI projection and declared npm inputs."""
    app = native.package_name()
    app_sources = native.glob(["app/**"])
    js_run_binary(
        name = "ui_projection",
        srcs = app_sources + ["//packages/ui:pkg"],
        args = [app + "/app", "$(rootpath //packages/ui:pkg)", app + "/ui_runtime"],
        out_dirs = ["ui_runtime"],
        mnemonic = "UiProjection",
        tool = "//tools/bazel:project_ui",
    )
    js_run_binary(
        name = "next_build",
        srcs = app_sources + native.glob(["public/**"]) + NEXT_BUILD_INPUTS,
        chdir = app,
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
