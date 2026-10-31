"""Thread-safe event log shared by the capture layers.

Every capture layer (proxy, DNS stub, sinkhole) calls ``EventLog.record``.
Events are appended as JSON lines so a crash of the in-namespace runner still
leaves everything observed so far on disk for the outer harness.
"""

import json
import threading
import time


class EventLog:
    def __init__(self, path=None):
        self._lock = threading.Lock()
        self._fh = open(path, "a", encoding="utf-8") if path else None
        self.events = []
        self.t0 = time.monotonic()
        self.scenario = None
        self.stage = "startup"

    def start_clock(self, scenario):
        """Reset t=0 to 'browser launched' for a scenario."""
        with self._lock:
            self.t0 = time.monotonic()
            self.scenario = scenario
            self.stage = "run"

    def set_stage(self, stage):
        with self._lock:
            self.stage = stage

    def record(self, via, host, port=None, proto="tcp", **detail):
        with self._lock:
            ev = {
                "t": round(time.monotonic() - self.t0, 3),
                "scenario": self.scenario,
                "stage": self.stage,
                "via": via,
                "host": host,
                "port": port,
                "proto": proto,
            }
            if detail:
                ev["detail"] = detail
            self.events.append(ev)
            if self._fh:
                self._fh.write(json.dumps(ev, sort_keys=True) + "\n")
                self._fh.flush()
            return ev

    def note(self, kind, **data):
        """Non-traffic diagnostics (harness messages) -- via='harness'."""
        return self.record("harness", None, None, None, kind=kind, **data)

    def close(self):
        with self._lock:
            if self._fh:
                self._fh.close()
                self._fh = None


def read_jsonl(path):
    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    pass  # truncated last line after a hard kill
    return out
