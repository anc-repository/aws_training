/**
 * A tiny fake shell for the local mock (dev mode and tests). It is not bash: it echoes like a tty in canonical mode,
 * understands a handful of commands, and emits the ATL shell-integration markers of 03 §3.7.5 (OSC 133 A/B/C/D, OSC 7)
 * and the coloured host-role prompt, so the web terminal can be exercised without AWS. `aws` is deliberately absent.
 */
import { defaultTimers, type Timers } from '../timers.js';

export interface ShellIO {
  write(data: string | Uint8Array): void;
  exit(code: number): void;
}

export interface ShellLike {
  start(): void;
  input(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
}

export interface FakeShellOptions {
  role?: 'lab' | 'workstation';
  user?: string;
  hostname?: string;
  cols?: number;
  rows?: number;
  shellIntegration?: boolean;
  timers?: Timers;
  now?: () => Date;
}

const BEL = '\x07';
const MAX_SEQ_LINES = 200_000;

/** Echo mode: every input byte comes straight back (raw mode, no line discipline). */
export class EchoShell implements ShellLike {
  constructor(private readonly io: ShellIO) {}
  /** One banner line, so a client whose handshake was skipped sees a first Output message (like a shell prompt). */
  start(): void {
    this.io.write('ATL local mock (echo)\r\n');
  }
  input(data: Uint8Array): void {
    this.io.write(data);
  }
  resize(): void {}
  dispose(): void {}
}

function displayWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  return (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x20000 && cp <= 0x3fffd) ? 2 : 1;
}

/** Splits a command line on blanks, honouring '…' and "…" quotes. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (ch === ' ' || ch === '\t') {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

function unescapePrintf(s: string): string {
  return s.replace(/\\(n|t|r|\\|e|a)/g, (_m, c: string) => ({ n: '\n', t: '\t', r: '\r', '\\': '\\', e: '\x1b', a: BEL })[c] ?? c);
}

export class FakeShell implements ShellLike {
  private readonly io: ShellIO;
  private readonly role: 'lab' | 'workstation';
  private readonly user: string;
  private readonly host: string;
  private readonly osc: boolean;
  private readonly timers: Timers;
  private readonly now: () => Date;
  private cols: number;
  private rows: number;
  private cwd: string;
  private line = '';
  private lastExit: number | null = null;
  private busy: unknown = null;
  private esc: 'none' | 'esc' | 'csi' | 'ss3' | 'osc' | 'osc-esc' = 'none';
  private readonly decoder = new TextDecoder();
  private ended = false;

  constructor(io: ShellIO, opts: FakeShellOptions = {}) {
    this.io = io;
    this.role = opts.role ?? 'lab';
    this.user = opts.user ?? 'labuser';
    this.host = opts.hostname ?? (this.role === 'lab' ? 'ip-10-0-1-23' : 'atl-workstation');
    this.cols = opts.cols ?? 80;
    this.rows = opts.rows ?? 24;
    this.osc = opts.shellIntegration ?? true;
    this.timers = opts.timers ?? defaultTimers();
    this.now = opts.now ?? (() => new Date());
    this.cwd = `/home/${this.user}`;
  }

  get size(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  start(): void {
    this.out(`ATL local mock shell (${this.role === 'lab' ? 'lab instance' : 'workstation'}) — no AWS access. Type "help".\r\n`);
    this.prompt();
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  dispose(): void {
    this.ended = true;
    if (this.busy !== null) this.timers.clearTimeout(this.busy);
    this.busy = null;
  }

  input(data: Uint8Array): void {
    if (this.ended) return;
    const text = this.decoder.decode(data, { stream: true });
    for (const ch of text) this.onChar(ch);
  }

  private onChar(ch: string): void {
    if (this.esc !== 'none') {
      this.skipEscape(ch);
      return;
    }
    if (ch === '\x1b') {
      this.esc = 'esc';
      return;
    }
    if (ch === '\x03') {
      this.out('^C\r\n');
      this.line = '';
      if (this.busy !== null) {
        this.timers.clearTimeout(this.busy);
        this.busy = null;
      }
      this.lastExit = 130;
      this.prompt();
      return;
    }
    if (this.busy !== null) {
      // typed while a command runs: echoed like a tty, not executed
      if (ch === '\r' || ch === '\n') this.out('\r\n');
      else if (ch >= ' ') this.out(ch);
      return;
    }
    if (ch === '\r' || ch === '\n') {
      this.out('\r\n');
      const line = this.line;
      this.line = '';
      this.execute(line);
      return;
    }
    if (ch === '\x7f' || ch === '\b') {
      const chars = [...this.line];
      const last = chars.pop();
      if (last !== undefined) {
        this.line = chars.join('');
        const w = displayWidth(last);
        this.out('\b'.repeat(w) + ' '.repeat(w) + '\b'.repeat(w));
      }
      return;
    }
    if (ch === '\x04') {
      if (this.line === '') {
        this.out('exit\r\n');
        this.finish(0);
      }
      return;
    }
    if (ch === '\x15') {
      // Ctrl+U: kill line
      const w = [...this.line].reduce((n, c) => n + displayWidth(c), 0);
      this.out('\b'.repeat(w) + ' '.repeat(w) + '\b'.repeat(w));
      this.line = '';
      return;
    }
    if (ch < ' ') {
      if (ch === '\t') this.out(BEL);
      return;
    }
    this.line += ch;
    this.out(ch);
  }

  private skipEscape(ch: string): void {
    switch (this.esc) {
      case 'esc':
        this.esc = ch === '[' ? 'csi' : ch === 'O' ? 'ss3' : ch === ']' ? 'osc' : 'none';
        return;
      case 'csi':
        if (ch >= '@' && ch <= '~') this.esc = 'none';
        return;
      case 'ss3':
        this.esc = 'none';
        return;
      case 'osc':
        if (ch === BEL) this.esc = 'none';
        else if (ch === '\x1b') this.esc = 'osc-esc';
        return;
      case 'osc-esc':
        this.esc = ch === '\\' ? 'none' : 'osc';
        return;
      default:
        this.esc = 'none';
    }
  }

  private out(s: string): void {
    if (!this.ended) this.io.write(s);
  }

  private prompt(): void {
    let s = '';
    if (this.osc) {
      if (this.lastExit !== null) s += `\x1b]133;D;${this.lastExit}${BEL}`;
      s += `\x1b]7;file://${this.host}${this.cwd}${BEL}\x1b]133;A${BEL}`;
    }
    const label = this.role === 'lab' ? '\x1b[30;43m 实验机 \x1b[0m' : '\x1b[30;46m 工作台 \x1b[0m';
    const home = `/home/${this.user}`;
    const dir = this.cwd === home ? '~' : this.cwd.startsWith(`${home}/`) ? `~${this.cwd.slice(home.length)}` : this.cwd;
    s += `${label} ${this.user}@${this.host}:${dir}$ `;
    if (this.osc) s += `\x1b]133;B${BEL}`;
    this.out(s);
  }

  private done(code: number): void {
    this.lastExit = code;
    this.prompt();
  }

  private finish(code: number): void {
    this.ended = true;
    this.io.exit(code);
  }

  private execute(line: string): void {
    const argv = splitArgs(line.trim());
    if (argv.length === 0) {
      this.prompt();
      return;
    }
    if (this.osc) this.out(`\x1b]133;C${BEL}`);
    const [cmd, ...args] = argv as [string, ...string[]];
    const say = (s: string): void => this.out(s.replace(/\r?\n/g, '\r\n'));
    switch (cmd) {
      case 'help':
        say('commands: echo printf stty tput whoami id hostname pwd cd date uname seq sleep clear true false exit\n');
        return this.done(0);
      case 'echo':
        say(`${args.join(' ')}\n`);
        return this.done(0);
      case 'printf': {
        const [fmt = '', ...rest] = args;
        let i = 0;
        say(unescapePrintf(fmt).replace(/%s/g, () => rest[i++] ?? ''));
        return this.done(0);
      }
      case 'stty':
        if (args[0] === 'size') say(`${this.rows} ${this.cols}\n`);
        return this.done(0);
      case 'tput':
        if (args[0] === 'cols') say(`${this.cols}\n`);
        else if (args[0] === 'lines') say(`${this.rows}\n`);
        return this.done(0);
      case 'whoami':
        say(`${this.user}\n`);
        return this.done(0);
      case 'id':
        say(`uid=1001(${this.user}) gid=1001(${this.user}) groups=1001(${this.user})\n`);
        return this.done(0);
      case 'hostname':
        say(`${this.host}\n`);
        return this.done(0);
      case 'pwd':
        say(`${this.cwd}\n`);
        return this.done(0);
      case 'cd': {
        const target = args[0] ?? '~';
        const home = `/home/${this.user}`;
        if (target === '~' || target === '') this.cwd = home;
        else if (target === '..') this.cwd = this.cwd.replace(/\/[^/]+$/, '') || '/';
        else if (target.startsWith('/')) this.cwd = target.replace(/\/+$/, '') || '/';
        else this.cwd = `${this.cwd === '/' ? '' : this.cwd}/${target.replace(/\/+$/, '')}`;
        return this.done(0);
      }
      case 'date':
        say(`${this.now().toUTCString()}\n`);
        return this.done(0);
      case 'uname':
        say(args.includes('-a') ? `Linux ${this.host} 6.1.0-mock aarch64 GNU/Linux\n` : 'Linux\n');
        return this.done(0);
      case 'seq': {
        const nums = args.map(Number);
        if (nums.length === 0 || nums.some((n) => !Number.isInteger(n))) {
          say('seq: missing or invalid operand\n');
          return this.done(1);
        }
        const [first, step, last] = nums.length === 1 ? [1, 1, nums[0]!] : nums.length === 2 ? [nums[0]!, 1, nums[1]!] : [nums[0]!, nums[1]!, nums[2]!];
        const lines: string[] = [];
        if (step !== 0) for (let n = first; step > 0 ? n <= last : n >= last; n += step) {
          lines.push(String(n));
          if (lines.length >= MAX_SEQ_LINES) break;
        }
        if (lines.length > 0) this.out(`${lines.join('\r\n')}\r\n`);
        return this.done(0);
      }
      case 'sleep': {
        const sec = Math.min(30, Math.max(0, Number(args[0] ?? 0) || 0));
        this.busy = this.timers.setTimeout(() => {
          this.busy = null;
          this.done(0);
        }, sec * 1000);
        return;
      }
      case 'clear':
        this.out('\x1b[H\x1b[2J');
        return this.done(0);
      case 'true':
        return this.done(0);
      case 'false':
        return this.done(1);
      case 'exit': {
        const code = Number(args[0] ?? 0) || 0;
        this.out('logout\r\n');
        this.finish(code);
        return;
      }
      default:
        say(`bash: ${cmd}: command not found (ATL local mock shell)\n`);
        return this.done(127);
    }
  }
}
