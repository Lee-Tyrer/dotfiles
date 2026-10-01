#!/usr/bin/env python3
"""Open a local OSC 8 file link in its default application."""

import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit


def fail(message: str) -> int:
    print(message, file=sys.stderr)
    return 1


def main() -> int:
    clicked_url = os.environ.get("HERDR_PLUGIN_CLICKED_URL", "")
    if not clicked_url:
        return fail("No clicked URL was provided by Herdr.")

    try:
        parsed = urlsplit(clicked_url)
    except ValueError as error:
        return fail(f"Invalid file URL: {error}")

    if parsed.scheme.lower() != "file" or parsed.netloc.lower() not in ("", "localhost"):
        return fail("Only local file URLs are accepted.")
    if parsed.query or parsed.fragment:
        return fail("File URLs with query strings or fragments are not accepted.")
    if not parsed.path.startswith("/"):
        return fail("File URLs must contain an absolute path.")

    try:
        target = Path(unquote(parsed.path, errors="strict")).resolve(strict=True)
    except (OSError, RuntimeError, UnicodeError, ValueError) as error:
        return fail(f"Could not resolve the clicked file: {error}")

    if not target.is_file() and not target.is_dir():
        return fail("The clicked path is not a regular file or directory.")

    if sys.argv[1:] == ["--check"]:
        print(f"Validated local file link: {target}")
        return 0
    if sys.argv[1:]:
        return fail("Unexpected arguments.")

    try:
        subprocess.Popen(
            ["xdg-open", str(target)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            close_fds=True,
        )
    except OSError as error:
        return fail(f"Could not launch the default application: {error}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
