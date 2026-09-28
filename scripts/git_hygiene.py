#!/usr/bin/env python3
"""Repo hygiene check — run at the start of every agent session (owner decision 2026-09-28).

Reports anything the owner might forget: old or abandoned worktrees, branches that
were never merged, unpushed commits on main, stashes, stray remote branches.
Read-only. It NEVER deletes anything — the agent tells the owner in plain words
and asks before cleaning up.

    python3 scripts/git_hygiene.py            # human report
    python3 scripts/git_hygiene.py --days 3   # "old" threshold (default 2 days)

Exit code is always 0; a clean repo prints a single line.
"""
import os, subprocess, sys, time

DAYS = 2
if "--days" in sys.argv:
    DAYS = float(sys.argv[sys.argv.index("--days") + 1])


def git(*args, cwd=None):
    r = subprocess.run(["git", *args], capture_output=True, text=True, cwd=cwd)
    return r.stdout.strip() if r.returncode == 0 else ""


def age_days(ts):
    return (time.time() - ts) / 86400 if ts else 0


root = git("rev-parse", "--show-toplevel")
if not root:
    print("git_hygiene: not inside a git repo"); sys.exit(0)
os.chdir(git("worktree", "list", "--porcelain").split("\n")[0].split(" ", 1)[1])  # main checkout
subprocess.run(["git", "fetch", "-q", "--prune", "origin"], capture_output=True)

findings = []

# 1. Main checkout: dirty files and ahead/behind.
branch = git("branch", "--show-current")
if branch != "main":
    findings.append(f"Main folder is on branch '{branch}', not main.")
dirty = [l for l in git("status", "--porcelain").splitlines() if l.strip()]
if dirty:
    findings.append(f"Main folder has {len(dirty)} uncommitted file(s) — work in progress should live in its own worktree.")
ahead = git("rev-list", "--count", "origin/main..main") or "0"
behind = git("rev-list", "--count", "main..origin/main") or "0"
if ahead != "0":
    findings.append(f"Local main has {ahead} commit(s) not on GitHub.")
if behind != "0" and not dirty:
    findings.append(f"Local main is {behind} commit(s) behind GitHub (safe to `git pull --ff-only`).")

# 2. Worktrees.
wt, cur = [], {}
for line in git("worktree", "list", "--porcelain").splitlines() + [""]:
    if not line:
        if cur: wt.append(cur); cur = {}
        continue
    k, _, v = line.partition(" ")
    cur[k] = v or True
for w in wt[1:]:
    path = w["worktree"]
    name = w.get("branch", "").replace("refs/heads/", "") or "(detached)"
    if not os.path.isdir(path):
        findings.append(f"Worktree {path} is registered but its folder is gone (`git worktree prune`)."); continue
    ts = int(git("log", "-1", "--format=%ct", cwd=path) or 0)
    gd = git("rev-parse", "--absolute-git-dir", cwd=path)
    idx = os.path.join(gd, "index") if gd else ""
    if idx and os.path.exists(idx):
        ts = max(ts, int(os.path.getmtime(idx)))  # moves whenever the agent stages or checks status
    d = age_days(ts)
    ch = len([l for l in git("status", "--porcelain", cwd=path).splitlines() if l.strip()])
    ahead_w = git("rev-list", "--count", "origin/main..HEAD", cwd=path) or "0"
    merged = ahead_w == "0"
    note = f"worktree '{name}' at {path}: last touched {d:.0f} day(s) ago"
    if ch: note += f", {ch} uncommitted file(s)"
    if merged and not ch: note += " — already merged, safe to remove"
    elif ahead_w != "0": note += f", {ahead_w} commit(s) not on main"
    if d >= DAYS or (merged and not ch and d >= 0.5):  # a just-created worktree is not 'finished'
        findings.append(note[0].upper() + note[1:] + ".")

# 3. Local branches other than main.
in_wt = {w.get("branch", "").replace("refs/heads/", "") for w in wt}
for b in git("for-each-ref", "--format=%(refname:short)", "refs/heads").splitlines():
    if b == "main" or b in in_wt:
        continue
    unmerged = sum(1 for l in git("cherry", "origin/main", b).splitlines() if l.startswith("+"))
    d = age_days(int(git("log", "-1", "--format=%ct", b) or 0))
    if unmerged == 0:
        findings.append(f"Branch '{b}' is fully merged into main — safe to delete.")
    elif d >= DAYS:
        findings.append(f"Branch '{b}' has {unmerged} commit(s) not on main and has been idle {d:.0f} day(s) — merge or delete?")

# 4. Remote branches other than main.
for r in git("for-each-ref", "--format=%(refname:lstrip=3)", "refs/remotes/origin").splitlines():
    if r in ("HEAD", "main"):
        continue
    d = age_days(int(git("log", "-1", "--format=%ct", f"origin/{r}") or 0))
    if d >= DAYS:
        findings.append(f"GitHub branch '{r}' idle {d:.0f} day(s) — merge or delete?")

# 5. Stashes and tags.
st = [l for l in git("stash", "list").splitlines() if l.strip()]
if st:
    findings.append(f"{len(st)} stash(es) sitting in git — stashes are easy to forget; apply or drop.")
tags = [t for t in git("tag").splitlines() if t.strip()]
if tags:
    findings.append(f"{len(tags)} git tag(s): {', '.join(tags[:5])}{'…' if len(tags) > 5 else ''}.")

if not findings:
    print("git_hygiene: clean — main matches GitHub, no stale worktrees, branches or stashes.")
else:
    print(f"git_hygiene: {len(findings)} thing(s) to look at:")
    for f in findings:
        print(f"  - {f}")
