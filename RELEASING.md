# Releasing PsyClinicalMind

All work merges into `main`. Only **tags** are released and deployed.

## Branch vs tag

| | `main` (branch) | `vX.Y.Z` (tag) |
|---|---|---|
| Moves? | Yes: every merge moves it forward | Never: fixed on one commit forever |
| Meaning | Latest integrated code, CI green, not necessarily released | Exactly the code that was tested together and released |
| Who changes it | PRs, merged through the merge queue (batches) | The release step below, after the user's OK |
| Deployed? | **Never directly** | **Yes, the only thing that is deployed** |

```
PR → main     PR → main     PR → main
                              │
               tested together, user OK → tag v0.6.0 → deploy v0.6.0
```

Why:
- Unreleased work can sit on `main` without reaching clinics.
- Rollback means redeploying the previous tag.
- "What is live?" has a name, not a hash.
- `git diff v0.5.0 v0.6.0` lists what a release changes.

## Version numbers: `vMAJOR.MINOR.PATCH`

- **0.x.y:** before the first launch with live clinics. `v0.5.0` = development complete, tested locally (2026-11-08).
- **MINOR** (`0.5.0 → 0.6.0`): a set of features or changes.
- **PATCH** (`0.6.0 → 0.6.1`): fixes only, to an already released version.
- **MAJOR** (`1.0.0`): the first public launch; later, breaking changes.

## The four repos are tagged together

A release tags the **same version** in all four repos:
- the monorepo at the commit on `main`;
- backend, frontend and deidentification-service each at the commit their `main` has with the **same code** as the monorepo's submodule pointer. That is the merge commit on `main` when its tree equals the pinned commit (check with `git diff --stat <pinned> origin/main`, which must be empty), otherwise the pinned commit itself.

## Release steps

1. **Everything for the release is merged** into `main` in every repo, through the merge queue.
2. **CI is green** on the monorepo's `main`: `e2e.yml` passed on that exact commit.
3. **Tested by hand**, locally:
   ```bash
   git switch main && git pull && git submodule update --init
   ./scripts/dev-up.sh            # PREVIEW=1 for the production build (PWA install on a phone)
   ```
   The user signs off.
4. **Security audit:** `pip-audit` on backend `requirements.txt` and `requirements-dev.txt` shows nothing new; `npm audit --audit-level=high` on frontend and e2e shows 0 high. Accepted risks are listed in `SECURITY.md`.
5. **Tag**, with annotated tags only and the same message everywhere:
   ```bash
   V=v0.6.0; MSG="$V: <one line: what this release is>"
   git fetch origin --tags && git -C backend fetch origin --tags && git -C frontend fetch origin --tags && git -C deidentification-service fetch origin --tags
   git tag -a $V <mono commit> -m "$MSG"                         && git push origin refs/tags/$V
   git -C backend tag -a $V <be commit> -m "$MSG"                && git -C backend push origin refs/tags/$V
   git -C frontend tag -a $V <fe commit> -m "$MSG"               && git -C frontend push origin refs/tags/$V
   git -C deidentification-service tag -a $V <deid commit> -m "$MSG" && git -C deidentification-service push origin refs/tags/$V
   ```
6. **Record** the version, date and the four commits in the table below.

## Rules

- **Never move, delete or re-push a tag.** If a tagged release is wrong, fix it on `main` and release the next PATCH.
- **Never deploy `main`** or an untagged commit. Once a deployment pipeline exists, it deploys only on a pushed `v*` tag.
- **Never commit while a tag is checked out.** `git checkout vX.Y.Z` leaves you in "detached HEAD", which is for looking and running only. `git switch main` to work again.
- **A tag needs the user's explicit OK.** Claude sessions propose a release; they don't tag on their own.
- **An urgent fix while `main` holds unreleased work:**
  1. `git switch -c hotfix/vX.Y.Z+1 vX.Y.Z` in each repo that needs the fix;
  2. a PR with the fix into that hotfix branch, tested;
  3. tag `vX.Y.(Z+1)` on it;
  4. merge the same fix into `main` with a normal PR, so it isn't lost.

## Going back to a release

```bash
git checkout v0.5.0 && git submodule update     # look at or run exactly that version
git switch main && git submodule update         # back to the latest code
git diff v0.5.0 main                            # what has changed since
```

## Releases

| Version | Date | Meaning | monorepo | backend | frontend | deidentification |
|---|---|---|---|---|---|---|
| v0.5.0 | 2026-11-08 | Development complete (MVP, tested locally; not deployed) | `e203d05` | `6721688` | `eea7ebc` | `0f6f91b` |
