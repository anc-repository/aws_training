// dns-resolve (04 §6.4): A / AAAA records of a hostname (IP literals are rejected by the args schema).
import dns from 'node:dns/promises';
import { CheckError } from '../lib/context.mjs';

export default async function dnsResolve(args) {
  const addresses = [];
  for (const fn of [dns.resolve4, dns.resolve6]) {
    try {
      addresses.push(...(await fn(args.host)));
    } catch (e) {
      if (e && !['ENODATA', 'ENOTFOUND', 'ESERVFAIL', 'ENOTIMP'].includes(e.code)) throw new CheckError('NETWORK', `dns: ${e.code ?? e.message}`);
    }
  }
  return { host: args.host, addresses };
}
