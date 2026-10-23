"""Pinned headless Chromium for the Playwright tests."""

def _chromium_impl(ctx):
    if ctx.os.name == "mac os x" and ctx.os.arch == "aarch64":
        platform = "mac-arm64"
    elif ctx.os.name == "linux" and ctx.os.arch == "amd64":
        platform = "linux64"
    else:
        fail("The browser tests currently support Linux x64 and macOS arm64.")
    pins = json.decode(ctx.read(ctx.attr.pins))
    ctx.download_and_extract(
        url = "https://cdn.playwright.dev/builds/cft/%s/%s/chrome-headless-shell-%s.zip" % (pins["version"], platform, platform),
        sha256 = pins["sha256"][platform],
        stripPrefix = "chrome-headless-shell-" + platform,
    )
    ctx.file("BUILD.bazel", """
exports_files(["chrome-headless-shell"])
filegroup(name = "files", srcs = glob(["**"]), visibility = ["//visibility:public"])
""")

chromium_repository = repository_rule(implementation = _chromium_impl, attrs = {"pins": attr.label(default = "//tools/bazel:chromium-pins.json")})
