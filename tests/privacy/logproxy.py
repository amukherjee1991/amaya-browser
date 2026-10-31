"""Logging, *blocking* HTTP/CONNECT forward proxy (stdlib only).

The browser profile is pointed at this proxy for HTTP and HTTPS.  For every
request we record the destination host:port (and, for plain-HTTP absolute-form
requests, the URL) and then refuse it with ``403``.  Nothing is forwarded, so
the test is deterministic, works offline and never leaks data.
"""

import socket
import socketserver
import threading
from urllib.parse import urlsplit

MAX_HEAD = 64 * 1024
DEFAULT_PORTS = {"http": 80, "ws": 80, "https": 443, "wss": 443, "ftp": 21}

_BODY_403 = b"blocked by Amaya idle-traffic test harness\n"
RESPONSE_403 = (
    b"HTTP/1.1 403 Forbidden\r\n"
    b"Content-Type: text/plain\r\n"
    b"Content-Length: %d\r\n"
    b"Connection: close\r\n"
    b"X-Amaya-Privacy-Test: blocked\r\n"
    b"\r\n" % len(_BODY_403)
) + _BODY_403
RESPONSE_400 = b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"


def split_authority(authority, default_port=None):
    """'host:port' / '[v6]:port' / 'host' -> (host, port) ; raises ValueError."""
    authority = authority.strip()
    if "@" in authority:
        authority = authority.rsplit("@", 1)[1]
    if authority.startswith("["):
        end = authority.index("]")
        host, rest = authority[1:end], authority[end + 1:]
        port = int(rest[1:]) if rest.startswith(":") else default_port
    elif authority.count(":") == 1:
        host, p = authority.split(":")
        port = int(p) if p else default_port
    elif authority.count(":") > 1:  # bare IPv6 without brackets
        host, port = authority, default_port
    else:
        host, port = authority, default_port
    if not host or (port is not None and not 0 < port < 65536):
        raise ValueError("bad authority %r" % authority)
    return host.lower().rstrip("."), port


def parse_request_head(head):
    """Parse a request head (bytes, up to the blank line).

    Returns dict(method, host, port, url) ; raises ValueError if unparseable.
    """
    text = head.decode("iso-8859-1")
    lines = text.split("\r\n")
    parts = lines[0].split()
    if len(parts) != 3 or not parts[2].startswith("HTTP/"):
        raise ValueError("bad request line %r" % lines[0][:200])
    method, target, _ = parts
    headers = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers.setdefault(k.strip().lower(), v.strip())
    if method.upper() == "CONNECT":
        host, port = split_authority(target, None)
        if port is None:
            raise ValueError("CONNECT without port")
        return {"method": "CONNECT", "host": host, "port": port, "url": None}
    if "://" in target:
        u = urlsplit(target)
        scheme = u.scheme.lower()
        host, port = split_authority(u.netloc, DEFAULT_PORTS.get(scheme, 80))
        return {"method": method, "host": host, "port": port, "url": target[:500]}
    if "host" in headers:
        host, port = split_authority(headers["host"], 80)
        return {"method": method, "host": host, "port": port,
                "url": "http://%s%s" % (headers["host"], target[:400])}
    raise ValueError("no destination in request")


class _Handler(socketserver.BaseRequestHandler):
    def handle(self):
        sock = self.request
        sock.settimeout(10)
        buf = b""
        try:
            while b"\r\n\r\n" not in buf and len(buf) < MAX_HEAD:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                buf += chunk
        except (socket.timeout, OSError):
            pass
        head = buf.split(b"\r\n\r\n", 1)[0]
        try:
            req = parse_request_head(head)
        except (ValueError, IndexError):
            if buf:
                self.server.log.record("proxy", None, None, "tcp",
                                       error="unparseable request",
                                       head=head[:200].decode("iso-8859-1"))
            self._send(RESPONSE_400)
            return
        detail = {"method": req["method"]}
        if req["url"]:
            detail["url"] = req["url"]
        self.server.log.record("proxy", req["host"], req["port"], "tcp", **detail)
        self._send(RESPONSE_403)

    def _send(self, data):
        try:
            self.request.sendall(data)
            self.request.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass


class LoggingProxy(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, log, host="127.0.0.1", port=0):
        self.log = log
        super().__init__((host, port), _Handler)
        self.port = self.server_address[1]
        self._thread = None

    def start(self):
        self._thread = threading.Thread(target=self.serve_forever,
                                        kwargs={"poll_interval": 0.2},
                                        name="logproxy", daemon=True)
        self._thread.start()
        return self

    def stop(self):
        self.shutdown()
        self.server_close()
