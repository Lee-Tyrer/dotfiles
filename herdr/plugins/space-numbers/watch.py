#!/usr/bin/env python3
"""Re-run space-numbers.bash whenever a pane updates.

Herdr auto-relabels a Space when its pane's cwd changes, but only emits
pane.updated for it, and plugin event hooks don't fire for pane.updated.
So subscribe over the socket and refresh the $num token ourselves.
"""
import json
import os
import socket
import subprocess

SOCKET = os.environ.get("HERDR_SOCKET_PATH", os.path.expanduser("~/.config/herdr/herdr.sock"))
HERE = os.path.dirname(os.path.abspath(__file__))
REFRESH = ["bash", os.path.join(HERE, "space-numbers.bash")]
DEBOUNCE = 0.3


def refresh():
    subprocess.run(REFRESH, check=False)


def watch():
    """Return True to resubscribe (events_lost), False when the server is gone."""
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(SOCKET)
    request = {
        "id": "space-numbers",
        "method": "events.subscribe",
        "params": {"subscriptions": [{"type": "pane.updated"}]},
    }
    sock.sendall((json.dumps(request) + "\n").encode())
    refresh()

    buf = b""
    pending = False
    while True:
        sock.settimeout(DEBOUNCE if pending else None)
        try:
            chunk = sock.recv(65536)
        except socket.timeout:
            pending = False
            refresh()
            continue
        if not chunk:
            return False
        buf += chunk
        *lines, buf = buf.split(b"\n")
        for line in lines:
            if not line.strip():
                continue
            msg = json.loads(line)
            if "error" in msg:
                return msg["error"].get("code") == "events_lost"
            if "data" in msg:
                pending = True


try:
    while watch():
        pass
except (OSError, ValueError):
    pass
