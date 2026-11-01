#!/usr/bin/env python3
"""Reminds an agent of the comment rules when an edit adds a comment of more than QUIET_LINES lines.

Reads a PostToolUse hook payload on standard input and prints nothing for a shorter comment.
"""
import json
import sys

MARKERS = ("//", "/*", "*", "#", "<!--")

QUIET_LINES = 3

REMINDER = (
    f"This edit added a comment of more than {QUIET_LINES} lines. "
    "CODING_STANDARDS.md, 'Comments and docstrings': name the wrong belief the comment prevents. "
    "If a name can hold it, rename the thing and write nothing. A docstring states the contract "
    "in one to three sentences and opens on the verb for its kind of declaration."
)


def written(payload):
    tool_input = payload.get("tool_input") or {}
    return str(tool_input.get("new_string") or tool_input.get("content") or "")


def main():
    try:
        payload = json.load(sys.stdin)
    except (ValueError, OSError):
        return
    run = 0
    for line in written(payload).splitlines():
        run = run + 1 if line.strip().startswith(MARKERS) else 0
        if run > QUIET_LINES:
            output = {"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": REMINDER}}
            print(json.dumps(output))
            return


main()
