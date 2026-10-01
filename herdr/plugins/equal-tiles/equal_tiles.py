#!/usr/bin/env python3
"""Size same-direction pane siblings through Herdr's public socket API.

A startup hook launches one subscriber per session. Ratio-only changes update
its cache; only adding/removing panes redistributes space. Perpendicular splits
remain independent groups. No PTYs, pane identities, or focus are replaced.
"""

import argparse
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import select
import socket
import subprocess
import sys
import time

PLUGIN_ID = "lee.equal-tiles"
TIMEOUT = 5


class ApiError(RuntimeError):
    def __init__(self, error):
        self.code = error["code"]
        super().__init__(f"{self.code}: {error['message']}")


def connect(socket_path):
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(TIMEOUT)
    try:
        client.connect(socket_path)
    except OSError:
        client.close()
        raise
    return client


def request(socket_path, method, params=None):
    payload = {"id": "equal-tiles", "method": method, "params": params or {}}
    with connect(socket_path) as client:
        client.sendall(json.dumps(payload).encode() + b"\n")
        with client.makefile("rb") as stream:
            line = stream.readline()
    if not line:
        raise RuntimeError("Herdr closed the API connection without a response")
    response = json.loads(line)
    if "error" in response:
        raise ApiError(response["error"])
    return response["result"]


def tree(node):
    """Keep sizing and identity, not terminal commands or working directories."""
    if node["type"] == "pane":
        return {"type": "pane", "pane_id": node["pane_id"]}
    return {
        "type": "split", "direction": node["direction"], "ratio": node["ratio"],
        "first": tree(node["first"]), "second": tree(node["second"]),
    }


def pane_ids(node):
    if node["type"] == "pane":
        return frozenset([node["pane_id"]])
    return pane_ids(node["first"]) | pane_ids(node["second"])


def prune(node, keep):
    """Undo newly inserted binary splits without losing the target's old share."""
    if node["type"] == "pane":
        return node if node["pane_id"] in keep else None
    first, second = prune(node["first"], keep), prune(node["second"], keep)
    if first is None:
        return second
    if second is None:
        return first
    return {**node, "first": first, "second": second}


def groups(root, path=()):
    """Flatten a run of same-axis splits into conceptual n-ary siblings."""
    if root["type"] == "pane":
        return
    direction = root["direction"]
    members = []

    def flatten(node, node_path, share):
        if node["type"] == "split" and node["direction"] == direction:
            flatten(node["first"], node_path + (False,), share * node["ratio"])
            flatten(node["second"], node_path + (True,), share * (1 - node["ratio"]))
        else:
            members.append((node, node_path, share))

    flatten(root, path, 1.0)
    yield root, path, members
    for node, member_path, _ in members:
        yield from groups(node, member_path)


def projected(members, common):
    return [(pane_ids(node) & common, share) for node, _, share in members]


def ratio_updates(root, previous=None, force=False):
    """Insert equal-share siblings, preserving existing relative proportions."""
    if not force and previous is not None and pane_ids(root) == pane_ids(previous):
        return []
    common = pane_ids(root) & pane_ids(previous) if previous else frozenset()
    if previous and pane_ids(previous) < pane_ids(root):
        # Derive insertion weights from the live split, including any manual
        # resize whose event arrived immediately before the split event.
        previous = prune(root, pane_ids(previous))
    old_groups = list(groups(previous)) if previous else []
    updates = []
    for group, group_path, members in groups(root):
        weights = None
        if force:
            weights = [1.0] * len(members)
        else:
            current = projected(members, common)
            surviving_keys = [key for key, _ in current if key]
            for old_group, _, old_members in old_groups:
                old = projected(old_members, common)
                if old_group["direction"] != group["direction"]:
                    continue
                if [key for key, _ in old if key] != surviving_keys:
                    continue
                # Changes inside a perpendicular member do not resize its parent.
                if all(key for key, _ in old) and all(key for key, _ in current):
                    weights = [share for _, share in current]
                    break
                old_weights = dict((key, share) for key, share in old if key)
                total = sum(old_weights.values())
                added = sum(not key for key, _ in current)
                if total:
                    remaining = (len(members) - added) / len(members)
                    weights = [
                        old_weights[key] / total * remaining if key else 1 / len(members)
                        for key, _ in current
                    ]
                break
            if weights is None:
                # A brand-new two-pane split retains its requested ratio. A new
                # multi-pane group or a group merged by closing a pane balances.
                weights = [1.0] * len(members) if len(members) > 2 else None
        if weights is None:
            continue
        shares = dict(zip((path for _, path, _ in members), weights))

        def distribute(node, path):
            if path in shares:
                return shares[path]
            first = distribute(node["first"], path + (False,))
            second = distribute(node["second"], path + (True,))
            # Herdr constrains each binary split to this range.
            ratio = min(0.9, max(0.1, first / (first + second)))
            if not math.isclose(node["ratio"], ratio, abs_tol=1e-6):
                updates.append((path, ratio))
            return first + second

        distribute(group, group_path)
    return updates


def export(socket_path, tab_id):
    return tree(request(socket_path, "layout.export", {"tab_id": tab_id})["layout"]["root"])


def apply(socket_path, tab_id, root, updates):
    expected = root
    for path, ratio in updates:
        # There is no atomic compare-and-set API. Stop rather than apply a stale
        # path if another client changes this layout while we are working.
        current = export(socket_path, tab_id)
        if current != expected:
            return current
        result = request(socket_path, "layout.set_split_ratio", {
            "tab_id": tab_id, "path": list(path), "ratio": ratio,
        })
        expected = tree(result["layout"]["root"])
    return expected


def snapshot(socket_path):
    tabs = request(socket_path, "session.snapshot")["snapshot"]["tabs"]
    roots = {}
    for tab in tabs:
        try:
            roots[tab["tab_id"]] = export(socket_path, tab["tab_id"])
        except ApiError as error:
            if error.code != "layout_not_found":
                raise
    return roots


def enabled(socket_path):
    plugins = request(socket_path, "plugin.list")["plugins"]
    return any(p["plugin_id"] == PLUGIN_ID and p["enabled"] for p in plugins)


def subscribe(socket_path):
    client = connect(socket_path)
    payload = {
        "id": "equal-tiles-events", "method": "events.subscribe",
        "params": {"subscriptions": [
            {"type": "layout.updated"}, {"type": "pane.created"},
            {"type": "tab.created"}, {"type": "tab.closed"},
        ]},
    }
    client.sendall(json.dumps(payload).encode() + b"\n")
    return client


def watch(socket_path, directory):
    inode = Path(socket_path).stat().st_ino
    with (directory / "watcher.lock").open("a") as lock:
        deadline = time.monotonic() + TIMEOUT
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                ready = read_ready(directory)
                if ready.get("inode") == inode or time.monotonic() >= deadline:
                    return
                time.sleep(0.1)
        ready_path = directory / "ready.json"
        ready_path.unlink(missing_ok=True)
        if not enabled(socket_path):
            return
        client = subscribe(socket_path)
        roots = None
        buffer = b""
        next_check = time.monotonic() + TIMEOUT
        try:
            while True:
                if time.monotonic() >= next_check:
                    if not enabled(socket_path):
                        return
                    next_check = time.monotonic() + TIMEOUT
                if not select.select([client], [], [], 1)[0]:
                    continue
                chunk = client.recv(65536)
                if not chunk:
                    return
                buffer += chunk
                dirty = set()
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    message = json.loads(line)
                    if "error" in message:
                        if message["error"]["code"] != "events_lost":
                            raise ApiError(message["error"])
                        client.close()
                        client = subscribe(socket_path)
                        roots = None
                        buffer = b""
                        dirty.clear()
                        break
                    if message.get("result", {}).get("type") == "subscription_started":
                        # Subscribe before bootstrap; queued events invalidate these
                        # reads instead of being replayed as authoritative snapshots.
                        roots = snapshot(socket_path)
                        ready_path.write_text(json.dumps({"pid": os.getpid(), "inode": inode}))
                        print(f"Watching {socket_path}", flush=True)
                    elif message.get("event") == "layout_updated":
                        dirty.add(message["data"]["layout"]["tab_id"])
                    elif message.get("event") == "pane_created" and roots is not None:
                        pane = message["data"]["pane"]
                        # Seed new tabs from their first pane, even if several
                        # splits happen before the first authoritative read.
                        roots.setdefault(pane["tab_id"], {
                            "type": "pane", "pane_id": pane["pane_id"],
                        })
                        dirty.add(pane["tab_id"])
                    elif message.get("event") == "tab_created" and roots is not None:
                        tab = message["data"]["tab"]
                        if tab["pane_count"] > 1:
                            # Declarative layout.apply creates all its panes at
                            # once. Keep those deliberately specified ratios.
                            try:
                                roots[tab["tab_id"]] = export(socket_path, tab["tab_id"])
                            except ApiError as error:
                                if error.code != "layout_not_found":
                                    raise
                    elif message.get("event") == "tab_closed" and roots is not None:
                        roots.pop(message["data"]["tab_id"], None)
                if roots is None:
                    continue
                for tab_id in dirty:
                    try:
                        root = export(socket_path, tab_id)
                        updates = ratio_updates(root, roots.get(tab_id))
                        roots[tab_id] = apply(socket_path, tab_id, root, updates)
                        if updates:
                            print(f"Redistributed {tab_id}: {len(updates)} split(s)", flush=True)
                    except ApiError as error:
                        if error.code != "layout_not_found":
                            raise
                        roots.pop(tab_id, None)
        finally:
            client.close()
            if read_ready(directory).get("pid") == os.getpid():
                ready_path.unlink(missing_ok=True)


def read_ready(directory):
    try:
        return json.loads((directory / "ready.json").read_text())
    except (OSError, ValueError):
        return {}


def start(socket_path, directory):
    # The startup hook exits; the plugin owns its subscriber and log. The worker
    # holds the session lock, exits when disabled or disconnected, and never
    # consumes Herdr's limited pool of in-flight plugin hook commands.
    with (directory / "watcher.log").open("a") as log:
        child = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "--watch"],
            stdin=subprocess.DEVNULL, stdout=log, stderr=log,
            start_new_session=True, close_fds=True,
        )
    deadline = time.monotonic() + TIMEOUT * 2
    inode = Path(socket_path).stat().st_ino
    while time.monotonic() < deadline:
        with (directory / "watcher.lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                active = False
            except BlockingIOError:
                active = read_ready(directory).get("inode") == inode
        if active:
            print(f"Automatic sibling tiling active: {socket_path}")
            return
        if child.poll() is not None:
            break
        time.sleep(0.1)
    raise RuntimeError(f"Subscriber did not start; see {directory / 'watcher.log'}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--start", action="store_true")
    mode.add_argument("--watch", action="store_true")
    mode.add_argument("--balance", action="store_true")
    args = parser.parse_args()
    if os.environ.get("HERDR_ENV") != "1":
        raise RuntimeError("Run this plugin from Herdr")
    socket_path = os.environ["HERDR_SOCKET_PATH"]
    key = hashlib.sha256(socket_path.encode()).hexdigest()[:16]
    directory = Path(os.environ["HERDR_PLUGIN_STATE_DIR"]) / key
    directory.mkdir(parents=True, exist_ok=True)
    if args.start:
        start(socket_path, directory)
    elif args.watch:
        watch(socket_path, directory)
    else:
        tab_id = os.environ["HERDR_TAB_ID"]
        root = export(socket_path, tab_id)
        updates = ratio_updates(root, force=True)
        apply(socket_path, tab_id, root, updates)
        print(f"Balanced {tab_id}: {len(updates)} split(s)")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        print(f"Equal Tiles: {error}", file=sys.stderr)
        raise SystemExit(1)
