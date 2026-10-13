# @atl/contracts (placeholder)

01 §13 places the interface contracts here: `openapi.yaml` (all routes of 01 §8.2), `events.schema.json` (8.4),
`audit-actions.json` (8.5), `entities/*.schema.json` (7.3), `check-envelope.schema.json` and `certificate.schema.json`
(04). They are written by the API implementer.

Until then the route table, event types, audit actions, error codes and entity key builders live in `@atl/shared`
(`platform/shared/src/`), which is the single TypeScript source the contracts must agree with.
