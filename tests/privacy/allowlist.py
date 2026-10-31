"""Allow-list loading and matching for the idle-traffic privacy test.

File format (``tests/privacy/allowlist.json``)::

    {
      "version": 1,
      "entries": [
        {"host": "firefox.settings.services.mozilla.com", "port": 443,
         "purpose": "...", "phase": "first-run|idle",
         "source": "docs/network-calls.md", "provisional": true}
      ]
    }

Host patterns
  * exact hostname (case-insensitive, trailing dot ignored), or an IP literal;
  * ``*.example.com`` -- ``*`` stands for exactly ONE DNS label, so it matches
    ``a.example.com`` but neither ``example.com`` nor ``a.b.example.com``;
  * ``**.example.com`` -- one or more labels (any depth of subdomain).
  Wildcards are only accepted as the left-most label; ``*`` alone is rejected
  because it would silently allow everything.

Ports
  ``"port": 443`` or ``"ports": [80, 443]``.  Omitting both means "any port"
  and is reported as a warning by ``validate`` -- keep the list strict.

Optional ``"deny": ["host", ...]`` lists known phone-home hosts (from
docs/network-calls.md).  It does not change the verdict -- anything not
allowed already fails -- but denied hits are labelled ``known_bad`` in the
report, and a deny pattern that is also allowed is rejected as a contradiction.

DNS-only observations (a name lookup with no connection attempt yet) are
matched on the host alone: a lookup is allowed if *some* entry allows that
host on any port.
"""

import ipaddress
import json

VALID_PHASES = {"first-run", "idle", "shutdown", "any"}


class AllowlistError(ValueError):
    """Raised for a malformed allow-list file (harness error, exit 2)."""


def normalize_host(host):
    host = (host or "").strip().lower()
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    if host.endswith("."):
        host = host[:-1]
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        return host


class Entry:
    def __init__(self, raw, index):
        if not isinstance(raw, dict):
            raise AllowlistError("entry %d: must be an object" % index)
        host = raw.get("host")
        if not isinstance(host, str) or not host.strip():
            raise AllowlistError("entry %d: missing 'host'" % index)
        self.raw = raw
        self.index = index
        self.pattern = normalize_host(host)
        labels = self.pattern.split(".")
        if any(l in ("*", "**") for l in labels[1:]) or any(
            ("*" in l and l not in ("*", "**")) for l in labels
        ):
            raise AllowlistError(
                "entry %d: wildcard only allowed as a whole left-most label: %r"
                % (index, host))
        if labels[0] in ("*", "**") and len(labels) < 3:
            raise AllowlistError(
                "entry %d: wildcard needs at least a registrable domain: %r"
                % (index, host))
        self.wild = labels[0] if labels[0] in ("*", "**") else None
        self.suffix = labels[1:] if self.wild else labels

        if "port" in raw and "ports" in raw:
            raise AllowlistError("entry %d: use 'port' or 'ports', not both" % index)
        ports = raw.get("ports", [raw["port"]] if "port" in raw else None)
        if ports is not None:
            if not isinstance(ports, list) or not ports or not all(
                isinstance(p, int) and not isinstance(p, bool) and 0 < p < 65536
                for p in ports
            ):
                raise AllowlistError("entry %d: invalid port(s) %r" % (index, ports))
            ports = frozenset(ports)
        self.ports = ports
        phase = raw.get("phase", "any")
        if phase not in VALID_PHASES:
            raise AllowlistError("entry %d: invalid phase %r" % (index, phase))

    def matches_host(self, host):
        labels = normalize_host(host).split(".")
        if self.wild is None:
            return labels == self.suffix
        n = len(self.suffix)
        if len(labels) <= n or labels[-n:] != self.suffix:
            return False
        extra = len(labels) - n
        return extra == 1 if self.wild == "*" else extra >= 1

    def matches(self, host, port):
        if not self.matches_host(host):
            return False
        if port is None or self.ports is None:
            return True
        return port in self.ports

    def describe(self):
        d = {"index": self.index, "host": self.raw.get("host")}
        for k in ("port", "ports", "purpose", "phase", "source", "provisional"):
            if k in self.raw:
                d[k] = self.raw[k]
        return d


class Allowlist:
    def __init__(self, data, path="<memory>"):
        if not isinstance(data, dict):
            raise AllowlistError("%s: top level must be an object" % path)
        if data.get("version") != 1:
            raise AllowlistError("%s: unsupported version %r" % (path, data.get("version")))
        entries = data.get("entries")
        if not isinstance(entries, list):
            raise AllowlistError("%s: 'entries' must be a list" % path)
        self.path = path
        self.entries = [Entry(e, i) for i, e in enumerate(entries)]
        deny = data.get("deny", [])
        if not isinstance(deny, list) or not all(isinstance(h, str) and h for h in deny):
            raise AllowlistError("%s: 'deny' must be a list of host patterns" % path)
        self.deny = [Entry({"host": h}, i) for i, h in enumerate(deny)]
        for d in self.deny:
            if d.wild is None and self.match(d.pattern, None):
                raise AllowlistError("%s: %s is both allowed and denied" % (path, d.pattern))

    @classmethod
    def load(cls, path):
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            raise AllowlistError("cannot read allow-list %s: %s" % (path, e))
        return cls(data, path)

    def match(self, host, port=None):
        """Return the first matching Entry or None.  ``port=None`` = DNS-only."""
        for e in self.entries:
            if e.matches(host, port):
                return e
        return None

    def is_known_bad(self, host):
        return any(d.matches_host(host) for d in self.deny)

    def warnings(self):
        out = []
        for e in self.entries:
            if e.ports is None:
                out.append("entry %d (%s) allows any port" % (e.index, e.raw["host"]))
            if e.wild == "**":
                out.append("entry %d (%s) allows any subdomain depth" % (e.index, e.raw["host"]))
        return out
