# greasedesk-core
Core GreaseDesk SaaS application — multi-tenant garage management system for bookings, job cards, pricing, and customer communication.
Build By Hugh Gunn
5 November 2025

## Setup

After cloning, enable the secret-scanning pre-commit hook. **This is a one-time local step and it is
not automatic** — `core.hooksPath` is per-clone git config, so it cannot be committed and no amount
of repo configuration will set it for you:

```sh
brew install gitleaks          # or: https://github.com/gitleaks/gitleaks#installing
git config core.hooksPath .githooks
```

Verify it took — this must be refused. The fake key is generated at runtime rather than written
here, because a literal one in this file would (correctly) trip the scanner on the README itself:

```sh
printf 'export const FAKE = "re_%s";\n' "$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)" > leaktest.ts
git add leaktest.ts && git commit -m "should be blocked"   # expect: COMMIT BLOCKED
git reset HEAD leaktest.ts && rm leaktest.ts               # clean up
```

The hook **fails closed**: if `gitleaks` is not installed it refuses the commit rather than passing
silently, because on a public repo "scanner missing" must not look like "no secrets found". A real
false positive can be bypassed with `git commit --no-verify`.

This repo is public and has leaked live credentials before — a `.env` and an `env_file.txt` were
committed in November 2025 (see `.gitleaksignore` for the disclosed, fingerprint-suppressed
incidents). Secrets belong in `.env` (git-ignored) locally and in Vercel's environment settings for
deployed environments; never in a tracked file.

`.github/workflows/gitleaks.yml` runs the same scan over full history on every push and PR. That is
the enforcing layer — the local hook is a fast convenience that any contributor can skip.