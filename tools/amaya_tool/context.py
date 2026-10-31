"""Repository layout, upstream pin, platform and work-dir resolution."""

from __future__ import annotations

import json
import os
import platform as _platform
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping

from .util import AmayaError

LOCAL_CONFIG = "amaya.local.json"
WORKDIR_ENV = "AMAYA_WORKDIR"


def detect_platform(sys_platform: str | None = None) -> str:
    p = sys_platform or sys.platform
    if p.startswith("linux"):
        return "linux"
    if p == "darwin":
        return "macos"
    raise AmayaError(f"unsupported host platform: {p} (supported: linux, macos)")


def detect_arch(machine: str | None = None) -> str:
    m = (machine or _platform.machine()).lower()
    return {"amd64": "x86_64", "x64": "x86_64", "arm64": "aarch64"}.get(m, m)


def default_repo_root() -> Path:
    # tools/amaya_tool/context.py -> repo root is two levels above amaya_tool/
    return Path(__file__).resolve().parent.parent.parent


@dataclass
class Upstream:
    product: str
    version: str
    channel: str
    source_url: str
    sha512sums_url: str
    amaya_revision: int = 1
    raw: dict = field(default_factory=dict)

    @property
    def tag(self) -> str:
        return f"upstream-{self.version}"

    @property
    def tarball_name(self) -> str:
        return self.source_url.rstrip("/").rsplit("/", 1)[-1]

    @property
    def amaya_version(self) -> str:
        """Amaya release version, as tagged and shown in the app: 159.0-5."""
        return f"{self.version}-{self.amaya_revision}"

    @property
    def deb_version(self) -> str:
        """Debian package version: the Firefox version padded to three parts,
        then the Amaya revision, then "-1" (159.0 rev 5 -> 159.0.0.5-1;
        159.0.1 rev 2 -> 159.0.1.2-1). Software centres hide the part after
        the dash, so the Amaya revision has to live before it."""
        parts = self.version.split(".")
        parts += ["0"] * (3 - len(parts))
        return ".".join(parts + [str(self.amaya_revision)]) + "-1"

    def dist_tarball_name(self, plat: str, arch: str) -> str:
        return f"amaya-{self.version}-{self.amaya_revision}.{plat}-{arch}.tar.xz"


def load_upstream(path: Path) -> Upstream:
    try:
        data = json.loads(path.read_text())
    except FileNotFoundError as e:
        raise AmayaError(f"{path} not found") from e
    except json.JSONDecodeError as e:
        raise AmayaError(f"{path}: invalid JSON: {e}") from e
    missing = [k for k in ("version", "source_url", "sha512sums_url") if not data.get(k)]
    if missing:
        raise AmayaError(f"{path}: missing keys: {', '.join(missing)}")
    rev = data.get("amaya_revision", 1)
    if not isinstance(rev, int) or isinstance(rev, bool) or rev < 1:
        raise AmayaError(f"{path}: amaya_revision must be a positive integer")
    return Upstream(
        product=data.get("product", "firefox"),
        version=str(data["version"]),
        channel=data.get("channel", "release"),
        source_url=data["source_url"],
        sha512sums_url=data["sha512sums_url"],
        amaya_revision=rev,
        raw=data,
    )


class Context:
    """Everything a command needs to know about where things live."""

    def __init__(
        self,
        repo: Path | None = None,
        env: Mapping[str, str] | None = None,
        plat: str | None = None,
        arch: str | None = None,
    ):
        self.repo = Path(repo or default_repo_root()).resolve()
        self.env = dict(os.environ if env is None else env)
        self.platform = plat or detect_platform()
        self.arch = arch or detect_arch()

    # --- repo paths -----------------------------------------------------
    @property
    def upstream_json(self) -> Path:
        return self.repo / "upstream.json"

    @property
    def cache(self) -> Path:
        return self.repo / ".cache"

    @property
    def dist(self) -> Path:
        return self.repo / "dist"

    @property
    def patches_dir(self) -> Path:
        return self.repo / "patches"

    @property
    def branding_dir(self) -> Path:
        return self.repo / "branding" / "amaya"

    @property
    def settings_dir(self) -> Path:
        return self.repo / "settings"

    @property
    def configs_dir(self) -> Path:
        return self.repo / "configs"

    @property
    def repo_engine_link(self) -> Path:
        """<repo>/engine — the engine itself, or a symlink to the workdir engine."""
        return self.repo / "engine"

    def upstream(self) -> Upstream:
        return load_upstream(self.upstream_json)

    # --- work dir -------------------------------------------------------
    def workdir_source(self) -> tuple[Path, str]:
        """Return (workdir, where-it-came-from)."""
        val = self.env.get(WORKDIR_ENV, "").strip()
        if val:
            return Path(os.path.realpath(os.path.expanduser(val))), f"${WORKDIR_ENV}"
        local = self.repo / LOCAL_CONFIG
        if local.is_file():
            try:
                data = json.loads(local.read_text())
            except json.JSONDecodeError as e:
                raise AmayaError(f"{local}: invalid JSON: {e}") from e
            wd = data.get("workdir") if isinstance(data, dict) else None
            if wd:
                p = Path(os.path.expanduser(str(wd)))
                if not p.is_absolute():
                    p = self.repo / p
                return Path(os.path.realpath(p)), LOCAL_CONFIG
        return self.repo, "repo root (default)"

    @property
    def workdir(self) -> Path:
        return self.workdir_source()[0]

    @property
    def engine(self) -> Path:
        """Resolved engine directory (symlinks followed)."""
        return Path(os.path.realpath(self.workdir / "engine"))

    @property
    def objdir(self) -> Path:
        return Path(os.path.realpath(
            self.workdir / f"obj-amaya-{self.platform}-{self.arch}"))

    def require_no_spaces(self) -> None:
        """mach refuses to run from (or build into) a path containing spaces."""
        for label, p in (("engine", self.engine), ("objdir", self.objdir)):
            if " " in str(p):
                raise AmayaError(
                    f"the {label} path contains a space, which mach does not "
                    f"support:\n    {p}\n"
                    f"Set {WORKDIR_ENV} to a directory without spaces "
                    f"(e.g. export {WORKDIR_ENV}=$HOME/amaya-build), or write "
                    f'{{"workdir": "/path/without/spaces"}} to '
                    f"{self.repo / LOCAL_CONFIG}."
                )

    def require_engine(self) -> Path:
        eng = self.engine
        if not (eng / ".git").exists():
            raise AmayaError(
                f"no engine checkout at {eng} — run `tools/amaya fetch` first")
        return eng

    @property
    def mozconfig_path(self) -> Path:
        return self.engine / "mozconfig"

    def mach_env(self) -> dict[str, str]:
        env = dict(self.env)
        env["MOZCONFIG"] = str(self.mozconfig_path)
        # Opt out of mach's own build-system telemetry.
        env["DISABLE_TELEMETRY"] = "1"
        return env
