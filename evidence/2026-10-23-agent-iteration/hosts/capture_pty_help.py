#!/usr/bin/env python3
"""Retain complete help with stdout PTY, separate stderr, and bounded owned child groups."""
import errno, fcntl, hashlib, json, os, pathlib, pty, selectors, signal, struct, subprocess, termios, time

ROOT = pathlib.Path(__file__).resolve().parent
COMMANDS = [
    ("claude-help-pty", "/Users/sushantsrikrish/.local/bin/claude", ["--help"]),
    ("claude-mcp-help-pty", "/Users/sushantsrikrish/.local/bin/claude", ["mcp", "--help"]),
    ("gemini-help-pty", "/Users/sushantsrikrish/.nvm/versions/node/v25.8.1/bin/gemini", ["--help"]),
    ("gemini-mcp-help-pty", "/Users/sushantsrikrish/.nvm/versions/node/v25.8.1/bin/gemini", ["mcp", "--help"]),
    ("gemini-mcp-add-help-pty", "/Users/sushantsrikrish/.nvm/versions/node/v25.8.1/bin/gemini", ["mcp", "add", "--help"]),
]
records = []
for stem, binary, args in COMMANDS:
    assert args[-1] == "--help"
    if any((ROOT / (stem + "." + stream + ".txt")).exists() for stream in ("stdout", "stderr")):
        raise FileExistsError("refusing to replace retained help: " + stem)
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    start = time.monotonic()
    child = subprocess.Popen([binary, *args], stdin=subprocess.DEVNULL, stdout=slave,
        stderr=subprocess.PIPE, start_new_session=True)
    os.close(slave)
    selector = selectors.DefaultSelector()
    selector.register(master, selectors.EVENT_READ, "stdout")
    selector.register(child.stderr, selectors.EVENT_READ, "stderr")
    streams = {"stdout": bytearray(), "stderr": bytearray()}
    timed_out = False
    truncated = False
    while selector.get_map():
        if time.monotonic() - start > 45 or sum(map(len, streams.values())) > 131072:
            timed_out = time.monotonic() - start > 45
            truncated = not timed_out
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        for key, _ in selector.select(.05):
            descriptor = key.fileobj if isinstance(key.fileobj, int) else key.fileobj.fileno()
            try:
                data = os.read(descriptor, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                data = b""
            if data:
                streams[key.data].extend(data)
            else:
                selector.unregister(key.fileobj)
                if isinstance(key.fileobj, int):
                    os.close(key.fileobj)
    child.wait()
    selector.close()
    record = {"stem": stem, "binary": binary, "argv": args,
        "transport": "stdout-pty/stderr-pipe", "exitCode": child.returncode,
        "timedOut": timed_out, "outputTruncated": truncated,
        "elapsedMs": round((time.monotonic() - start) * 1000)}
    for stream, data in streams.items():
        file = ROOT / (stem + "." + stream + ".txt")
        file.write_bytes(data)
        record[stream] = {"path": file.name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    records.append(record)
(ROOT / "HOST_PTY_HELP.json").write_text(json.dumps({"schemaVersion": 1,
    "observedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "timeoutSeconds": 45, "maxBytes": 131072, "observations": records}, indent=2) + "\n")
print(json.dumps({"observations": len(records), "exitCodes": [x["exitCode"] for x in records]}))
