/** Console output of scripts/module: plan sections, step progress, dry-run lines. Tests use a capturing printer. */
export interface Printer {
  info(line: string): void;
  step(n: number | string, title: string): void;
  dry(line: string): void;
  warn(line: string): void;
  error(line: string): void;
  debug(line: string): void;
  section(title: string): void;
}

export class ConsolePrinter implements Printer {
  constructor(private readonly verbose = false) {}
  info(line: string): void { process.stdout.write(`${line}\n`); }
  step(n: number | string, title: string): void { process.stdout.write(`  [${n}] ${title}\n`); }
  dry(line: string): void { process.stdout.write(`      (dry-run) ${line}\n`); }
  warn(line: string): void { process.stderr.write(`WARN  ${line}\n`); }
  error(line: string): void { process.stderr.write(`ERROR ${line}\n`); }
  debug(line: string): void { if (this.verbose) process.stderr.write(`debug ${line}\n`); }
  section(title: string): void { process.stdout.write(`\n== ${title}\n`); }
}

export class CapturePrinter implements Printer {
  readonly lines: string[] = [];
  info(line: string): void { this.lines.push(line); }
  step(n: number | string, title: string): void { this.lines.push(`[${n}] ${title}`); }
  dry(line: string): void { this.lines.push(`(dry-run) ${line}`); }
  warn(line: string): void { this.lines.push(`WARN ${line}`); }
  error(line: string): void { this.lines.push(`ERROR ${line}`); }
  debug(_line: string): void { /* not captured */ }
  section(title: string): void { this.lines.push(`== ${title}`); }
  text(): string { return this.lines.join('\n'); }
}

/** Exit codes of scripts/module (9.2). Application processes use 78 for configuration errors (separate scheme). */
export const EXIT = { ok: 0, rules: 2, stack: 3, migration: 4, health: 5 } as const;

export class CliError extends Error {
  constructor(message: string, readonly exitCode: number = EXIT.rules) { super(message); }
}
