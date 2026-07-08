# Execution Plans

Published plans for changes to this codebase. **No medium or large change should land without a plan file here** — see `CLAUDE.md` ("Plan-First Development") for the rule.

## How plans flow in

1. An idea starts as an entry in `docs/FUTURE_CONSIDERATIONS.md` (FC-NNN).
2. When ready to design, draft a plan file here using the template below.
3. Iterate asynchronously — update the plan over time.
4. When the plan is approved, update the FC entry's status to "Plan published" and link the plan file.
5. Execute against the plan. Reference the plan file path in commit messages and PR descriptions.
6. After merge, move the FC entry to "Completed" with a link to the plan and the commit/PR.

## Naming

- File name: `docs/plans/fc-NNN.md` matching the FC entry number (e.g., `fc-001.md` for FC-001)
- This ensures direct traceability between FC entries and their published plans.

## Plan template

Copy `_template.md` in this directory to start a new plan.

## Index

_Active (not-yet-Done) plans. Completed plans are indexed in the "Completed" section of [../FUTURE_CONSIDERATIONS.md](../FUTURE_CONSIDERATIONS.md), each entry linking its plan file._

All plans below (except fc-016, which has human decision gates) carry an `## Execution contract` and execute per [AUTONOMOUS_EXECUTION.md](AUTONOMOUS_EXECUTION.md) — isolated worktree/branch, goal-loop to green, two independent adversarial reviews + confirmation, stop at ready-to-merge.

- [fc-016.md](fc-016.md) — FC-016: Story generation latency reduction, status: Executing (Phase 1 merged; Phases 2–4 pending; partial-autonomy contract)
- [fc-027.md](fc-027.md) — FC-027: Responsive layout Phase 2 (iPad polish), status: Plan published
- [fc-028.md](fc-028.md) — FC-028: Pin backend illustration aspect ratio, status: Plan published
- [fc-039.md](fc-039.md) — FC-039: iOS-style library edit mode, status: Plan published
- [fc-041.md](fc-041.md) — FC-041: Vision moderation pass on generated page images, status: Plan published

_Done (indexed in the [Completed](../FUTURE_CONSIDERATIONS.md#completed) section): FC-024, FC-036, FC-037, FC-038, FC-040 (all merged 2026-07-07)._
