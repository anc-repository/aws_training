#!/usr/bin/env python3
"""Mock IMDSv2 for the L0 offline install drill (scripts/release-docker/drill.sh).

Listens on 127.0.0.1:<port>; run-drill.sh puts 169.254.169.254/32 on lo and DNATs 169.254.169.254:80 to it, so the
bootstrap's curl calls reach it unchanged. Behaves like IMDSv2 with HttpTokens=required: PUT /latest/api/token returns a
token, every GET needs X-aws-ec2-metadata-token, unknown paths are 404. Every request is appended to the log (JSON lines)
so the drill can report exactly which metadata the bootstrap read. Values: --values <json file> (path -> text).
"""
import argparse
import json
import secrets
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKENS = set()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8169)
    ap.add_argument('--values', required=True)
    ap.add_argument('--log', required=True)
    args = ap.parse_args()
    with open(args.values, encoding='utf-8') as f:
        values = json.load(f)

    class Handler(BaseHTTPRequestHandler):
        def _log(self, status):
            with open(args.log, 'a', encoding='utf-8') as f:
                f.write(json.dumps({'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'method': self.command,
                                    'path': self.path, 'status': status}) + '\n')

        def _send(self, status, body=''):
            data = body.encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'text/plain')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            self._log(status)

        def do_PUT(self):
            if self.path != '/latest/api/token' or not self.headers.get('X-aws-ec2-metadata-token-ttl-seconds'):
                return self._send(400)
            token = secrets.token_urlsafe(32)
            TOKENS.add(token)
            return self._send(200, token)

        def do_GET(self):
            if self.headers.get('X-aws-ec2-metadata-token') not in TOKENS:
                return self._send(401)
            path = self.path.split('?')[0]
            for prefix in ('/latest/meta-data/', '/latest/dynamic/'):
                if path.startswith(prefix):
                    key = path[len('/latest/'):]
                    if key in values:
                        return self._send(200, values[key])
            return self._send(404)

        def log_message(self, *_):
            pass

    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()


if __name__ == '__main__':
    sys.exit(main())
