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

_List active plans here as they are added._

- [fc-001.md](fc-001.md) — FC-001: Frontend redesign (Figma v2), status: Plan published
