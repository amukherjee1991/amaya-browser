"""Turn captured events into a verdict + JSON / text report."""

import ipaddress

from allowlist import normalize_host

REPORT_SCHEMA = 1
MAX_SAMPLES = 5


def is_local(host):
    if host is None:
        return False
    h = normalize_host(host)
    if h == "localhost" or h.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(h).is_loopback
    except ValueError:
        return False


def _transport(ev):
    if ev["via"] == "dns":
        return "dns"
    if ev["via"] == "proxy":
        return "tcp"
    return ev.get("proto") or "?"


def aggregate(events):
    """Group traffic events into destinations keyed by (host, port, transport).

    Returns (destinations, ignored, anomalies, notes).
    """
    dests, ignored, anomalies, notes = {}, {}, [], []
    for ev in sorted(events, key=lambda e: (e.get("scenario") or "", e["t"])):
        via = ev.get("via")
        if via == "harness":
            notes.append(ev)
            continue
        host = ev.get("host")
        if not host:
            anomalies.append(ev)
            continue
        host = normalize_host(host)
        key = (host, ev.get("port"), _transport(ev))
        if is_local(host):
            ignored[key] = ignored.get(key, 0) + 1
            continue
        d = dests.get(key)
        if d is None:
            d = dests[key] = {
                "host": host, "port": key[1], "transport": key[2],
                "observed_via": [], "first_seen": {
                    "t": ev["t"], "scenario": ev.get("scenario"),
                    "stage": ev.get("stage")},
                "count": 0, "scenarios": [], "stages": [], "details": {},
            }
        d["count"] += 1
        for field, val in (("observed_via", via), ("scenarios", ev.get("scenario")),
                           ("stages", ev.get("stage"))):
            if val is not None and val not in d[field]:
                d[field].append(val)
        det = ev.get("detail") or {}
        for k, out in (("method", "methods"), ("url", "sample_urls"),
                       ("qtype", "dns_qtypes"), ("ip", "ips"),
                       ("dns_qname", "dns_qnames")):
            v = det.get(k)
            if v is not None:
                lst = d["details"].setdefault(out, [])
                if v not in lst and len(lst) < MAX_SAMPLES:
                    lst.append(v)
    return list(dests.values()), ignored, anomalies, notes


def build_report(events, allowlist, meta=None):
    dests, ignored, anomalies, notes = aggregate(events)
    for d in dests:
        port = None if d["transport"] == "dns" else d["port"]
        entry = allowlist.match(d["host"], port)
        d["allowed"] = entry is not None
        d["matched_entry"] = entry.describe() if entry else None
        d["known_bad"] = allowlist.is_known_bad(d["host"])
    dests.sort(key=lambda d: (d["first_seen"]["scenario"] or "", d["first_seen"]["t"],
                              d["host"], d["port"] or 0))
    denied = [d for d in dests if not d["allowed"]]
    report = {
        "schema": REPORT_SCHEMA,
        "result": "fail" if denied or anomalies else "pass",
        "meta": meta or {},
        "allowlist": {"path": allowlist.path, "entries": len(allowlist.entries),
                      "deny": len(allowlist.deny),
                      "warnings": allowlist.warnings()},
        "summary": {
            "destinations": len(dests),
            "allowed": len(dests) - len(denied),
            "denied": len(denied),
            "denied_hosts": sorted({d["host"] for d in denied}),
            "known_bad_hosts": sorted({d["host"] for d in denied if d["known_bad"]}),
            "all_hosts": sorted({d["host"] for d in dests}),
        },
        "destinations": dests,
        "ignored_loopback": [
            {"host": k[0], "port": k[1], "transport": k[2], "count": n}
            for k, n in sorted(ignored.items(), key=lambda kv: str(kv[0]))],
        "anomalies": anomalies,
        "harness_notes": notes,
    }
    return report


def _endpoint(d):
    if d["transport"] == "dns":
        return "%s (lookup)" % d["host"]
    host = "[%s]" % d["host"] if ":" in d["host"] else d["host"]
    return "%s:%s/%s" % (host, d["port"], d["transport"])


def render_text(report):
    m = report.get("meta", {})
    s = report["summary"]
    out = []
    out.append("Amaya idle-traffic privacy test: %s" % report["result"].upper())
    if m.get("browser"):
        out.append("browser    : %s (%s %s, build %s)" % (
            m["browser"], m.get("product", "?"), m.get("version", "?"), m.get("build_id", "?")))
    if m.get("scenarios"):
        out.append("scenarios  : %s; %ss each; headless=%s" % (
            ", ".join(m["scenarios"]), m.get("duration_s"), not m.get("headful")))
    if m.get("layers"):
        out.append("capture    : %s" % ", ".join(m["layers"]))
    out.append("allow-list : %s (%d entries)" % (report["allowlist"]["path"],
                                                 report["allowlist"]["entries"]))
    for w in report["allowlist"]["warnings"]:
        out.append("  warning  : %s" % w)
    out.append("result     : %d destinations, %d allowed, %d DENIED" % (
        s["destinations"], s["allowed"], s["denied"]))
    out.append("")
    if report["destinations"]:
        rows = [("FIRST SEEN", "VIA", "DESTINATION", "VERDICT", "RULE")]
        for d in report["destinations"]:
            fs = d["first_seen"]
            when = "%s+%.1fs%s" % (fs["scenario"] or "", fs["t"],
                                   " (shutdown)" if fs["stage"] == "shutdown" else "")
            rule = ""
            if d["matched_entry"]:
                rule = "#%d %s" % (d["matched_entry"]["index"], d["matched_entry"]["host"])
            rows.append((when, ",".join(d["observed_via"]), _endpoint(d),
                         "allow" if d["allowed"] else "DENY", rule or
                         ("known phone-home (deny list)" if d.get("known_bad") else "")))
        widths = [max(len(r[i]) for r in rows) for i in range(4)]
        for r in rows:
            out.append("  ".join(r[i].ljust(widths[i]) for i in range(4)) + "  " + r[4])
    else:
        out.append("no outbound destinations observed")
    if report["anomalies"]:
        out.append("")
        out.append("%d unparseable proxy request(s); see JSON 'anomalies'" % len(report["anomalies"]))
    if s["denied_hosts"]:
        out.append("")
        out.append("denied hosts: " + " ".join(s["denied_hosts"]))
    return "\n".join(out) + "\n"
