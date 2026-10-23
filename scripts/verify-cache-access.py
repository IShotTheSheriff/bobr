#!/usr/bin/env python3
"""Check the self-hosted cache protocol and server-enforced access permissions."""
import hashlib
import json
import os
import secrets
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    endpoint = os.environ["BAZEL_REMOTE_CACHE"].rstrip("/")
    parsed = urlsplit(endpoint)
    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1"}):
        raise ValueError("Use HTTPS, or localhost HTTP for the disposable test")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Keep credentials out of the endpoint URL")
    headers = {role: os.environ[f"BAZEL_REMOTE_{role.upper()}_HEADER"].strip().split("=", 1)
               for role in ["read", "write"]}
    opener = build_opener(NoRedirects())

    def request(method, path, role=None, body=None, extra=None):
        auth = dict([headers[role]]) if role else {}
        req = Request(endpoint + path, data=body, method=method,
                      headers={"Accept": "application/octet-stream", "Content-Type": "application/octet-stream", **auth, **(extra or {})})
        try:
            with opener.open(req, timeout=20) as response:
                return response.status, response.read()
        except HTTPError as error:
            return error.code, error.read()

    payload = secrets.token_bytes(32)
    paths = {"cas": "/cas/" + hashlib.sha256(payload).hexdigest(),
             "ac": "/ac/" + secrets.token_hex(32)}
    # A valid protobuf ActionResult with exit_code=1 and no declared outputs.
    bodies = {"cas": payload, "ac": b"\x20\x01"}
    for kind, path in paths.items():
        body = bodies[kind]
        for method in ["GET", "PUT"]:
            assert request(method, path, body=body if method == "PUT" else None)[0] == 401, "Anonymous access allowed"
        assert request("GET", path, "read")[0] == 404, "Expected a cache miss"
        assert request("PUT", path, "read", body)[0] == 403, "Reader can write"
        assert request("PUT", path, "read", body, {"X-Forwarded-User": "writer", "Remote-User": "writer"})[0] == 403, "Reader can forge writer identity"
        assert request("PUT", path, "write", body)[0] in {200, 201, 204}, "Writer cannot upload"
        for role in ["read", "write"]:
            status, restored = request("GET", path, role, extra={"Accept": "application/json"} if kind == "ac" else None)
            assert status == 200, f"Cannot read {kind} result: HTTP {status}"
            # bazel-remote adds worker metadata to action results. CAS bytes stay exact.
            assert (json.loads(restored)["exitCode"] == 1 if kind == "ac" else restored == body), "Cached result differs"
        assert request("HEAD", path, "read")[0] == 200, "Reader cannot check content"
        assert request("PUT", path, "read", body)[0] == 403, "Reader can overwrite"
        for method in ["DELETE", "POST"]:
            assert request(method, path, "write", body)[0] == 403, "Unexpected method allowed"
    assert request("GET", "/status", "write")[0] == 404, "Backend status is exposed"
    print("PASS cache reads, writes, anonymous rejection and read-only enforcement")


if __name__ == "__main__":
    main()
