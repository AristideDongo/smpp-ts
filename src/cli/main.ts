import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { SmppClient } from '../client/client.js';
import type { PduOf } from '../codec/pdu.js';
import { encodings } from '../encoding/registry.js';
import { toError } from '../errors.js';
import type { ServerSession } from '../server/server-session.js';
import { SmppServer } from '../server/server.js';
import type { DlrStatus } from '../utils/dlr.js';
import { decodeMessageContent } from '../utils/multipart.js';

/** Where the CLI writes. Injected so that tests can capture it. */
export interface CliOutput {
  log(line: string): void;
  error(line: string): void;
}

const USAGE = `smpp-ts: SMPP command line tools

Usage:
  smpp-ts smsc [options]   Starts an SMSC simulator
  smpp-ts send [options]   Sends an SMS and prints the message ids

smsc options:
  --port <n>             Port (default 2775)
  --host <addr>          Address to listen on (default 127.0.0.1)
  --system-id <id>       Accepted system_id (default: any)
  --password <pwd>       Accepted password (default: any)
  --dlr <mode>           Receipts: delivered (default), undeliverable, random (80% delivered), none
  --dlr-delay <ms>       Delay before each receipt (default 1000)
  --echo                 Answers each SMS with an MO "echo: <text>" to the sender
  --tls-key <file>       TLS private key (with --tls-cert)
  --tls-cert <file>      TLS certificate
  --quiet                Logs binds only

send options:
  --url <url>            smpp://host:port or ssmpp://host:port (default smpp://127.0.0.1:2775)
  --system-id <id>       Required
  --password <pwd>       Required
  --from <addr>          Sender (number or alphanumeric)
  --to <number>          Recipient
  --text <text>          Message text
  --dlr                  Requests a receipt and waits for the final outcome
  --wait <ms>            Maximum wait for the receipt (default 30000)
  --ca <file>            CA certificate to trust (self-signed SMSC); verification stays on

Common:
  --help, -h             This help
  --version, -v          Version
`;

/** Result of `run`: an exit code, or a running simulator. */
export type CliResult = { exitCode: number } | { server: SmppServer };

export async function run(argv: string[], out: CliOutput = console, version = 'dev'): Promise<CliResult> {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    out.log(USAGE);
    return { exitCode: command ? 0 : 2 };
  }
  if (command === '--version' || command === '-v') {
    out.log(version);
    return { exitCode: 0 };
  }
  try {
    if (command === 'smsc') return { server: await startSimulator(parseSmscArgs(rest), out) };
    if (command === 'send') return { exitCode: await send(parseSendArgs(rest), out) };
    out.error(`Unknown command: ${command}\n\n${USAGE}`);
    return { exitCode: 2 };
  } catch (err) {
    out.error(`Error: ${toError(err).message}`);
    return { exitCode: err instanceof UsageError ? 2 : 1 };
  }
}

class UsageError extends Error {}

function int(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`--${name} must be a non-negative integer`);
  return n;
}

type Values = Record<string, string | boolean | undefined>;

function parse(args: string[], options: Record<string, { type: 'string' | 'boolean' }>): Values {
  try {
    return parseArgs({ args, options, allowPositionals: false, strict: true }).values as Values;
  } catch (err) {
    throw new UsageError(toError(err).message);
  }
}

// ---------------------------------------------------------------- smsc

export type DlrMode = 'delivered' | 'undeliverable' | 'random' | 'none';

export interface SimulatorOptions {
  port: number;
  host: string;
  systemId?: string;
  password?: string;
  dlr: DlrMode;
  dlrDelay: number;
  echo: boolean;
  tls?: { key: Buffer; cert: Buffer };
  quiet: boolean;
}

function parseSmscArgs(args: string[]): SimulatorOptions {
  const v = parse(args, {
    port: { type: 'string' },
    host: { type: 'string' },
    'system-id': { type: 'string' },
    password: { type: 'string' },
    dlr: { type: 'string' },
    'dlr-delay': { type: 'string' },
    echo: { type: 'boolean' },
    'tls-key': { type: 'string' },
    'tls-cert': { type: 'string' },
    quiet: { type: 'boolean' },
  });
  const dlr = (v.dlr as string | undefined) ?? 'delivered';
  if (!['delivered', 'undeliverable', 'random', 'none'].includes(dlr)) {
    throw new UsageError('--dlr must be delivered, undeliverable, random or none');
  }
  if (Boolean(v['tls-key']) !== Boolean(v['tls-cert'])) {
    throw new UsageError('--tls-key and --tls-cert go together');
  }
  const opts: SimulatorOptions = {
    port: int(v.port as string | undefined, 'port', 2775),
    host: (v.host as string | undefined) ?? '127.0.0.1',
    dlr: dlr as DlrMode,
    dlrDelay: int(v['dlr-delay'] as string | undefined, 'dlr-delay', 1000),
    echo: Boolean(v.echo),
    quiet: Boolean(v.quiet),
  };
  if (v['system-id'] !== undefined) opts.systemId = v['system-id'] as string;
  if (v.password !== undefined) opts.password = v.password as string;
  if (v['tls-key']) {
    opts.tls = { key: readFileSync(v['tls-key'] as string), cert: readFileSync(v['tls-cert'] as string) };
  }
  return opts;
}

function textOf(pdu: PduOf<'submit_sm'>): string {
  try {
    const content = decodeMessageContent(pdu as Parameters<typeof decodeMessageContent>[0], {
      registry: encodings,
    });
    return content.text ?? `<${content.body.length} bytes binary>`;
  } catch {
    return '<undecodable>';
  }
}

/** At most `max` UTF-16 units, without cutting a surrogate pair. */
function truncateUtf16(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function receiptStatus(mode: DlrMode): DlrStatus {
  if (mode === 'undeliverable') return 'UNDELIVERABLE';
  if (mode === 'random') return Math.random() < 0.8 ? 'DELIVERED' : 'UNDELIVERABLE';
  return 'DELIVERED';
}

/** SMSC simulator: accepts binds, answers every submit_sm, sends receipts and optional echo MOs. */
export async function startSimulator(opts: SimulatorOptions, out: CliOutput = console): Promise<SmppServer> {
  let nextId = 1;
  const log = (line: string) => {
    if (!opts.quiet) out.log(line);
  };
  const pending = new Set<ReturnType<typeof setTimeout>>();
  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      pending.delete(t);
      fn();
    }, ms);
    pending.add(t);
  };

  const server = new SmppServer({
    authenticate: ({ system_id, password }) =>
      (opts.systemId === undefined || system_id === opts.systemId) &&
      (opts.password === undefined || password === opts.password),
    systemId: 'smpp-ts-sim',
    ...(opts.tls ? { tls: opts.tls } : {}),
    handlers: {
      submit_sm: (pdu, session: ServerSession<unknown>) => {
        const messageId = String(nextId++);
        const text = textOf(pdu);
        log(`submit_sm  ${pdu.source_addr} → ${pdu.destination_addr}  id=${messageId}  "${text}"`);
        if ((pdu.registered_delivery & 0x03) !== 0 && opts.dlr !== 'none') {
          const status = receiptStatus(opts.dlr);
          later(opts.dlrDelay, () => {
            if (!session.canDeliver) return;
            session
              .deliverReceipt({
                messageId,
                status,
                source: pdu.destination_addr,
                destination: pdu.source_addr,
                err: status === 'DELIVERED' ? '000' : '001',
              })
              .then(() => log(`receipt    id=${messageId}  ${status}`))
              .catch((err: unknown) => log(`receipt    id=${messageId}  not sent: ${toError(err).message}`));
          });
        }
        if (opts.echo && session.canDeliver) {
          later(10, () => {
            session
              .deliver({
                source_addr: pdu.destination_addr,
                destination_addr: pdu.source_addr,
                // UCS2 keeps any character of the original text (70 UTF-16 units per SMS).
                short_message: Buffer.from(truncateUtf16(`echo: ${text}`, 70), 'utf16le').swap16(),
                data_coding: 0x08,
              })
              .then(() => log(`deliver_sm ${pdu.destination_addr} → ${pdu.source_addr}  "echo: ${text}"`))
              .catch(() => {});
          });
        }
        return { message_id: messageId };
      },
    },
  });
  server.on('bind', (s) => out.log(`bind       ${s.systemId} (${s.mode}) from ${s.remoteAddress}`));
  server.on('bindFailed', (i) => out.log(`bind refused: ${i.system_id} from ${i.remoteAddress}`));
  server.on('sessionClose', (s) => log(`close      ${s.systemId ?? '(not bound)'}`));
  const close = server.close.bind(server);
  server.close = async () => {
    for (const t of pending) clearTimeout(t);
    pending.clear();
    await close();
  };

  const addr = await server.listen(opts.port, opts.host);
  const auth =
    opts.systemId === undefined && opts.password === undefined
      ? 'any system_id / password'
      : `system_id=${opts.systemId ?? 'any'}`;
  out.log(
    `SMSC simulator listening on ${opts.tls ? 'ssmpp' : 'smpp'}://${addr.address}:${addr.port} (${auth}, receipts: ${opts.dlr})`,
  );
  return server;
}

// ---------------------------------------------------------------- send

export interface SendOptions {
  url: string;
  systemId: string;
  password: string;
  from: string;
  to: string;
  text: string;
  dlr: boolean;
  wait: number;
  ca?: Buffer;
}

function parseSendArgs(args: string[]): SendOptions {
  const v = parse(args, {
    url: { type: 'string' },
    'system-id': { type: 'string' },
    password: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    text: { type: 'string' },
    dlr: { type: 'boolean' },
    wait: { type: 'string' },
    ca: { type: 'string' },
  });
  for (const name of ['system-id', 'password', 'from', 'to', 'text'] as const) {
    if (v[name] === undefined) throw new UsageError(`--${name} is required`);
  }
  const opts: SendOptions = {
    url: (v.url as string | undefined) ?? 'smpp://127.0.0.1:2775',
    systemId: v['system-id'] as string,
    password: v.password as string,
    from: v.from as string,
    to: v.to as string,
    text: v.text as string,
    dlr: Boolean(v.dlr),
    wait: int(v.wait as string | undefined, 'wait', 30_000),
  };
  if (v.ca !== undefined) opts.ca = readFileSync(v.ca as string);
  return opts;
}

/** Sends one SMS; with `dlr`, waits for the final outcome. Exit code: 0 delivered/sent, 1 otherwise. */
export async function send(opts: SendOptions, out: CliOutput = console): Promise<number> {
  const client = new SmppClient({
    url: opts.url,
    bind: {
      mode: opts.dlr ? 'transceiver' : 'transmitter',
      system_id: opts.systemId,
      password: opts.password,
    },
    reconnect: false,
    ...(opts.ca ? { tls: { ca: opts.ca } } : {}),
    trackDeliveries: opts.dlr ? { ttl: opts.wait } : false,
  });
  try {
    await client.connect();
    const outcome = opts.dlr
      ? new Promise<string>((resolve) => client.once('messageStatus', (s) => resolve(s.outcome)))
      : undefined;
    const result = await client.sendText({
      from: opts.from,
      to: opts.to,
      text: opts.text,
      registeredDelivery: opts.dlr,
    });
    out.log(
      `sent: ${result.parts} part(s), ${result.encoding}, message id(s): ${result.messageIds.join(', ')}`,
    );
    if (!outcome) return 0;
    const final = await outcome;
    out.log(`receipt: ${final}`);
    return final === 'DELIVERED' ? 0 : 1;
  } catch (err) {
    out.error(`Error: ${toError(err).message}`);
    return 1;
  } finally {
    await client.close();
  }
}
