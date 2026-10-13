# platform/infra/src — template fragments (01 §4.4, §13)

The single-stack template is assembled from YAML fragments in this directory by `build/merge-template.ts`
(`npm run template -w @atl/infra` → `platform/infra/dist/atl-platform.template.json`):

| file | content (01 §13) |
|---|---|
| `00-meta.yaml` | Parameters (01 §4.3, names in `INSTALL_PARAMETERS` of @atl/shared), Rules, Conditions, parameter groups |
| `10-data.yaml` | `atl-main` (key schema = `ATL_MAIN_SPEC` of @atl/shared), `atl-data`, `atl-artifacts` |
| `15-labstate.yaml` | `cloudalbum-lab-state-*`, `cloudalbum-lab-locks` (`LAB_LOCKS_SPEC`) |
| `20-auth.yaml` … `90-install.yaml` | Cognito, HTTP API, workflows, events, IAM, SSM, web, signing, install custom resources |

Fragments use the usual CloudFormation short tags (`!Ref`, `!Sub`, `!GetAtt`, …); each top-level section
(`Parameters`, `Conditions`, `Resources`, `Outputs`, …) is merged, duplicate keys are an error.
The infra implementer writes the fragments; this directory only holds this README in the scaffold.
