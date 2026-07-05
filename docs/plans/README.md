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

- [fc-016.md](fc-016.md) — FC-016: Story generation latency reduction, status: Executing (Phase 1 merged; Phases 2–4 pending)
- [fc-040.md](fc-040.md) — FC-040: Reader page-turn polish (tap-to-turn animated curl), status: Plan published
