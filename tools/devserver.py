#!/usr/bin/env python3
"""Dev server for stlv/app in a browser: threaded, a deep accept queue (the
browser loads ~40 ES modules at once), and no caching, so edits show on reload."""
import http.server, socketserver, sys, os, functools

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def log_message(self, *a):
        pass

class Server(http.server.ThreadingHTTPServer):
    request_queue_size = 128
    daemon_threads = True
    allow_reuse_address = True

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8769
root = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), '..', 'app')
Handler.extensions_map.update({'.js': 'text/javascript', '.mjs': 'text/javascript'})
with Server(('', port), functools.partial(Handler, directory=root)) as s:
    print(f'stlv dev server on http://localhost:{port}', flush=True)
    s.serve_forever()
