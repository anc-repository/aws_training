/**
 * What the runner needs from its machine: processes, files, HTTP, time. The real implementation (`main.ts`) uses
 * node:child_process / node:fs / fetch; tests use a scripted fake.
 */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** stream output to the build log (default true); secrets must use `quiet` */
  quiet?: boolean;
}

export interface Host {
  run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult>;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, data: string, opts?: { mode?: number; append?: boolean }): Promise<void>;
  removeFile(path: string): Promise<void>;
  listFiles(dir: string): Promise<string[]>;
  post(url: string, init: { headers: Record<string, string>; body: string }): Promise<number>;
  now(): Date;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}
