---
title: "PR Workflow"
description: "Commit guidelines, PR review process, and merge flow"
---

# PR Workflow

## Commit Guidelines

### Using the Committer Script

```bash
scripts/committer "<msg>" <file...>
```

- Avoid manual `git add`/`git commit` so staging stays scoped
- Follow concise, action-oriented messages
- Example: `CLI: add verbose flag to send`

### Grouping Changes

- Group related changes together
- Avoid bundling unrelated refactors

### Changelog Workflow

- Keep latest released version at top (no `Unreleased` section)
- After publishing, bump version and start a new top section
- When working on a PR: add changelog entry with PR number and thank the contributor
- When working on an issue: reference the issue in the changelog entry

## PR Review vs Landing

### Review Mode (PR link only)

- Read via `gh pr view` / `gh pr diff`
- **Do NOT** switch branches
- **Do NOT** change code

### Pre-Review Checklist

Before starting a review when a GH Issue/PR is pasted:
1. Run `git pull`
2. If there are local changes or unpushed commits, **stop and alert the user**

### PR Review Calls

- Prefer a single `gh pr view --json ...` to batch metadata/comments
- Run `gh pr diff` only when needed

## Landing Mode (Merge Flow)

### Standard Flow

1. Create temp branch from `main`
2. Merge PR branch into it:
   - **Prefer rebase** for linear history
   - **Merge allowed** when complexity/conflicts make it safer
   - If squashing, add PR author as co-contributor
3. Apply fixes
4. Add changelog entry (include PR # + thanks)
5. Run full gate **locally before committing**:
   ```bash
   pnpm build && pnpm check && pnpm test
   ```
6. Commit
7. Merge back to `main`
8. Delete temp branch
9. End on `main` (never stay on topic branch)

**Important**: Contributor needs to be in git graph after landing!

### Post-Merge Actions

1. Leave a PR comment explaining what was done, include SHA hashes
2. For new contributors: add their avatar to README "Thanks to all clawtributors" list
3. Run if contributor missing:
   ```bash
   bun scripts/update-clawtributors.ts
   ```
4. Commit the regenerated README

## PR Content Guidelines

PRs should:
- Summarize scope
- Note testing performed
- Mention any user-facing changes or new flags

## Goal

**Merge PRs.** Always try to merge unless it's truly difficult.

- Prefer **rebase** when commits are clean
- Prefer **squash** when history is messy
