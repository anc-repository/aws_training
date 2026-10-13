# platform/infra — the single-stack platform template (01 §3–§6, §13)

| path | content |
|---|---|
| `src/00-meta.yaml` | Parameters (01 §4.3 = `INSTALL_PARAMETERS`), Rules (verified region, workstation type ∈ allowed types, dev ⇒ s3 source, release tag, custom domain pair), Conditions, parameter groups |
| `src/10-data.yaml` | `atl-main` (= `ATL_MAIN_SPEC`), `atl-data-*`, `atl-artifacts-*` (+ TLS-only bucket policies) |
| `src/15-labstate.yaml` | state bucket `cloudalbum-lab-state-*`, lock table `cloudalbum-lab-locks` (= `LAB_LOCKS_SPEC`), tag `atl:component=lab-state` |
| `src/20-auth.yaml` | Cognito `atl-users` (TOTP, admin-created users), domain `atl-<installation id[0..8]>`, client `atl-web`, groups, the learner user |
| `src/30-api.yaml` | HTTP API `atl-api`: JWT / agent (IAM) / internal (IAM) / public / fallback routes, stage, access log, invoke permissions |
| `src/40-workflows.yaml` | CodeBuild `atl-runner`, schedule groups, `atl-sweeper` (disabled), `atl-timer-dlq` |
| `src/45-events.yaml` | `atl-events`, `atl-sfn-failed`, SNS topics, optional budget / analyzer / trail + tagger rule |
| `src/50-iam.yaml` | all roles, boundaries, guardrails, provisioner policies (documents from `policies/`) |
| `src/60-ssm.yaml` | the five SSM documents (content from `ssm/`), association `atl-prepare-instance`, `/atl/*` parameters, recording resources |
| `src/70-web.yaml` | `atl-web-*`, OAC, `atl-spa-rewrite`, response headers policies, distribution `atl-web` |
| `src/80-signing.yaml` | KMS `ECC_NIST_P256` signing key + `alias/atl-certificates` |
| `src/90-install.yaml` | CopyArtifacts, Preflight, SeedData, SchemaMigrator, WebDeploy, JwksPublish, BucketEmptier, UninstallGuard, StackGuard; Outputs |
| `policies/*.json.tmpl` | IAM policy sources; `build/gen-policies.ts` → `policies/generated/` (CFN form, rendered example, `sizes.json`) |
| `ssm/*.yaml` | ATL-RunCheck, ATL-SessionShell(-Logged), ATL-PrepareInstance, ATL-WorkstationSetup |
| `custom-resources/` | `atl-custom-resources` (TypeScript, bundled into `atl-lambdas.zip`) and `copy-artifacts.cjs` (inline `atl-copy-artifacts`) |
| `build/` | `merge-template` (fragments + generated functions / state machines + tokens), `gen-policies`, `package`, `publish-s3`, `launch-link`, `cfn-lint`, `workstation-template` |

Generated resources (build/template-parts.ts): the twelve functions with their log groups, the six state machines with
their log groups (ASL from `platform/workflows/statemachines/`, DefinitionSubstitutions from `DEV_SUBSTITUTIONS`).

```bash
npm run template -w @atl/infra          # dist/atl-platform.template.json (root: npm run platform:build)
npm run policies -w @atl/infra          # regenerate policies/generated/ and print the size budget
npm run package -w @atl/infra           # dist/release/<tag>/ (GitHub Release layout + SHA256SUMS + template)
npm run publish:s3 -w @atl/infra -- --bucket <bucket> --prefix atl/dev [--profile p] [--dry-run]
npm run cfn-lint -w @atl/infra          # needs cfn-lint (pip install cfn-lint or ATL_CFN_LINT=<path>)
npm run check -w @atl/infra             # generated files current + template + cfn-lint
```
