#!/usr/bin/env python3
"""
Serialized, macOS/Linux-safe git commit for a repo shared by multiple agents.

Why this exists:
  - `flock(1)` is NOT installed on macOS (where commits run via Desktop Commander),
    so the old `flock /tmp/repo.gitlock ...` rule failed silently and broke
    serialization. fcntl.flock(2) is the same advisory lock and works on both
    macOS and Linux, so this wrapper is the ONE approved locking method.
  - A pure "wait-and-retry, never delete" rule deadlocks on a genuinely stale,
    orphaned .git/index.lock (0-byte, no process holding it). This wrapper waits
    on a LIVE git process but removes the lock once it confirms none is running.

Usage:
    python3 scripts/git_safe_commit.py "[ISSUE-123] short description"

Every agent MUST call this instead of running `git add` / `git commit` directly,
so all commits serialize through the same advisory lock (/tmp/repo.gitlock).
"""
import fcntl
import os
import subprocess
import sys
import time

LOCK_PATH = "/tmp/repo.gitlock"   # same path for every agent — this is what serializes them
INDEX_LOCK = ".git/index.lock"


def repo_root():
    """Resolve the repo top level so relative paths (.git/index.lock) and
    `git add -A` work no matter what cwd the caller had."""
    try:
        r = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, check=True,
        )
        return r.stdout.strip()
    except subprocess.CalledProcessError:
        sys.exit("error: not inside a git repository")


def git_process_running():
    # Matches only the actual `git` executable, not this Python wrapper.
    try:
        r = subprocess.run(["pgrep", "-x", "git"], capture_output=True, text=True)
        return bool(r.stdout.strip())
    except Exception:
        # If pgrep is unavailable, err on the safe side: assume something may be live.
        return True


def clear_stale_index_lock():
    # Called while we hold the advisory lock, so no cooperating agent is committing.
    for _ in range(5):
        if not os.path.exists(INDEX_LOCK):
            return
        if not git_process_running():
            try:
                os.remove(INDEX_LOCK)
                print("Removed stale .git/index.lock")
            except FileNotFoundError:
                pass
            return
        time.sleep(2)  # a real git op is live — wait, don't kill it


def main():
    if len(sys.argv) < 2 or not sys.argv[1].strip():
        sys.exit('usage: git_safe_commit.py "<commit message>"')
    msg = sys.argv[1]

    os.chdir(repo_root())

    with open(LOCK_PATH, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)   # blocks until our turn; no busy-retry loop needed
        clear_stale_index_lock()
        subprocess.run(["git", "add", "-A"], check=True)
        result = subprocess.run(["git", "commit", "-m", msg])
        if result.returncode != 0:
            # Non-zero is usually "nothing to commit" — not a lock failure.
            # Surface it, don't crash the lock.
            print(
                f"git commit exited {result.returncode} (likely nothing staged)",
                file=sys.stderr,
            )
    # advisory lock auto-released when the file handle closes


if __name__ == "__main__":
    main()
