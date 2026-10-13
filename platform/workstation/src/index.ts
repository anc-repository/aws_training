/**
 * @atl/workstation — tools that run on the per-session workstation (03 §4). Shell entry points
 * (`atl-workstation-setup.sh`, `atl-agent-call`, `atl-credentials`, `atl-lab-proxy`, user-data) are added by the
 * workstation implementer under `platform/workstation/bin/` and `platform/workstation/bootstrap/`; the CloudFormation
 * template of the workstation stack stays at `platform/workflows/templates/atl-workstation.yaml` (01 §13).
 */
export * from './session-files.js';
