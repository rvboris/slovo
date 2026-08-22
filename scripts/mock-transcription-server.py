# Mock whisper-compatible transcription server on 127.0.0.1:8072.
# GET  /v1/audio/transcriptions -> 200 (server check)
# POST /v1/audio/transcriptions -> {"text": "привет из мок-сервера"}; logs wav size.
import json
import re
from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b"{}")

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        print(f"POST received {length} bytes", flush=True)
        payload = json.dumps({"text": "привет из мок-сервера"}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass

HTTPServer(("127.0.0.1", 8072), Handler).serve_forever()
