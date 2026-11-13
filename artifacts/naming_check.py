"""Cross-check the intake naming rules.

The C# implementation lives in src/BroadcastIntake/DropNaming.cs. .NET named groups (?<name>...)
are transcribed to Python's (?P<name>...) form so the separator/revision/role rules can be
exercised without a .NET toolchain. If the C# patterns change, update them here too.
"""
import os
import re
import sys

SEP = r"[_\-.]+"
ROLE = r"[A-Za-z0-9一-鿿][A-Za-z0-9一-鿿\-]*"
REV_PREFIX = r"(?:(?:R|V|REV|VER|REVISION)\s*)?"

ROLE_TOKENS = {
    "mix": "mix", "mixdown": "mix", "audio": "mix", "aud": "mix", "mx": "mix", "main": "mix",
    "混音": "mix", "主混": "mix",
    "sub": "subtitle", "subs": "subtitle", "subtitle": "subtitle", "subtitles": "subtitle",
    "caption": "subtitle", "captions": "subtitle", "cc": "subtitle", "text": "subtitle",
    "字幕": "subtitle", "srt": "subtitle", "vtt": "subtitle",
    "manifest": "manifest", "productionlist": "manifest", "production": "manifest",
    "meta": "manifest", "metadata": "manifest", "list": "manifest", "info": "manifest",
    "清单": "manifest", "制作清单": "manifest",
}

EXT_TOKENS = {
    "wav": "mix", "wave": "mix", "flac": "mix", "aiff": "mix", "aif": "mix", "mp3": "mix",
    "m4a": "mix", "w64": "mix",
    "srt": "subtitle", "vtt": "subtitle", "ass": "subtitle", "ssa": "subtitle",
    "json": "manifest", "yaml": "manifest", "yml": "manifest", "txt": "manifest",
    "csv": "manifest", "md": "manifest", "xml": "manifest",
}

revision_token = re.compile(r"^(?:R|V|REV|VER|版本|修订)\s*0*(\d+)$", re.I)
revision_number = re.compile(r"^0*(\d+)$")

with_role = re.compile(
    rf"^\s*(?P<prog>[A-Za-z0-9][A-Za-z0-9_\-.]*?)\s*{SEP}\s*{REV_PREFIX}(?P<rev>\d+)\s*{SEP}\s*(?P<role>{ROLE})\s*$",
    re.I,
)
glued_role = re.compile(
    rf"^\s*(?P<prog>[A-Za-z0-9][A-Za-z0-9_\-.]*?)\s*(?:R|V|REV|VER|REVISION)\s*(?P<rev>\d+)\s*{SEP}\s*(?P<role>{ROLE})\s*$",
    re.I,
)
extension_only = re.compile(
    rf"^\s*(?P<prog>[A-Za-z0-9][A-Za-z0-9_\-.]*?)\s*{SEP}\s*{REV_PREFIX}(?P<rev>\d+)\s*$",
    re.I,
)
glued_only = re.compile(
    r"^\s*(?P<prog>[A-Za-z0-9][A-Za-z0-9_\-.]*?)\s*(?:R|V|REV|VER|REVISION)\s*(?P<rev>\d+)\s*$",
    re.I,
)


def clean(value):
    value = value.strip().strip("_-.")
    return value or None


def normalize_revision(token):
    match = revision_token.match(token) or revision_number.match(token)
    if not match:
        return None
    return "R%d" % int(match.group(1))


def parse(file_name):
    stem, ext = os.path.splitext(file_name)
    if not stem.strip():
        return None

    match = with_role.match(stem)
    if match:
        role = ROLE_TOKENS.get(match.group("role").lower())
        programme = clean(match.group("prog"))
        if role and programme:
            return programme, normalize_revision(match.group("rev")), role

    match = glued_role.match(stem)
    if match:
        role = ROLE_TOKENS.get(match.group("role").lower())
        programme = clean(match.group("prog"))
        if role and programme:
            return programme, normalize_revision(match.group("rev")), role

    extension_role = EXT_TOKENS.get(ext.lstrip(".").lower())
    if extension_role:
        for candidate in (extension_only, glued_only):
            match = candidate.match(stem)
            if match:
                programme = clean(match.group("prog"))
                if programme:
                    return programme, normalize_revision(match.group("rev")), extension_role

    return None


CASES = [
    ("P12345_R2_mix.wav", ("P12345", "R2", "mix")),
    ("SHOW-1_R1.srt", ("SHOW-1", "R1", "subtitle")),
    ("P12345R2_mix.wav", ("P12345", "R2", "mix")),
    ("P12345-R2-subtitle.srt", ("P12345", "R2", "subtitle")),
    ("P12345.V2.manifest.json", ("P12345", "R2", "manifest")),
    ("P1_R2.wav", ("P1", "R2", "mix")),
    ("P7_REV03_manifest.txt", ("P7", "R3", "manifest")),
    ("节目A_修订2_字幕.srt", ("节目A", "R2", "subtitle")),
    ("notes.txt", None),
    ("README.md", None),
    ("P1_R2_unknownfile.bin", None),
]


def main():
    failures = 0
    for name, expected in CASES:
        actual = parse(name)
        if expected is None:
            ok = actual is None
        else:
            ok = actual is not None and actual == expected
        print(("ok   " if ok else "FAIL ") + f"{name}: {actual}")
        failures += 0 if ok else 1

    print(f"\n{len(CASES) - failures}/{len(CASES)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
