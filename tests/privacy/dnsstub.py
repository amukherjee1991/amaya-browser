"""Tiny recording DNS stub with fake-IP answers (stdlib only).

Inside the test's network namespace ``/etc/resolv.conf`` points at this stub
(127.0.0.1:53).  Every query is recorded.  ``A`` queries get a unique fake
address from 198.18.0.0/16 (RFC 2544 benchmarking range); every other type
gets an empty NOERROR answer.  The sinkhole interface then attributes any
direct connection to a fake address back to the hostname that was looked up,
so traffic that bypasses the proxy is still reported by *name and port*.
"""

import ipaddress
import socket
import struct
import threading

QTYPES = {1: "A", 2: "NS", 5: "CNAME", 6: "SOA", 12: "PTR", 15: "MX",
          16: "TXT", 28: "AAAA", 33: "SRV", 64: "SVCB", 65: "HTTPS", 255: "ANY"}


class FakeIPPool:
    def __init__(self, network="198.18.0.0/16"):
        self.net = ipaddress.ip_network(network)
        self._next = int(self.net.network_address) + 10
        self._by_host = {}
        self._by_ip = {}
        self._lock = threading.Lock()

    def ip_for(self, host):
        with self._lock:
            ip = self._by_host.get(host)
            if ip is None:
                if self._next >= int(self.net.broadcast_address):
                    raise RuntimeError("fake IP pool exhausted")
                ip = str(ipaddress.ip_address(self._next))
                self._next += 1
                self._by_host[host] = ip
                self._by_ip[ip] = host
            return ip

    def host_for(self, ip):
        with self._lock:
            return self._by_ip.get(ip)

    def contains(self, ip):
        try:
            return ipaddress.ip_address(ip) in self.net
        except ValueError:
            return False


def parse_query(data):
    """Return (txid, flags, qname, qtype, end_of_question) ; raises ValueError."""
    if len(data) < 12:
        raise ValueError("short packet")
    txid, flags, qd = struct.unpack("!HHH", data[:6])
    if flags & 0x8000 or qd < 1:
        raise ValueError("not a query")
    labels, pos = [], 12
    while True:
        if pos >= len(data):
            raise ValueError("truncated qname")
        n = data[pos]
        pos += 1
        if n == 0:
            break
        if n & 0xC0:
            raise ValueError("compressed qname in question")
        labels.append(data[pos:pos + n].decode("ascii", "replace"))
        pos += n
    if pos + 4 > len(data):
        raise ValueError("truncated question")
    qtype, _qclass = struct.unpack("!HH", data[pos:pos + 4])
    return txid, flags, ".".join(labels).lower(), qtype, pos + 4


def build_response(query, answer_ip=None, rcode=0):
    txid, flags, _qname, _qtype, qend = parse_query(query)
    rflags = 0x8000 | (flags & 0x7900) | 0x0080 | (rcode & 0xF)  # QR, opcode+RD, RA
    ancount = 1 if answer_ip else 0
    out = struct.pack("!HHHHHH", txid, rflags, 1, ancount, 0, 0) + query[12:qend]
    if answer_ip:
        out += struct.pack("!HHHIH", 0xC00C, 1, 1, 30, 4) + socket.inet_aton(answer_ip)
    return out


class DnsStub:
    def __init__(self, log, pool, host="127.0.0.1", port=53):
        self.log, self.pool = log, pool
        self.udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.udp.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.udp.bind((host, port))
        self.tcp = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.tcp.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.tcp.bind((host, self.udp.getsockname()[1]))
        self.tcp.listen(16)
        self.port = self.udp.getsockname()[1]
        self.udp.settimeout(0.5)
        self.tcp.settimeout(0.5)
        self._stop = False

    def answer(self, data, transport):
        try:
            _txid, _flags, qname, qtype, _ = parse_query(data)
        except ValueError:
            return None
        self.log.record("dns", qname, None, "dns",
                        qtype=QTYPES.get(qtype, str(qtype)), transport=transport)
        ip = None
        if qtype == 1 and qname and not qname.endswith(".arpa"):
            ip = self.pool.ip_for(qname)
        return build_response(data, ip)

    def _serve_udp(self):
        while not self._stop:
            try:
                data, addr = self.udp.recvfrom(4096)
            except socket.timeout:
                continue
            except OSError:
                return
            resp = self.answer(data, "udp")
            if resp:
                try:
                    self.udp.sendto(resp, addr)
                except OSError:
                    pass

    def _serve_tcp_conn(self, conn):
        conn.settimeout(5)
        try:
            while True:
                hdr = conn.recv(2)
                if len(hdr) < 2:
                    return
                (n,) = struct.unpack("!H", hdr)
                data = b""
                while len(data) < n:
                    chunk = conn.recv(n - len(data))
                    if not chunk:
                        return
                    data += chunk
                resp = self.answer(data, "tcp")
                if not resp:
                    return
                conn.sendall(struct.pack("!H", len(resp)) + resp)
        except OSError:
            pass
        finally:
            conn.close()

    def _serve_tcp(self):
        while not self._stop:
            try:
                conn, _ = self.tcp.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            threading.Thread(target=self._serve_tcp_conn, args=(conn,), daemon=True).start()

    def start(self):
        threading.Thread(target=self._serve_udp, name="dns-udp", daemon=True).start()
        threading.Thread(target=self._serve_tcp, name="dns-tcp", daemon=True).start()
        return self

    def stop(self):
        self._stop = True
        for s in (self.udp, self.tcp):
            try:
                s.close()
            except OSError:
                pass
