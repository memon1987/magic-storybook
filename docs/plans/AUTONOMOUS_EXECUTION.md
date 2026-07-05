# Autonomous Execution Protocol

How to execute a plan file in this repo **autonomously** — from a clean checkout to a
review-clean PR — with no human input until the **ready-to-merge gate**. Every plan in
`docs/plans/` that contains an `## Execution contract` section is written against this
protocol. Written so a capable-but-literal executor (Claude Fable or Opus-class) can follow
it without judgment calls beyond what the plan pre-decides.

**Audience note for the executing model:** the plan you were handed pre-makes every design
decision. If you hit something the plan genuinely does not decide, do NOT improvise a design —
record the question in the PR description under "Deferred decisions," pick the most
conservative option that keeps the diff small, and continue. Never expand scope beyond the
plan's Critical files list without recording why.

---

## 1. Setup — isolation first

Two FC-number collisions and one shared-checkout accident have already happened in this repo
(see FC-023, FC-035, and the FC-029 provenance note). Therefore:

1. `git fetch origin` and verify from **fresh `origin/main`**:
   - The FC number you're executing still matches the plan (grep `docs/FUTURE_CONSIDERATIONS.md`).
   - No remote branch or open PR already claims this FC (`git branch -r | grep fc-NNN`, `gh pr list`).
2. Create an **isolated worktree** — never work in a checkout another session may share, and
   never switch branches in a shared checkout:
   ```bash
   git worktree add ../wt-fc-NNN -b feature/fc-NNN-<slug> origin/main
   cd ../wt-fc-NNN
   ```
   (Branch name comes from the plan's Execution contract.)
3. Install deps in the worktree as needed (`cd mobile && npm ci`, `cd backend && npm ci`).
   Use **npm 10 semantics** for any lockfile change (the EAS builder runs npm 10 — see the
   FC-029 lockfile incident): if you must touch `package-lock.json`, regenerate it with npm 10.

## 2. Goal loop — iterate until the contract is green

Each plan's Execution contract defines **Definition of done (machine-checkable)** — a list of
commands that must pass — plus behavioral assertions. Loop:

```
implement → run the contract's validation commands → read failures → fix → repeat
```

- Validation commands are run directly (`tsc`, `vitest`, `jest`, `expo lint`) — never
  delegated to a subagent.
- Write the tests the plan specifies **before or alongside** the implementation they cover,
  and make sure each test fails without the change (or document why it can't).
- Do not weaken a test, threshold, or lint rule to get green. If a contract item appears
  wrong, record it in the PR description and leave the item visibly unmet — don't fake it.
- Keep commits small and messages conventional (`feat(reader): …`, `fix(backend): …`), each
  ending with the standard `Co-Authored-By` line and referencing `Plan: docs/plans/fc-NNN.md`.

**Manual/deferred checks** (on-device verification, TestFlight behavior) are listed separately
in each contract. They are NOT yours to perform — copy them verbatim into the PR description
as a "Post-merge / on-device checklist" for the owner.

## 3. Open the PR

When the machine-checkable contract is fully green:

1. Push the branch; open a PR against `main` titled `FC-NNN: <plan title>`.
2. PR body must include: `Plan: docs/plans/fc-NNN.md`, a summary of what changed and why,
   the on-device checklist, any Deferred decisions, and the standard generated-with footer.
3. Update bookkeeping **in the same branch**: plan file `**Status:** Draft → Executing` and
   an `## Execution` section (PR URL, commits, date, deviations); FC index entry status →
   `Executing`. One PR per FC — never bundle.

## 4. Review gate — two independent adversarial reviews + confirmation

Per CLAUDE.md, upgraded by owner directive (2026-07-05): **every FC executed under this
protocol gets TWO adversarial reviews**, then a confirmation pass. This entire gate runs
autonomously; only the final merge is human.

1. Spawn **two reviewer agents in fresh contexts, independently — neither sees the other's
   findings, and neither may switch branches in a shared checkout** (give them the PR diff
   via `git diff origin/main...HEAD` from the worktree, or `gh pr diff`).
2. Personas come from the plan's Execution contract (two *different* domain-specific senior
   personas). Use the standard review-prompt template from the global CLAUDE.md ("Workflow"
   §2) verbatim: required output CONFIRMED-GOOD / BUGS+RISKS with severity / PLAN CRITIQUE /
   VERDICT. Do **not** pre-state what you validated — reviewers verify claims themselves.
3. Consolidate both verdicts. Every BLOCKER/HIGH (and any finding either reviewer marks
   required) must be (a) fixed in code, (b) rebutted in writing in the PR description, or
   (c) deferred to a new FC entry you add to `docs/FUTURE_CONSIDERATIONS.md`. Silent
   disagreement is not allowed.
4. If any fix landed in code, run the **scoped confirmation review** (same persona as the
   reviewer whose finding it was; contract = the consolidated required-fix list; output
   CONFIRMED / STILL BROKEN / NEW REGRESSIONS / VERDICT). CONFIRMED-CLEAN is required.
   STILL-BROKEN or NEW-REGRESSIONS loops back to step 3.
5. Post the review outcome (both verdicts + confirmation) as a PR comment for the paper trail.

## 5. Ready-to-merge gate — STOP

The autonomous run ends when: contract green + PR open + both reviews resolved +
confirmation CONFIRMED-CLEAN (or no code fixes were needed). Report a summary (what shipped,
review findings and how each was resolved, what's on the on-device checklist) and **stop**.

**Never do autonomously, under any circumstances:**
- Merge the PR, or approve it on the author's behalf.
- Deploy (`gcloud run deploy`, `firebase deploy`), trigger EAS builds, or submit to TestFlight.
- Write to production Firestore/GCS or rotate secrets.
- Spend against paid APIs beyond a plan's explicit cost cap (default cap if unstated: $0 —
  i.e., no real generation calls; use mocks/fixtures).
- Delete or force-push anything outside your own feature branch/worktree.

## 6. Parallel execution — conflict matrix

Multiple plans may execute concurrently, **each in its own worktree + branch** (§1). But two
FCs touching the same file will collide at merge. Current matrix (Tier 1 + Tier 2 plans):

| FC | Primary files touched | Conflicts with | Safe alongside |
|----|----------------------|----------------|----------------|
| FC-040 reader tap-to-turn | `mobile/components/PageCurl/Curl.tsx`, `mobile/app/story/[id]/read.tsx` | — | all others |
| FC-038 cover clipping | `mobile/components/StoryCard.tsx` | FC-039 | all others |
| FC-036 loading screen | `mobile/app/story/[id]/generating.tsx` | — | all others |
| FC-037 content safety | `backend/src/services/gemini.ts`, `backend/src/routes/stories.ts`, `backend/src/services/worker.ts`, `mobile/app/(tabs)/create.tsx` (+ new validation module) | FC-028 (gemini.ts), FC-027 (create.tsx) | FC-040, FC-038, FC-036, FC-024, FC-039 |
| FC-024 mobile test runner + CI | `mobile/package.json`, jest config, `.github/workflows/` (new), test files (new) | package-lock with any FC adding a mobile dep (FC-039 if haptics added) | everything at the source level; merge FC-024 first when possible |
| FC-039 library edit mode | `mobile/app/(tabs)/index.tsx`, `mobile/components/StoryCard.tsx` | FC-038 | FC-040, FC-036, FC-037, FC-028, FC-027 |
| FC-028 aspect-ratio pin | `backend/src/services/gemini.ts` | FC-037 | all mobile FCs |
| FC-027 iPad polish | `mobile/app/(auth)/*.tsx`, `mobile/app/(tabs)/create.tsx`, `settings.tsx`, `hooks/useResponsive` | FC-037 (create.tsx) | FC-040, FC-038, FC-036, FC-024, FC-039, FC-028 |

**Recommended waves:**
- **Wave A (fully parallel):** FC-024, FC-040, FC-038, FC-036, FC-037
- **Wave B (after the conflicting Wave-A PR merges, rebased on updated main):** FC-039
  (after FC-038), FC-028 (after FC-037), FC-027 (after FC-037)

The second executor of a conflicting pair rebases on the merged result — never merge two PRs
that both edited the same file without one rebasing on the other first.

## 7. Bookkeeping after the human merges

(Usually a later session.) Plan `**Status:** → Done`, Execution section gets the merge SHA;
FC entry moves to Completed with PR link. Mobile changes reach users only via the next EAS
build — note it.
