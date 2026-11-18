#!/usr/bin/env python3
"""Local dev server for Ride Tracker.

Serves this folder and lets the in-page editor write encodings.json directly,
so edits can be committed and pushed. Not used on GitHub Pages (which is
static), so editing is only available when running this script.

    python3 serve.py [port]      # default 8000, then open http://localhost:8000
"""
import json, os, sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(ROOT, "encodings.json")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _reply(self, code, body=b""):
        self.send_response(code)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/__dev":  # the page probes this to enable edit mode
            return self._reply(200, b"ok")
        super().do_GET()

    def do_PUT(self):
        if self.path.split("?")[0] != "/encodings.json":
            return self._reply(404)
        try:
            raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            data = json.loads(raw)
            if not isinstance(data.get("encodings"), list):
                raise ValueError("missing encodings array")
        except Exception as err:
            return self._reply(400, str(err).encode())
        tmp = TARGET + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.replace(tmp, TARGET)  # atomic: never leaves a half-written file
        self._reply(204)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    # Bind to loopback only: nothing else on the network can write the file.
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Ride Tracker: http://localhost:{port}  (edits save to encodings.json)")
    srv.serve_forever()
