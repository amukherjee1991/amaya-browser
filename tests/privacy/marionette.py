"""Minimal Marionette client (stdlib only) used by the ``newtab`` scenario.

Wire format: ``<len>:<json>``; commands are ``[0, id, name, params]`` and
replies ``[1, id, error, result]``.
"""

import json
import socket
import time


class MarionetteError(RuntimeError):
    pass


class Marionette:
    def __init__(self, host="127.0.0.1", port=2828, timeout=60):
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            try:
                self.sock = socket.create_connection((host, port), timeout=10)
                break
            except OSError as e:
                last = e
                time.sleep(0.5)
        else:
            raise MarionetteError("cannot connect to Marionette: %s" % last)
        self._buf = b""
        self._id = 0
        self.hello = self._read()

    def _read(self):
        while b":" not in self._buf:
            self._buf += self._recv()
        n, _, rest = self._buf.partition(b":")
        n = int(n)
        while len(rest) < n:
            rest += self._recv()
        msg, self._buf = rest[:n], rest[n:]
        return json.loads(msg)

    def _recv(self):
        chunk = self.sock.recv(65536)
        if not chunk:
            raise MarionetteError("connection closed")
        return chunk

    def command(self, name, params=None):
        self._id += 1
        body = json.dumps([0, self._id, name, params or {}]).encode()
        self.sock.sendall(str(len(body)).encode() + b":" + body)
        while True:
            msg = self._read()
            if isinstance(msg, list) and len(msg) == 4 and msg[0] == 1 and msg[1] == self._id:
                if msg[2]:
                    raise MarionetteError("%s: %s" % (name, msg[2]))
                return msg[3]

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass
