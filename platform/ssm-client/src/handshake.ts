/**
 * Handshake (03 §3.5.4) as pure functions.
 *
 * Sources (checked 2026-10-14):
 * - aws/session-manager-plugin `src/message/handshakemessage.go` — payload structs, ActionType, ActionStatus
 * - aws/session-manager-plugin `src/datachannel/streaming.go` — `handleHandshakeRequest` (ack first, then answer each
 *   requested action), `handleHandshakeComplete` (print CustomerMessage)
 * - aws/session-manager-plugin `src/sessionmanagerplugin/session/sessionhandler.go` — `ProcessFirstMessage`: when the
 *   first stream message is an Output payload and no session type was negotiated, the agent skipped the handshake
 *   and the client starts the shell right away
 * - aws/amazon-ssm-agent `agent/session/datachannel/datachannel.go` — `PerformHandshake` (HandshakeRequest → wait for
 *   HandshakeResponse → [encryption challenge] → HandshakeComplete); stream data other than the handshake response
 *   is acknowledged but ignored until the handshake completes
 *
 * Platform rules (03 §3.5.4): SessionType must be `Standard_Stream` (else Unsupported); KMSEncryption is answered
 * with Failed — the browser would need `kms:GenerateDataKey` with learner credentials and AES-GCM in the page, which
 * the platform does not do (D4). The agent then ends the session.
 */
import { ActionStatus, ActionType, SHELL_SESSION_TYPE } from './constants.js';
import { encodeJson, isRecord, parseJsonBytes } from './payloads.js';

export interface RequestedClientAction {
  ActionType: string;
  /** json.RawMessage — e.g. `{"SessionType":"Standard_Stream","Properties":{…}}` or `{"KMSKeyId":"…"}`. */
  ActionParameters: unknown;
}

export interface HandshakeRequestPayload {
  AgentVersion: string;
  RequestedClientActions: RequestedClientAction[];
}

export interface ProcessedClientAction {
  ActionType: string;
  ActionStatus: number;
  ActionResult: unknown;
  Error: string;
}

export interface HandshakeResponsePayload {
  ClientVersion: string;
  ProcessedClientActions: ProcessedClientAction[];
  Errors: string[];
}

export interface HandshakeCompletePayload {
  /** Go `time.Duration` — nanoseconds. */
  HandshakeTimeToComplete: number;
  CustomerMessage: string;
}

export const KMS_UNSUPPORTED_ERROR = 'ATL web terminal does not support KMS session encryption';

export type HandshakeRejection = 'kms-unsupported' | 'session-type-unsupported';

export interface HandshakeOutcome {
  response: HandshakeResponsePayload;
  agentVersion: string;
  /** Session type requested by the agent (null when the request had no SessionType action). */
  sessionType: string | null;
  /** Set when this client cannot run the session; the agent ends it after reading the response. */
  rejected: HandshakeRejection | null;
}

export function parseHandshakeRequest(payload: Uint8Array): HandshakeRequestPayload | null {
  const v = parseJsonBytes(payload);
  if (!isRecord(v)) return null;
  const actions = Array.isArray(v.RequestedClientActions) ? v.RequestedClientActions : [];
  return {
    AgentVersion: typeof v.AgentVersion === 'string' ? v.AgentVersion : '',
    RequestedClientActions: actions.filter(isRecord).map((a) => ({
      ActionType: typeof a.ActionType === 'string' ? a.ActionType : '',
      ActionParameters: a.ActionParameters ?? null,
    })),
  };
}

/** Builds the HandshakeResponse for a HandshakeRequest (one ProcessedClientAction per requested action, in order). */
export function processHandshakeRequest(req: HandshakeRequestPayload, clientVersion: string): HandshakeOutcome {
  const processed: ProcessedClientAction[] = [];
  const errors: string[] = [];
  let sessionType: string | null = null;
  let rejected: HandshakeRejection | null = null;

  for (const action of req.RequestedClientActions) {
    switch (action.ActionType) {
      case ActionType.SessionType: {
        const p = isRecord(action.ActionParameters) ? action.ActionParameters : {};
        sessionType = typeof p.SessionType === 'string' ? p.SessionType : '';
        if (sessionType === SHELL_SESSION_TYPE) {
          processed.push({ ActionType: action.ActionType, ActionStatus: ActionStatus.Success, ActionResult: null, Error: '' });
        } else {
          const error = `Unsupported session type ${sessionType}`;
          processed.push({ ActionType: action.ActionType, ActionStatus: ActionStatus.Unsupported, ActionResult: null, Error: error });
          errors.push(error);
          rejected ??= 'session-type-unsupported';
        }
        break;
      }
      case ActionType.KMSEncryption: {
        processed.push({ ActionType: action.ActionType, ActionStatus: ActionStatus.Failed, ActionResult: null, Error: KMS_UNSUPPORTED_ERROR });
        errors.push(KMS_UNSUPPORTED_ERROR);
        rejected = 'kms-unsupported';
        break;
      }
      default: {
        // The plugin answers unknown actions with “Unsupported action %s”; we also set ActionStatus = Unsupported.
        const error = `Unsupported action ${action.ActionType}`;
        processed.push({ ActionType: action.ActionType, ActionStatus: ActionStatus.Unsupported, ActionResult: null, Error: error });
        errors.push(error);
      }
    }
  }

  return {
    response: { ClientVersion: clientVersion, ProcessedClientActions: processed, Errors: errors },
    agentVersion: req.AgentVersion,
    sessionType,
    rejected,
  };
}

export function encodeHandshakeResponse(r: HandshakeResponsePayload): Uint8Array {
  return encodeJson({ ClientVersion: r.ClientVersion, ProcessedClientActions: r.ProcessedClientActions, Errors: r.Errors });
}

export function parseHandshakeResponse(payload: Uint8Array): HandshakeResponsePayload | null {
  const v = parseJsonBytes(payload);
  if (!isRecord(v)) return null;
  const actions = Array.isArray(v.ProcessedClientActions) ? v.ProcessedClientActions.filter(isRecord) : [];
  return {
    ClientVersion: typeof v.ClientVersion === 'string' ? v.ClientVersion : '',
    ProcessedClientActions: actions.map((a) => ({
      ActionType: typeof a.ActionType === 'string' ? a.ActionType : '',
      ActionStatus: typeof a.ActionStatus === 'number' ? a.ActionStatus : 0,
      ActionResult: a.ActionResult ?? null,
      Error: typeof a.Error === 'string' ? a.Error : '',
    })),
    Errors: Array.isArray(v.Errors) ? v.Errors.filter((e): e is string => typeof e === 'string') : [],
  };
}

export function encodeHandshakeRequest(r: HandshakeRequestPayload): Uint8Array {
  return encodeJson({ AgentVersion: r.AgentVersion, RequestedClientActions: r.RequestedClientActions });
}

export function encodeHandshakeComplete(c: HandshakeCompletePayload): Uint8Array {
  return encodeJson({ HandshakeTimeToComplete: c.HandshakeTimeToComplete, CustomerMessage: c.CustomerMessage });
}

export function parseHandshakeComplete(payload: Uint8Array): HandshakeCompletePayload {
  const v = parseJsonBytes(payload);
  const r = isRecord(v) ? v : {};
  return {
    HandshakeTimeToComplete: typeof r.HandshakeTimeToComplete === 'number' ? r.HandshakeTimeToComplete : 0,
    CustomerMessage: typeof r.CustomerMessage === 'string' ? r.CustomerMessage : '',
  };
}
