# @atl/ssm-client

Browser-side client for the AWS Session Manager data channel, plus a local Node mock. This is the protocol layer of
the ATL web terminal (docs/platform/03-workspace-terminal.md §3.5). The core (`src/`, not counting `src/mock/`) has no
Node dependencies. It needs only WebSocket, TextEncoder/Decoder and Web Crypto `randomUUID`, plus `@noble/hashes`
for synchronous SHA-256.

There is no published specification for this protocol. Every constant and rule is taken from the open-source
reference implementations, which were checked on 2026-10-14 (latest plugin tag 1.2.896.0). Each source file names
the Go file it follows:

- [aws/session-manager-plugin](https://github.com/aws/session-manager-plugin) (Apache-2.0): `src/message/clientmessage.go`,
  `messageparser.go`, `handshakemessage.go`, `src/datachannel/streaming.go`, `src/config/config.go`,
  `src/service/service.go`, `src/sessionmanagerplugin/session/{session,sessionhandler}.go`, `RELEASENOTES.md`
- [aws/amazon-ssm-agent](https://github.com/aws/amazon-ssm-agent) `agent/session/datachannel/datachannel.go` (agent side, used by the mock)
- [bertrandmartel/aws-ssm-session](https://github.com/bertrandmartel/aws-ssm-session) `src/ssm.js` (reference only; its padding and digest differ from the plugin)

| Module | Content |
|---|---|
| `constants.ts` | `PROTOCOL_COMPAT_VERSION`, message / payload types, header offsets, timing and capacities (config.go) |
| `codec.ts`, `uuid.ts` | ClientMessage encode / decode / validate (116-byte HeaderLength, space-padded type, raw SHA-256, UUID low-64-bits-first) |
| `payloads.ts`, `handshake.ts` | OpenDataChannel, AcknowledgeContent, SizeData, ChannelClosed, HandshakeRequest → HandshakeResponse (KMS refused) |
| `channel.ts` | `DataChannel`: sequence numbers, acknowledge, outgoing buffer + RTO retransmission, reorder buffer, duplicate drop |
| `connection.ts` | `SsmTerminalConnection`: WebSocket lifecycle, the 03 §3.5.9 state machine, handshake timeout, input queue, size, channel_closed, resume with backoff |
| `xterm.ts` | `attachXterm` (onData / onBinary / onResize ↔ connection, `write(bytes, ack)` back-pressure), `pasteText`, `observeContainerResize` |
| `streamUrl.ts`, `backoff.ts` | StreamUrl check (wss, host, no userinfo); reconnect delays 100–200 ms ×2, ≤ 5 s, 5 attempts |
| `mock/` (Node) | `MockSsmService` (service + agent, fake shell / echo, fault injection), `startMockSsmServer` (ws + JSON control API), in-memory socket pair |

## Use

```ts
import { SsmTerminalConnection, attachXterm, getTabClientId } from '@atl/ssm-client';

const clientId = getTabClientId();
let terminalId = '';
const conn = new SsmTerminalConnection({
  clientId,
  open: async () => {
    const r = await api.createTerminal(sid, { target: 'lab', cols: term.cols, rows: term.rows, clientId });
    terminalId = r.terminalId;
    return r; // { streamUrl, tokenValue, connectBy, serverNow } — serverNow makes connectBy immune to browser clock skew
  },
  resume: () => api.resumeTerminal(sid, terminalId, { clientId }), // TERMINAL_GONE → 'gone'
  streamUrlPolicy: { region: 'ap-northeast-1' },                    // dev mode: { allowLoopback: true }
});
const binding = attachXterm(term, conn);
conn.on('state', (s) => overlay.render(s)); // failure.reason / closed.output / reconnect.attempt (03 §3.9)
await conn.start();
// session.access_revoked → conn.close('access-revoked'); “结束会话” → DELETE …/terminals/{id}, then conn.close()
```

## Local mock

```bash
npx tsx platform/ssm-client/src/mock/cli.ts --port 8790 [--mode shell|echo] [--handshake session-type|none|kms] [--idle-minutes 20]
curl -s -X POST http://127.0.0.1:8790/StartSession -d '{"sessionName":"atl-s1-term","role":"lab"}'
# → {"SessionId":"atl-s1-term-…","StreamUrl":"ws://127.0.0.1:8790/v1/data-channel/…?role=publish_subscribe","TokenValue":"mock-token-…"}
```

Other routes: `POST /ResumeSession {SessionId}`, `POST /TerminateSession {SessionId}`, `POST /DropConnection {SessionId}`
(simulates a network failure), `GET /sessions`, `GET /health`. In-process use: `new MockSsmService()` from
`@atl/ssm-client/mock`. The mock never contacts AWS.

## Commands

```bash
npx tsc -b platform/ssm-client/tsconfig.json platform/ssm-client/tsconfig.mock.json   # build → dist/
npx tsc -p platform/ssm-client/tsconfig.test.json                                      # type-check sources + tests
npx eslint platform/ssm-client
npx vitest run --root platform/ssm-client
```

Behaviour that can only be confirmed against real AWS, and the deviations from 03 §3.5, are listed in
docs/implementation-notes.md under `## platform-ssm-client`.
