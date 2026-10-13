#!/usr/bin/env node
/**
 * atl-agent-call [--endpoint <https://…execute-api…>] [--data <json | @file | ->] [--idempotency-key <key>] <METHOD> <PATH>
 * Installed on the workstation as /opt/atl/bin/atl-agent-call (bundled with its dependencies by platform/infra/build/package.ts).
 * The endpoint defaults to ATL_AGENT_API (environment, then /etc/atl/session.env). POST and PUT get a random
 * Idempotency-Key unless one is given (the API requires it, 01 §7.5).
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SignatureV4 } from '@smithy/signature-v4';
import { agentApiFromEnvFile, callAgent, UsageError, type AgentCallDeps } from '../agent-call.js';

function parseArgs(argv: string[]): { endpoint?: string; data?: string; idempotencyKey?: string; method: string; path: string } {
  const rest: string[] = [];
  const out: { endpoint?: string; data?: string; idempotencyKey?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--endpoint') out.endpoint = argv[++i];
    else if (a === '--data') out.data = argv[++i];
    else if (a === '--idempotency-key') out.idempotencyKey = argv[++i];
    else if (a === '-h' || a === '--help') throw new UsageError('usage: atl-agent-call [--endpoint URL] [--data JSON|@file|-] [--idempotency-key KEY] METHOD PATH');
    else rest.push(a);
  }
  if (rest.length !== 2) throw new UsageError('usage: atl-agent-call [--endpoint URL] [--data JSON|@file|-] [--idempotency-key KEY] METHOD PATH');
  return { ...out, method: rest[0]!.toUpperCase(), path: rest[1]! };
}

function readData(data: string | undefined): string | undefined {
  if (data === undefined) return undefined;
  if (data === '-') return fs.readFileSync(0, 'utf8');
  if (data.startsWith('@')) return fs.readFileSync(data.slice(1), 'utf8');
  return data;
}

function endpointFromEnvironment(): string | undefined {
  if (process.env.ATL_AGENT_API) return process.env.ATL_AGENT_API;
  try {
    return agentApiFromEnvFile(fs.readFileSync('/etc/atl/session.env', 'utf8')) ?? undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const endpoint = args.endpoint ?? endpointFromEnvironment();
  if (!endpoint) throw new UsageError('no endpoint: pass --endpoint or set ATL_AGENT_API');
  const credentials = defaultProvider();
  const deps: AgentCallDeps = {
    async sign({ method, url, headers, body, region }) {
      const signer = new SignatureV4({ service: 'execute-api', region, credentials, sha256: Sha256 });
      const query: Record<string, string> = {};
      url.searchParams.forEach((v, k) => (query[k] = v));
      const signed = await signer.sign({ method, protocol: url.protocol, hostname: url.hostname, path: url.pathname, query, headers, body });
      return signed.headers as Record<string, string>;
    },
    fetch: (url, init) => fetch(url, init),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    log: (line) => process.stderr.write(line + '\n'),
  };
  const idempotencyKey = args.idempotencyKey ?? (args.method === 'POST' || args.method === 'PUT' ? randomUUID() : undefined);
  const r = await callAgent({ endpoint, method: args.method, path: args.path, body: readData(args.data), idempotencyKey }, deps);
  if (r.body) process.stdout.write(r.body.endsWith('\n') ? r.body : r.body + '\n');
  if (r.exitCode !== 0) process.stderr.write(`atl-agent-call: failed after ${r.attempts} attempt(s) (status ${r.status ?? 'none'})\n`);
  return r.exitCode;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`atl-agent-call: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = e instanceof UsageError ? 2 : 4;
  },
);
