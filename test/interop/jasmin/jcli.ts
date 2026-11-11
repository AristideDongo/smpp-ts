// Minimal jCli client (Jasmin's telnet management console), enough to configure the gateway
// from a test: users, groups, SMPP client connectors and routes.
import net from 'node:net';

const PROMPT = /jcli : $/;
const SUB_PROMPT = /> $/;

export interface JcliOptions {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  timeoutMs?: number;
}

export class Jcli {
  private buffer = '';
  private waiter: { re: RegExp; resolve: (s: string) => void; reject: (e: Error) => void } | undefined;

  private constructor(
    private readonly socket: net.Socket,
    private readonly timeoutMs: number,
  ) {
    socket.setEncoding('latin1');
    socket.on('data', (chunk: string) => {
      // Telnet negotiation (IAC …) is ignored: jCli works without it.
      this.buffer += chunk
        .replace(/\xff[\xfb-\xfe]./g, '')
        .replace(/\xff./g, '')
        .replace(/\x1b(\[[0-9;]*[a-zA-Z]|c)/g, '')
        .replace(/\r+\n/g, '\n');
      this.check();
    });
    socket.on('close', () => this.waiter?.reject(new Error(`jCli closed. Output so far:\n${this.buffer}`)));
  }

  static async connect(options: JcliOptions = {}): Promise<Jcli> {
    const socket = net.connect(options.port ?? 8990, options.host ?? '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const cli = new Jcli(socket, options.timeoutMs ?? 15_000);
    // jCli echoes input and does not print a "Username:" prompt, only "Authentication required."
    const first = await cli.until(/Authentication required\.\s*$|jcli : $/);
    if (/Authentication required/.test(first)) {
      cli.write(options.username ?? 'jcliadmin');
      await cli.until(/Password: $/);
      cli.write(options.password ?? 'jclipwd');
      const out = await cli.until(/jcli : $|Authentication required\.\s*$|Incorrect/);
      if (!PROMPT.test(out)) throw new Error(`jCli login failed: ${out}`);
    }
    return cli;
  }

  /** Runs one command and returns its output (without the prompt). */
  async run(command: string): Promise<string> {
    this.write(command);
    return stripEcho(await this.until(PROMPT), command);
  }

  /**
   * Interactive add/update: `command`, then each `key value` line, then `ok`.
   * Throws if jCli does not confirm with "Successfully".
   */
  async configure(command: string, entries: Record<string, string | number>): Promise<string> {
    this.write(command);
    await this.until(SUB_PROMPT);
    for (const [key, value] of Object.entries(entries)) {
      this.write(`${key} ${value}`);
      const out = stripEcho(await this.until(SUB_PROMPT), `${key} ${value}`);
      // jCli may print a hint (e.g. the arguments a filter type expects): only errors abort.
      if (/unknown|error|invalid|must|cannot|not (a |an |found|valid|allowed)/i.test(out)) {
        this.write('ko');
        await this.until(PROMPT);
        throw new Error(`jCli rejected "${key} ${value}" in "${command}": ${out}`);
      }
    }
    this.write('ok');
    const out = stripEcho(await this.until(PROMPT), 'ok');
    if (!/Successfully/.test(out)) throw new Error(`jCli "${command}" failed: ${out}`);
    return out;
  }

  async close(): Promise<void> {
    if (this.socket.destroyed) return;
    this.socket.write('quit\r\n');
    this.socket.end();
    await new Promise((resolve) => {
      this.socket.once('close', resolve);
      setTimeout(resolve, 500);
    });
    this.socket.destroy();
  }

  private write(line: string): void {
    this.socket.write(`${line}\r\n`);
  }

  private until(re: RegExp): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = undefined;
        reject(new Error(`jCli timeout waiting for ${re}. Output so far:\n${this.buffer}`));
      }, this.timeoutMs);
      this.waiter = {
        re,
        resolve: (s) => {
          clearTimeout(timer);
          resolve(s);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.check();
    });
  }

  private check(): void {
    const w = this.waiter;
    if (!w || !w.re.test(this.buffer)) return;
    const out = this.buffer;
    this.buffer = '';
    this.waiter = undefined;
    w.resolve(out);
  }
}

/** Removes the echoed command line and the trailing prompt. */
function stripEcho(output: string, command: string): string {
  let out = output.replace(/(jcli : |> )$/, '');
  if (out.startsWith(command)) out = out.slice(command.length);
  return out.trim();
}
