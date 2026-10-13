# platform/ — AWS Training Lab (ATL)

Design: `docs/platform/01…08`. Directory layout: 01 §13; implementation conventions and the dev mode:
`docs/implementation-notes.md` (section “platform-scaffold”).

| package | path | content |
|---|---|---|
| `@atl/shared` | `platform/shared` | 01 §14 name table as code (ids, DynamoDB keys, routes, states/transitions, events, errors, ATL_OP, roles, tags, resources), lab.yaml v2 schema + types, `atl.agent-context/v1`, port interfaces |
| `@atl/api` | `platform/api` | the twelve Lambda functions, AWS adapters (`src/aws/`), dev runtime (`src/dev/`, ATL_DEV_MODE=1), esbuild bundling (`build.mjs`) |
| `@atl/workflows` | `platform/workflows` | `statemachines/*.asl.json`, ASL validation, in-process Step Functions simulator; runner buildspec / ops, SSM documents, workstation stack template, reclaimer rules |
| `@atl/infra` | `platform/infra` | template fragments `src/NN-*.yaml`, policies, build scripts, template tests |
| `@atl/workstation` | `platform/workstation` | workstation tools (session files from the agent context, setup / agent-call / credentials / lab-proxy) |
| `@atl/web` | `platform/web` | SPA (placeholder in this round) |
| `@atl/labs-tools` | `scripts/labs` | `labs:schema`, `labs:lint`, `labs:derive`, `labs:build`, `labs:catalog`, `labs:policy` |

```bash
npm ci                          # at the repository root (the platform packages are root workspaces)
npm run build && npm test       # everything, CloudAlbum included
npm run platform:build          # tsc + Lambda bundles (platform/api/dist-lambda) + merged template (platform/infra/dist)
npm run platform:test           # only the platform test projects
npm run platform:validate       # ASL structural checks + asl-validator

# dev mode (no AWS): DynamoDB Local + everything else in-process
npm run platform:db:up && npm run platform:db:init
npm run platform:dev            # http://127.0.0.1:8787 — Authorization: Bearer dev.learner.u1
```

`cd platform && npm run build|test|dev|validate` forwards to the root scripts.
