#!/usr/bin/env python3
"""
Ownership-gated git push for a repo shared by multiple agents.

WHAT THIS CAN AND CANNOT DO — read this first
---------------------------------------------
Git pushes a BRANCH, not a set of commits. If another agent's unpushed commit sits
BELOW yours on main, it is an ANCESTOR of yours: there is no way to push your commit
without pushing theirs. No tool can change that — it is how git works.

So this wrapper does NOT surgically extract your commits. It does the only correct
thing available: it REFUSES to push when someone else's unpushed work would ride
along, instead of silently sweeping it to origin. You then coordinate (let them push
their own work first) rather than pushing on their behalf by accident.

This is the push-side twin of git_safe_commit.py's pathspec rule:
  - git_safe_commit.py  → your COMMIT contains only your files.
  - git_safe_push.py    → your PUSH contains only your commits.

Real incident this exists to prevent (2026-07-14): an agent finished
[AVADIAL-GROUPS-1] and pushed main. Two unrelated commits from another agent
([AVA-AUTH-401], [AVA-AUTH-OTP]) were sitting unpushed underneath and were carried
to origin as ancestors — nobody decided to publish them; they just went.

HOW OWNERSHIP IS DECIDED
------------------------
Every agent in this repo commits as the same git user ("davy"), so the author field
cannot tell agents apart. The discriminator is the CLAUDE.md rule that every commit
subject starts with its issue id:

    [ISSUE-123] short description

You declare the issue ids you own; every unpushed commit must carry one of them.
A commit with no [ISSUE] prefix is unattributable and therefore also blocked.

USAGE
-----
    # Push main, asserting you own exactly these issues:
    python3 scripts/git_safe_push.py AVA-AUTH-401 AVA-AUTH-OTP

    # See what would happen, touch nothing:
    python3 scripts/git_safe_push.py AVA-AUTH-401 --dry-run

    # Owner-only deliberate merge push (publishes other agents' commits too):
    python3 scripts/git_safe_push.py --allow-foreign

Options:
    --dry-run         Report the decision and exit; never pushes.
    --allow-foreign   Permit foreign/unattributed commits to ride along. This is the
                      OWNER's deliberate merge push, not an agent escape hatch.
    --remote <name>   Default: origin
    --branch <name>   Default: current branch

Exit codes: 0 ok / nothing to push, 1 blocked or error.

This wrapper sets ALLOW_PUSH=1 for the underlying `git push`, because it IS the
sanctioned deliberate push path that the pre-push hook's guard asks for. Never call
`git push` directly, and never use --no-verify or --force on a shared branch.
"""
import fcntl
import os
import re
import subprocess
import sys

LOCK_PATH = "/tmp/repo.gitlock"  # same lock as git_safe_commit.py — serializes both
ISSUE_RE = re.compile(r"^\s*\[([A-Za-z0-9][A-Za-z0-9._-]*)\]")
# An ACTIVE push trigger: a `push:` key that is NOT commented out. Builds in this repo
# are workflow_dispatch-only by owner decision (2026-07-04) and a push must never start
# one. If someone re-adds a push trigger, pushing would silently ship a build.
ACTIVE_PUSH_TRIGGER_RE = re.compile(r"^\s{0,4}push:\s*$")


def run(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, **kw)


def die(msg):
    sys.exit(f"error: {msg}")


def repo_root():
    r = run(["git", "rev-parse", "--show-toplevel"])
    if r.returncode != 0:
        die("not inside a git repository")
    return r.stdout.strip()


def current_branch():
    r = run(["git", "rev-parse", "--abbrev-ref", "HEAD"])
    if r.returncode != 0 or not r.stdout.strip() or r.stdout.strip() == "HEAD":
        die("could not resolve current branch (detached HEAD?)")
    return r.stdout.strip()


def issue_of(subject):
    m = ISSUE_RE.match(subject)
    return m.group(1).upper() if m else None


def active_push_triggers():
    """Workflows whose `push:` trigger is live. Empty list is the expected state."""
    hits = []
    wf_dir = os.path.join(".github", "workflows")
    if not os.path.isdir(wf_dir):
        return hits
    for name in sorted(os.listdir(wf_dir)):
        if not name.endswith((".yml", ".yaml")):
            continue
        path = os.path.join(wf_dir, name)
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                in_on = False
                for line in fh:
                    stripped = line.rstrip("\n")
                    if re.match(r"^on:\s*$", stripped):
                        in_on = True
                        continue
                    # Leaving the `on:` block: a new top-level key.
                    if in_on and re.match(r"^[A-Za-z_]", stripped):
                        in_on = False
                    if in_on and ACTIVE_PUSH_TRIGGER_RE.match(stripped):
                        hits.append(name)
                        break
        except OSError:
            continue
    return hits


def main():
    argv = sys.argv[1:]
    dry_run = "--dry-run" in argv
    allow_foreign = "--allow-foreign" in argv

    for bad in ("--force", "-f", "--force-with-lease", "--no-verify"):
        if bad in argv:
            die(f"{bad} is not permitted — never force-push or skip hooks on a shared branch")

    remote, branch = "origin", None
    rest = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--dry-run", "--allow-foreign"):
            i += 1
        elif a == "--remote":
            remote = argv[i + 1] if i + 1 < len(argv) else die("--remote needs a value")
            i += 2
        elif a == "--branch":
            branch = argv[i + 1] if i + 1 < len(argv) else die("--branch needs a value")
            i += 2
        elif a.startswith("-"):
            die(f"unknown option {a}")
        else:
            rest.append(a)
            i += 1

    owned = {x.strip().upper() for x in rest if x.strip()}
    if not owned and not allow_foreign:
        sys.exit(
            "usage: git_safe_push.py ISSUE-ID [ISSUE-ID ...] [--dry-run] [--remote origin] [--branch main]\n"
            "       Declare the issue id(s) you own, e.g. AVA-AUTH-401.\n"
            "       (Owner-only deliberate merge push: --allow-foreign)"
        )

    os.chdir(repo_root())
    branch = branch or current_branch()

    # Serialize against concurrent git_safe_commit.py runs so we can't read a
    # half-written history or race another agent's commit into our push window.
    with open(LOCK_PATH, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)

        # A build must never be started by a push (owner decision 2026-07-04).
        triggers = active_push_triggers()
        if triggers:
            sys.exit(
                "BLOCKED: these workflows have an ACTIVE `push:` trigger, so pushing "
                "would start a build:\n  - " + "\n  - ".join(triggers) +
                "\n\nBuilds are workflow_dispatch-only. Re-comment the push: trigger, or get "
                "the owner's explicit say-so before pushing."
            )

        if run(["git", "fetch", remote, branch]).returncode != 0:
            die(f"git fetch {remote} {branch} failed")

        rng = f"{remote}/{branch}..{branch}"
        r = run(["git", "log", "--reverse", "--format=%H\x1f%s", rng])
        if r.returncode != 0:
            die(f"could not read {rng} (does {remote}/{branch} exist?)")

        commits = []
        for line in r.stdout.splitlines():
            if not line.strip():
                continue
            sha, _, subject = line.partition("\x1f")
            commits.append((sha, subject))

        if not commits:
            print(f"Nothing to push — {branch} matches {remote}/{branch}.")
            return

        mine, foreign = [], []
        for sha, subject in commits:
            iss = issue_of(subject)
            (mine if (iss and iss in owned) else foreign).append((sha, subject, iss))

        print(f"{len(commits)} unpushed commit(s) on {branch}:")
        for sha, subject, iss in [(s, sub, issue_of(sub)) for s, sub in commits]:
            tag = "yours" if (iss and iss in owned) else ("UNATTRIBUTED" if not iss else f"OWNED BY {iss}")
            print(f"  {sha[:9]}  [{tag}]  {subject[:72]}")

        if foreign and not allow_foreign:
            print()
            print("BLOCKED: pushing would also publish work that isn't yours.")
            print("Git pushes a branch, so these commits go too — they are ancestors of yours:")
            for sha, subject, iss in foreign:
                why = "no [ISSUE] prefix — cannot attribute" if not iss else f"belongs to {iss}"
                print(f"  {sha[:9]}  {subject[:66]}   ({why})")
            print()
            print("What to do:")
            print("  1. Let the agent who owns those commits push their own work first, then re-run this.")
            print("  2. If they are yours too, name them:  python3 scripts/git_safe_push.py "
                  + " ".join(sorted(owned | {i for _, _, i in foreign if i})))
            print("  3. Owner only, deliberate merge push:  python3 scripts/git_safe_push.py --allow-foreign")
            sys.exit(1)

        if allow_foreign and foreign:
            print("\n--allow-foreign: publishing other agents' commits too (owner merge push).")

        if dry_run:
            print(f"\n--dry-run: would push {len(commits)} commit(s) to {remote}/{branch}. Nothing done.")
            return

        env = dict(os.environ, ALLOW_PUSH="1")  # this wrapper is the sanctioned deliberate path
        print(f"\nPushing {branch} -> {remote}/{branch} ...")
        res = subprocess.run(["git", "push", remote, branch], env=env)
        if res.returncode != 0:
            sys.exit(
                f"\ngit push exited {res.returncode}. If {remote}/{branch} moved ahead, run "
                f"`git fetch {remote} && git rebase {remote}/{branch}` and re-run this script. "
                f"Never force-push a shared branch."
            )
        print(f"Pushed. No build was triggered (workflows are workflow_dispatch-only).")


if __name__ == "__main__":
    main()
