"""exec a command as the invoking (non-root) user from inside the test namespace.

The in-namespace runner is uid 0 of an unprivileged user namespace (it needs
CAP_NET_ADMIN there to build the sinkhole).  The browser must not run with
those capabilities, so we create one more, nested user namespace that maps
the real uid/gid back in, then exec.  On exec every capability is dropped
(uid != 0), so the browser is an ordinary unprivileged process whose only
network is the one we built -- and its own sandbox still works normally
(nested user namespaces are allowed).

usage: python3 dropuser.py UID GID -- COMMAND [ARGS...]
"""

import ctypes
import os
import sys

CLONE_NEWUSER = 0x10000000


def _unshare_user():
    if hasattr(os, "unshare"):  # Python >= 3.12
        os.unshare(os.CLONE_NEWUSER)
        return
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.unshare(CLONE_NEWUSER) != 0:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err))


def main(argv):
    if len(argv) < 5 or argv[3] != "--":
        sys.stderr.write(__doc__)
        return 2
    uid, gid = int(argv[1]), int(argv[2])
    outer_uid, outer_gid = os.getuid(), os.getgid()
    _unshare_user()
    with open("/proc/self/setgroups", "w") as f:
        f.write("deny")
    with open("/proc/self/uid_map", "w") as f:
        f.write("%d %d 1\n" % (uid, outer_uid))
    with open("/proc/self/gid_map", "w") as f:
        f.write("%d %d 1\n" % (gid, outer_gid))
    os.setgid(gid)
    os.setuid(uid)
    os.execvp(argv[4], argv[4:])
    return 127


if __name__ == "__main__":
    sys.exit(main(sys.argv))
