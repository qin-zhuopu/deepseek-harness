#!/usr/bin/env python3
# vnc-resize-sidecar — keep the Xvnc desktop matched to the noVNC viewport.
#
# GET /resize?w=W&h=H  ->  RFB SetDesktopSize on the Xvnc server.
#
# Why a sidecar instead of noVNC's resize=remote: remote resize re-sends
# SetDesktopSize on every window resize event (a storm while dragging a
# column) and multiple viewers fight over the size. Here noVNC stays in
# smooth resize=scale mode; fit-resize.js (injected into vnc.html) debounces
# viewport changes to one request per 250ms of quiet, and this sidecar is the
# single writer of the desktop size.
#
# The RFB connection is kept ALIVE forever: TigerVNC's Xvnc segfaults if a
# client sends SetDesktopSize and disconnects immediately, so a persistent
# session (handshake + SetEncodings + drain thread) is required.
#
# Listen address/port and the Xvnc target come from the environment so the
# same image serves both deployments: loopback-only (the default, websockify
# is the sole network-facing hop) and behind a reverse proxy such as
# nginx-proxy, which reaches the container by its bridge IP and therefore
# needs SIDECAR_BIND=0.0.0.0.
import http.server
import os
import socketserver
import socket
import struct
import threading
import time
from urllib.parse import urlparse, parse_qs

VNC_HOST = os.environ.get('VNC_HOST', '127.0.0.1')
VNC_PORT = int(os.environ.get('VNC_PORT', '5900'))
LISTEN_ADDR = os.environ.get('SIDECAR_BIND', '127.0.0.1')
LISTEN_PORT = int(os.environ.get('SIDECAR_PORT', '6081'))


def recvn(s: socket.socket, n: int) -> bytes:
    b = b''
    while len(b) < n:
        c = s.recv(n - len(b))
        if not c:
            raise IOError('closed')
        b += c
    return b


class RfbClient:
    """One persistent RFB session; reconnects with backoff if it drops."""

    def __init__(self) -> None:
        self.s: socket.socket | None = None
        self.lock = threading.Lock()
        self.last: tuple[int, int] | None = None

    def connect(self) -> None:
        while True:
            try:
                s = socket.create_connection((VNC_HOST, VNC_PORT), timeout=5)
                recvn(s, 12)
                s.sendall(b'RFB 003.008\n')
                n = recvn(s, 1)[0]
                types = recvn(s, n)
                if 1 not in types:
                    raise IOError('no none-auth')
                s.sendall(bytes([1]))
                if struct.unpack('>I', recvn(s, 4))[0] != 0:
                    raise IOError('auth failed')
                s.sendall(bytes([1]))  # ClientInit (shared)
                hdr = recvn(s, 24)
                namelen = struct.unpack('>I', hdr[20:24])[0]
                if namelen:
                    recvn(s, namelen)
                # SetEncodings: raw, copyrect, hextile, pseudo DesktopSize
                msg = (bytes([2, 0]) + struct.pack('>H', 4)
                       + b''.join(struct.pack('>i', e) for e in [0, 1, 5, -223]))
                s.sendall(msg)
                # one full update request so the session looks live
                s.sendall(bytes([3, 0]) + struct.pack('>HHHH', 0, 0, 10, 10))
                self.s = s
                threading.Thread(target=self._drain, daemon=True).start()
                return
            except Exception:
                time.sleep(2)

    def _drain(self) -> None:
        try:
            while True:
                d = self.s.recv(65536)
                if not d:
                    break
        except Exception:
            pass

    def resize(self, w: int, h: int) -> None:
        with self.lock:
            if (w, h) == self.last or self.s is None:
                return
            msg = (bytes([251, 0]) + struct.pack('>HH', w, h) + bytes([1, 0])
                   + struct.pack('>I', 0) + struct.pack('>HH', 0, 0)
                   + struct.pack('>HH', w, h) + struct.pack('>I', 0))
            for _ in (0, 1):
                try:
                    self.s.sendall(msg)
                    self.last = (w, h)
                    return
                except Exception:
                    self.connect()


cli = RfbClient()
threading.Thread(target=cli.connect, daemon=True).start()


class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        try:
            q = parse_qs(urlparse(self.path).query)
            if self.path.startswith('/resize'):
                w = int(q['w'][0])
                h = int(q['h'][0])
                if 200 <= w <= 4096 and 200 <= h <= 4096:
                    cli.resize(w, h)
        except Exception:
            pass
        self.send_response(204)
        self.end_headers()

    def log_message(self, *a) -> None:  # keep the container log quiet
        pass


socketserver.TCPServer.allow_reuse_address = True
socketserver.TCPServer((LISTEN_ADDR, LISTEN_PORT), H).serve_forever()
