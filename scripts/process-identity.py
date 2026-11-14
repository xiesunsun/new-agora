#!/usr/bin/env python3
"""Read process birth identities and group membership without command arguments."""

import ctypes
import json
import os
from pathlib import Path
import sys


def missing(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return {"pid": pid, "state": "dead"}
    except PermissionError:
        pass
    return {"pid": pid, "state": "unknown"}


if sys.platform == "darwin":
    class BsdInfo(ctypes.Structure):
        _fields_ = [
            (name, ctypes.c_uint32)
            for name in (
                "flags", "status", "xstatus", "pid", "ppid", "uid", "gid",
                "ruid", "rgid", "svuid", "svgid", "reserved",
            )
        ] + [
            ("comm", ctypes.c_char * 16),
            ("name", ctypes.c_char * 32),
            ("nfiles", ctypes.c_uint32),
            ("pgid", ctypes.c_uint32),
            ("jobc", ctypes.c_uint32),
            ("tdev", ctypes.c_uint32),
            ("tpgid", ctypes.c_uint32),
            ("nice", ctypes.c_int32),
            ("start_sec", ctypes.c_uint64),
            ("start_usec", ctypes.c_uint64),
        ]

    libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    libproc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64,
                                   ctypes.c_void_p, ctypes.c_int]
    libproc.proc_pidinfo.restype = ctypes.c_int
    libproc.proc_listpids.argtypes = [ctypes.c_uint32, ctypes.c_uint32,
                                    ctypes.c_void_p, ctypes.c_int]
    libproc.proc_listpids.restype = ctypes.c_int

    def identity(pid):
        info = BsdInfo()
        size = libproc.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
        if size != ctypes.sizeof(info) or info.pid != pid or not info.start_sec:
            return missing(pid)
        if info.status == 5:
            return {"pid": pid, "state": "dead"}
        return {"pid": pid, "ppid": info.ppid, "pgid": info.pgid,
                "birth": f"darwin:{info.start_sec}:{info.start_usec}", "state": "alive"}

    def all_pids():
        size = libproc.proc_listpids(1, 0, None, 0)
        if size <= 0:
            raise OSError(ctypes.get_errno(), "Cannot enumerate process IDs")
        buffer = (ctypes.c_int * (size // ctypes.sizeof(ctypes.c_int) + 1024))()
        count = libproc.proc_listpids(1, 0, buffer, ctypes.sizeof(buffer))
        if count < 0 or count >= ctypes.sizeof(buffer):
            raise OSError("Incomplete process ID snapshot")
        return [pid for pid in buffer[:count // ctypes.sizeof(ctypes.c_int)] if pid > 0]

elif sys.platform == "linux":
    boot_id = Path("/proc/sys/kernel/random/boot_id").read_text().strip()

    def identity(pid):
        try:
            fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
            if fields[0] in ("Z", "X"):
                return {"pid": pid, "state": "dead"}
            return {"pid": pid, "ppid": int(fields[1]), "pgid": int(fields[2]),
                    "birth": f"linux:{boot_id}:{fields[19]}", "state": "alive"}
        except (OSError, ValueError, IndexError):
            return missing(pid)

    def all_pids():
        return [int(path.name) for path in Path("/proc").iterdir() if path.name.isdigit()]

else:
    raise SystemExit("Test process ownership supports macOS and Linux only")

pids = all_pids() if sys.argv[1:] == ["--all"] else [int(pid) for pid in sys.argv[1:]]
if any(pid <= 0 for pid in pids):
    raise SystemExit("Process IDs must be positive")
print(json.dumps([identity(pid) for pid in pids]))
