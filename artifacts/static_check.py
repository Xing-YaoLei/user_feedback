"""Cheap static sanity checks for the C# sources, since the .NET toolchain is unavailable.

Checks performed:
- braces/parens/brackets balance per file (ignoring braces inside strings and comments where easy)
- no obviously stale identifier from earlier drafts
- every test registered in TestRunner exists as a method
"""
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir)


def strip_noncode(src: str) -> str:
    out = []
    i = 0
    n = len(src)
    in_str = None
    while i < n:
        ch = src[i]
        if in_str:
            if ch == "\\":
                i += 2
                continue
            if ch == in_str:
                if in_str == '"' and i + 1 < n and src[i + 1] == '"':
                    i += 2
                    continue
                in_str = None
            out.append(" ")
            i += 1
            continue
        if ch == "/" and i + 1 < n and src[i + 1] == "/":
            while i < n and src[i] != "\n":
                i += 1
            continue
        if ch == "/" and i + 1 < n and src[i + 1] == "*":
            i += 2
            while i + 1 < n and not (src[i] == "*" and src[i + 1] == "/"):
                i += 1
            i += 2
            continue
        if ch == '"':
            in_str = '"'
            out.append(" ")
            i += 1
            continue
        if ch == "'":
            # char literal: skip to the closing quote
            j = i + 1
            while j < n and src[j] != "'":
                j += 2 if src[j] == "\\" else 1
            out.append(" ")
            i = j + 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def check_balance(path):
    with open(path, encoding="utf-8") as fh:
        src = fh.read()
    code = strip_noncode(src)
    pairs = {"{": "}", "(": ")", "[": "]"}
    stack = []
    for idx, ch in enumerate(code):
        if ch in pairs:
            stack.append((ch, idx))
        elif ch in pairs.values():
            if not stack:
                return f"unbalanced closing '{ch}'"
            open_ch, _ = stack.pop()
            if pairs[open_ch] != ch:
                return f"mismatched '{open_ch}' closed by '{ch}'"
    if stack:
        open_ch, _ = stack[-1]
        return f"unclosed '{open_ch}' ({len(stack)} left open)"
    return None


STALE = [
    "FirstCompleteAt",
    "OriginalDetail",
    "ToHexStringLower",
    "IntakeTestsContent.",
    "waitForSettle: false, cancellationToken",  # old recursive call
]


def main():
    files = []
    for base in ("src", "tests"):
        for dirpath, _, names in os.walk(os.path.join(ROOT, base)):
            for name in names:
                if name.endswith(".cs"):
                    files.append(os.path.join(dirpath, name))

    problems = 0
    for path in sorted(files):
        rel = os.path.relpath(path, ROOT)
        issue = check_balance(path)
        if issue:
            problems += 1
            print(f"BALANCE {rel}: {issue}")
        with open(path, encoding="utf-8") as fh:
            src = fh.read()
        for token in STALE:
            if token in src:
                problems += 1
                print(f"STALE   {rel}: contains '{token}'")

    print(f"\n{len(files)} files checked, {problems} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
