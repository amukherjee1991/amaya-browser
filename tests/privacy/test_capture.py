"""Tests for the DNS stub, fake-IP pool and sinkhole packet parser."""

import ipaddress
import socket
import struct
import unittest

from dnsstub import DnsStub, FakeIPPool, build_response, parse_query
from events import EventLog
import sinkhole


def dns_query(name, qtype=1, txid=0x1234):
    q = struct.pack("!HHHHHH", txid, 0x0100, 1, 0, 0, 0)
    for label in name.split("."):
        q += bytes([len(label)]) + label.encode()
    return q + b"\x00" + struct.pack("!HH", qtype, 1)


def ipv4_packet(dst, proto, l4):
    hdr = struct.pack("!BBHHHBBH4s4s", 0x45, 0, 20 + len(l4), 0, 0x4000, 64, proto, 0,
                      socket.inet_aton("198.19.255.254"), socket.inet_aton(dst))
    return hdr + l4


def ipv6_packet(dst, nh, l4):
    hdr = struct.pack("!IHBB16s16s", 0x60000000, len(l4), nh, 64,
                      ipaddress.IPv6Address("fd00:a3a9::1").packed,
                      ipaddress.IPv6Address(dst).packed)
    return hdr + l4


def tcp_syn(sport, dport):
    return struct.pack("!HHIIBBHHH", sport, dport, 1, 0, 0x50, 0x02, 65535, 0, 0)


def udp(sport, dport, payload=b""):
    return struct.pack("!HHHH", sport, dport, 8 + len(payload), 0) + payload


class FakeIPPoolTest(unittest.TestCase):
    def test_stable_and_reversible(self):
        p = FakeIPPool()
        a = p.ip_for("a.example")
        self.assertEqual(p.ip_for("a.example"), a)
        b = p.ip_for("b.example")
        self.assertNotEqual(a, b)
        self.assertEqual(p.host_for(b), "b.example")
        self.assertTrue(p.contains(a))
        self.assertFalse(p.contains("1.1.1.1"))


class DnsTest(unittest.TestCase):
    def test_parse_and_answer_a(self):
        q = dns_query("Incoming.Telemetry.Mozilla.org")
        txid, _flags, name, qtype, _ = parse_query(q)
        self.assertEqual((txid, name, qtype), (0x1234, "incoming.telemetry.mozilla.org", 1))
        r = build_response(q, "198.18.0.10")
        self.assertEqual(struct.unpack("!H", r[:2])[0], 0x1234)
        self.assertTrue(struct.unpack("!H", r[2:4])[0] & 0x8000)
        self.assertEqual(struct.unpack("!H", r[6:8])[0], 1)
        self.assertEqual(r[-4:], socket.inet_aton("198.18.0.10"))

    def test_empty_answer(self):
        r = build_response(dns_query("x.example", 28))
        self.assertEqual(struct.unpack("!HH", r[4:8]), (1, 0))

    def test_rejects_responses_and_garbage(self):
        with self.assertRaises(ValueError):
            parse_query(b"\x00" * 5)
        resp = bytearray(dns_query("x.example"))
        resp[2] |= 0x80
        with self.assertRaises(ValueError):
            parse_query(bytes(resp))

    def test_live_stub_udp_and_tcp(self):
        log, pool = EventLog(), FakeIPPool()
        stub = DnsStub(log, pool, port=0).start()
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.settimeout(3)
            s.sendto(dns_query("push.services.mozilla.com"), ("127.0.0.1", stub.port))
            r, _ = s.recvfrom(512)
            s.close()
            ip = socket.inet_ntoa(r[-4:])
            self.assertEqual(pool.host_for(ip), "push.services.mozilla.com")
            with socket.create_connection(("127.0.0.1", stub.port), timeout=3) as t:
                q = dns_query("example.org", 65)
                t.sendall(struct.pack("!H", len(q)) + q)
                n = struct.unpack("!H", t.recv(2))[0]
                self.assertGreater(n, 12)
            names = [(e["host"], e["detail"]["qtype"], e["detail"]["transport"])
                     for e in log.events]
            self.assertEqual(names, [("push.services.mozilla.com", "A", "udp"),
                                     ("example.org", "HTTPS", "tcp")])
        finally:
            stub.stop()


class FakeSink(sinkhole.Sinkhole):
    def __init__(self, log, pool):  # no TUN device in unit tests
        self.log, self.pool, self.name = log, pool, "test"
        self._seen, self._stop, self.packets = set(), False, 0


class SinkholeParseTest(unittest.TestCase):
    def test_tcp_syn_v4(self):
        p = sinkhole.parse_packet(ipv4_packet("1.2.3.4", 6, tcp_syn(40000, 443)))
        self.assertEqual((p["dst"], p["proto"], p["dport"], p["syn"]),
                         ("1.2.3.4", "tcp", 443, True))

    def test_udp_quic_v6(self):
        p = sinkhole.parse_packet(ipv6_packet("2001:db8::1", 17, udp(5000, 443, b"q")))
        self.assertEqual((p["dst"], p["proto"], p["dport"]), ("2001:db8::1", "udp", 443))

    def test_direct_dns_qname(self):
        p = sinkhole.parse_packet(ipv4_packet("8.8.8.8", 17, udp(5000, 53, dns_query("a.example"))))
        self.assertEqual(p["qname"], "a.example")

    def test_v6_extension_header(self):
        hbh = bytes([17, 0]) + b"\x00" * 6  # hop-by-hop -> UDP
        p = sinkhole.parse_packet(ipv6_packet("2001:db8::2", 0, hbh + udp(1, 3478)))
        self.assertEqual((p["proto"], p["dport"]), ("udp", 3478))

    def test_noise_ignored(self):
        self.assertIsNone(sinkhole.parse_packet(ipv6_packet("ff02::2", 58, b"\x85\x00" + b"\0" * 6)))
        self.assertIsNone(sinkhole.parse_packet(ipv4_packet("224.0.0.22", 2, b"\0" * 8)))
        self.assertIsNone(sinkhole.parse_packet(b""))
        self.assertIsNone(sinkhole.parse_packet(b"\x45\x00"))
        frag = bytearray(ipv4_packet("1.2.3.4", 17, udp(1, 2)))
        frag[6:8] = struct.pack("!H", 100)
        self.assertIsNone(sinkhole.parse_packet(bytes(frag)))

    def test_handle_attributes_fake_ip_and_dedupes(self):
        log, pool = EventLog(), FakeIPPool()
        ip = pool.ip_for("incoming.telemetry.mozilla.org")
        sink = FakeSink(log, pool)
        pkt = ipv4_packet(ip, 6, tcp_syn(40000, 443))
        self.assertIsNotNone(sink.handle(pkt))
        self.assertIsNone(sink.handle(pkt))  # SYN retransmit
        ev = log.events[0]
        self.assertEqual((ev["via"], ev["host"], ev["port"], ev["proto"]),
                         ("sinkhole", "incoming.telemetry.mozilla.org", 443, "tcp"))
        self.assertEqual(ev["detail"]["ip"], ip)
        sink.handle(ipv4_packet("9.9.9.9", 17, udp(1, 443)))
        self.assertEqual(log.events[-1]["host"], "9.9.9.9")


if __name__ == "__main__":
    unittest.main()
