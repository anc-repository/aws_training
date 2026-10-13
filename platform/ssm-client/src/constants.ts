/**
 * Session Manager data channel constants (docs/platform/03 §3.5).
 *
 * There is no published specification of this protocol. Every value below is taken from the open-source reference
 * implementations (Apache-2.0), checked on 2026-10-14 against the `mainline` branch and tag 1.2.896.0 (2026-10-09):
 *
 * - aws/session-manager-plugin `src/config/config.go`            — timing, buffer capacities, retry parameters
 *   https://github.com/aws/session-manager-plugin/blob/mainline/src/config/config.go
 * - aws/session-manager-plugin `src/message/clientmessage.go`    — message types, payload types, header field lengths
 *   https://github.com/aws/session-manager-plugin/blob/mainline/src/message/clientmessage.go
 * - aws/session-manager-plugin `src/message/handshakemessage.go` — handshake action types and statuses
 *   https://github.com/aws/session-manager-plugin/blob/mainline/src/message/handshakemessage.go
 * - aws/session-manager-plugin `src/service/service.go`          — OpenDataChannelInput fields
 *
 * When aligning with a newer plugin release: re-read those files, re-run the interop tests (03 §3.5.13), then bump
 * PROTOCOL_COMPAT_VERSION.
 */

/**
 * The official plugin version whose behaviour this client mirrors; sent as `ClientVersion` in OpenDataChannel and in
 * the HandshakeResponse. The agent switches some behaviour on the client version (e.g. separate output payloads are
 * not enabled for clients ≤ 1.2.295), so it must match what is implemented (03 §3.5.1). Latest tag on 2026-10-14.
 */
export const PROTOCOL_COMPAT_VERSION = '1.2.896.0';

/** `config.MessageSchemaVersion` — OpenDataChannelInput.MessageSchemaVersion. */
export const OPEN_DATA_CHANNEL_SCHEMA_VERSION = '1.0';

/** `ClientMessage.SchemaVersion` written by `SendInputDataMessage` / the acknowledge serializer. */
export const CLIENT_MESSAGE_SCHEMA_VERSION = 1;

/** `config.RolePublishSubscribe` — the `role` query parameter of a StreamUrl (informational; the URL is used as returned). */
export const ROLE_PUBLISH_SUBSCRIBE = 'publish_subscribe';

/** clientmessage.go message type strings. */
export const MessageType = {
  InputStreamData: 'input_stream_data',
  OutputStreamData: 'output_stream_data',
  Acknowledge: 'acknowledge',
  ChannelClosed: 'channel_closed',
  StartPublication: 'start_publication',
  PausePublication: 'pause_publication',
} as const;
export type MessageTypeName = (typeof MessageType)[keyof typeof MessageType];

/** clientmessage.go `PayloadType` (uint32). */
export const PayloadType = {
  /** Not a protocol value: the acknowledge serializer leaves PayloadType at Go's zero value. */
  None: 0,
  Output: 1,
  Error: 2,
  Size: 3,
  Parameter: 4,
  HandshakeRequest: 5,
  HandshakeResponse: 6,
  HandshakeComplete: 7,
  EncChallengeRequest: 8,
  EncChallengeResponse: 9,
  Flag: 10,
  StdErr: 11,
  ExitCode: 12,
} as const;

/** clientmessage.go `PayloadTypeFlag` (uint32 big-endian payload of a Flag message; port forwarding only, unused here). */
export const PayloadTypeFlag = {
  DisconnectToPort: 1,
  TerminateSession: 2,
  ConnectToPortError: 3,
} as const;

/** handshakemessage.go `ActionType`. */
export const ActionType = {
  KMSEncryption: 'KMSEncryption',
  SessionType: 'SessionType',
} as const;

/** handshakemessage.go `ActionStatus`. */
export const ActionStatus = {
  Success: 1,
  Failed: 2,
  Unsupported: 3,
} as const;

/** `config.ShellPluginName` — the session type of a shell (Standard_Stream) session. */
export const SHELL_SESSION_TYPE = 'Standard_Stream';

/** Flags written by `SendInputDataMessage` (input_stream_data) and by `SerializeClientMessageWithAcknowledgeContent`. */
export const STREAM_DATA_FLAGS = 0n;
export const ACKNOWLEDGE_FLAGS = 3n;

// ---- Binary frame layout (clientmessage.go ClientMessage_*Length / *Offset; all integers big-endian) ----

export const HL_OFFSET = 0;
export const MESSAGE_TYPE_OFFSET = 4;
export const MESSAGE_TYPE_LENGTH = 32;
export const SCHEMA_VERSION_OFFSET = 36;
export const CREATED_DATE_OFFSET = 40;
export const SEQUENCE_NUMBER_OFFSET = 48;
export const FLAGS_OFFSET = 56;
export const MESSAGE_ID_OFFSET = 64;
export const MESSAGE_ID_LENGTH = 16;
export const PAYLOAD_DIGEST_OFFSET = 80;
export const PAYLOAD_DIGEST_LENGTH = 32;
export const PAYLOAD_TYPE_OFFSET = 112;
export const PAYLOAD_LENGTH_OFFSET = 116;
export const PAYLOAD_OFFSET = 120;
/** `SerializeClientMessage` writes `ClientMessage_PayloadLengthOffset` (116) as HeaderLength — not 120. */
export const HEADER_LENGTH = PAYLOAD_LENGTH_OFFSET;

// ---- Timing and capacities (config.go) ----

/** `DefaultTransmissionTimeout` — initial retransmission timeout (RTO). */
export const DEFAULT_TRANSMISSION_TIMEOUT_MS = 200;
/** `DefaultRoundTripTime`. */
export const DEFAULT_ROUND_TRIP_TIME_MS = 100;
/** `DefaultRoundTripTimeVariation`. */
export const DEFAULT_ROUND_TRIP_TIME_VARIATION_MS = 0;
/** `ResendSleepInterval` — period of the retransmission scheduler. */
export const RESEND_SLEEP_INTERVAL_MS = 100;
/** `ResendMaxAttempt` (“5 minutes / ResendSleepInterval”). */
export const RESEND_MAX_ATTEMPT = 3000;
/** `StreamDataPayloadSize` — maximum bytes of one input_stream_data payload. */
export const STREAM_DATA_PAYLOAD_SIZE = 1024;
/** `OutgoingMessageBufferCapacity`. */
export const OUTGOING_MESSAGE_BUFFER_CAPACITY = 10000;
/** `IncomingMessageBufferCapacity`. */
export const INCOMING_MESSAGE_BUFFER_CAPACITY = 10000;
/** `RTTConstant` (α) and `RTTVConstant` (β) of the RFC 6298-style estimator in `CalculateRetransmissionTimeout`. */
export const RTT_CONSTANT = 1 / 8;
export const RTTV_CONSTANT = 1 / 4;
/** `ClockGranularity`. */
export const CLOCK_GRANULARITY_MS = 10;
/** `MaxTransmissionTimeout` — RTO ceiling. */
export const MAX_TRANSMISSION_TIMEOUT_MS = 1000;

/**
 * Reconnect retry (sessionhandler.go `OpenDataChannel` → `retry.RepeatableExponentialRetryer`):
 * `InitialDelayInMilli = rand(DataChannelRetryInitialDelayMillis) + DataChannelRetryInitialDelayMillis` (100–199 ms),
 * `GeometricRatio = RetryBase` (2), `MaxDelayInMilli = DataChannelRetryMaxIntervalMillis` (5000),
 * `MaxAttempts = DataChannelNumMaxRetries` (5). 03 §3.5.9 adopts these values.
 */
export const RECONNECT_INITIAL_DELAY_MS = 100;
export const RECONNECT_RETRY_BASE = 2;
export const RECONNECT_MAX_DELAY_MS = 5000;
export const RECONNECT_MAX_ATTEMPTS = 5;

/** `PingTimeInterval` (5 min) — WebSocket ping control frames; a browser cannot send them (03 §3.5.8, D4). */
export const PING_TIME_INTERVAL_MS = 5 * 60 * 1000;

// ---- Platform parameters (docs/platform/03), not from the plugin ----

/** 03 §3.5.4: no HandshakeRequest and no Output within 15 s after OpenDataChannel → the connection failed. */
export const HANDSHAKE_TIMEOUT_MS = 15_000;
/** 03 §3.2 step 10: `connectBy = now + 30 s` — after that the TokenValue is not used; resume instead. */
export const CONNECT_BY_MS = 30_000;
/** 03 §3.5.6: ResizeObserver debounce. */
export const RESIZE_DEBOUNCE_MS = 150;
/** 03 §3.5.8: optional `terminal.keepalive = size-nudge` period (off by default). */
export const SIZE_NUDGE_INTERVAL_MS = 4 * 60 * 1000;
/** Input typed before Ready / while reconnecting is queued up to this many bytes (excess is dropped and reported). */
export const PENDING_INPUT_LIMIT_BYTES = 1024 * 1024;
