"""Loopback HTTP AC/CAS fixture for testing Bazel's remote-cache protocol."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import tempfile
import threading


class CacheServer(ThreadingHTTPServer):
    request_queue_size = 128


class Cache:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.reads = 0
        self.writes = 0
        self.lock = threading.Lock()
        cache = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            def log_message(self, *_):
                pass

            def location(self):
                match = re.fullmatch(r"/(ac|cas)/([a-f0-9]{64})", self.path)
                return cache.directory / match[1] / match[2] if match else None

            def do_GET(self):
                file = self.location()
                if file is None or not file.exists():
                    self.send_error(404)
                    return
                data = file.read_bytes()
                with cache.lock:
                    cache.reads += 1
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_PUT(self):
                file = self.location()
                if file is None:
                    self.send_error(400)
                    return
                data = self.rfile.read(int(self.headers["Content-Length"]))
                if file.parent.name == "cas" and hashlib.sha256(data).hexdigest() != file.name:
                    self.send_error(400)
                    return
                file.parent.mkdir(parents=True, exist_ok=True)
                with tempfile.NamedTemporaryFile(dir=file.parent, delete=False) as temp:
                    temp.write(data)
                    temporary = Path(temp.name)
                temporary.replace(file)
                with cache.lock:
                    cache.writes += 1
                self.send_response(200)
                self.send_header("Content-Length", "0")
                self.end_headers()

        self.server = CacheServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()
