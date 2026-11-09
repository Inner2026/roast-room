#!/usr/bin/env python3
"""Check that every quoted line a seat used in a session exists in that seat's brain.

Usage: python check_quotes.py sessions/<session>

A "quote" is any text in double quotes of 25+ characters inside a seat message.
It passes only if it appears in that seat's brains/<seat>/quotes.json.
Exit code 1 if any unverified quote is found.
"""
import json, re, sys, pathlib

root = pathlib.Path(__file__).resolve().parents[3]
brains = root / ".claude" / "skills" / "roast-room" / "brains"


def norm(s):
    return re.sub(r"\s+", " ", s.lower()).strip()


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    f = pathlib.Path(sys.argv[1])
    if f.is_dir():
        f = f / "session.json"
    events = json.loads(f.read_text())
    bad = 0
    checked = 0
    for e in events:
        if e.get("type") != "message":
            continue
        seat = e.get("seat", "")
        qf = brains / seat / "quotes.json"
        known = []
        if qf.exists():
            known = [norm(q.get("text", "")) for q in json.loads(qf.read_text()).get("quotes", [])]
        for q in re.findall(r"[\"“]([^\"”]{25,})[\"”]", e.get("text", "")):
            checked += 1
            if not any(norm(q) in k or k in norm(q) for k in known if k):
                bad += 1
                print(f"UNVERIFIED [{seat}]: {q}")
    print(f"{checked} quote(s) checked, {bad} unverified")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
