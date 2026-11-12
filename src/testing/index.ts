/**
 * In-process SMSC for application tests (Vitest, Jest, node:test): records what the application sends,
 * answers it, sends receipts and incoming messages, and injects the failures that are hard to reproduce
 * against a real SMSC (throttling, lost responses, connection drops, duplicate receipts, congestion).
 *
 * ```ts
 * import { createTestSmsc } from 'smpp-ts/testing';
 *
 * const smsc = await createTestSmsc();
 * const client = new SmppClient({ url: smsc.url, bind: { mode: 'transceiver', system_id: 'test', password: 'x' } });
 * await client.connect();
 * smsc.failNext('submit_sm', COMMAND_STATUS.ESME_RTHROTTLED);
 * await client.sendText({ from: 'ACME', to: '2250700000000', text: 'hello' });
 * expect(smsc.submitted[0]?.text).toBe('hello');
 * await smsc.close();
 * ```
 *
 * @module
 */
import type tls from 'node:tls';
import type { Pdu, PduOf } from '../codec/pdu.js';
import { encodings } from '../encoding/registry.js';
import { SmppError, toError } from '../errors.js';
import { MESSAGE_STATE } from '../protocol/constants.js';
import { COMMAND_STATUS } from '../protocol/status.js';
import type { ServerSession } from '../server/server-session.js';
import {
  type Authenticate,
  type HandlerContext,
  SmppServer,
  type SmppServerOptions,
} from '../server/server.js';
import type { BindMode } from '../session/state-machine.js';
import type { DlrStatus } from '../utils/dlr.js';
import { buildParts, decodeMessageContent } from '../utils/multipart.js';

/** Requests the test SMSC answers. */
export type TestSmscCommand =
  | 'submit_sm'
  | 'data_sm'
  | 'submit_multi'
  | 'query_sm'
  | 'cancel_sm'
  | 'replace_sm';

const COMMANDS: readonly TestSmscCommand[] = [
  'submit_sm',
  'data_sm',
  'submit_multi',
  'query_sm',
  'cancel_sm',
  'replace_sm',
];

export interface TestSmscOptions {
  /** Accepted system_id. Default: any. */
  systemId?: string;
  /** Accepted password. Default: any. */
  password?: string;
  /** Custom authentication, instead of `systemId` / `password`. */
  authenticate?: Authenticate<unknown>;
  /**
   * Receipt sent for each submit_sm that asks for one (registered_delivery): a status, `none`,
   * or a function of the PDU. Default: `DELIVERED`.
   */
  receipts?: DlrStatus | 'none' | ((pdu: PduOf<'submit_sm'>) => DlrStatus | 'none');
  /** Delay before each receipt, in ms. Default: 0. */
  receiptDelay?: number;
  /** Sends every receipt twice (to test duplicate handling). Default: false. */
  duplicateReceipts?: boolean;
  /** message_id given to the n-th accepted message (1-based). Default: `String(n)`. */
  messageId?: (n: number) => string;
  /** Default: 127.0.0.1. */
  host?: string;
  /** Default: 0 (a free port). */
  port?: number;
  /** TLS key and certificate: the SMSC then listens with TLS (`ssmpp://`). */
  tls?: tls.TlsOptions;
  /** Extra `SmppServer` options (limits, timeouts, logger…). */
  server?: Partial<SmppServerOptions<unknown>>;
}

/** A message the application submitted. */
export interface SubmittedMessage {
  command: 'submit_sm' | 'data_sm';
  pdu: PduOf<'submit_sm'> | PduOf<'data_sm'>;
  /** message_id returned, if the request was accepted. */
  messageId?: string;
  from: string;
  to: string;
  /** Text of this segment (UDH removed), or `undefined` for binary content. */
  text?: string;
  /** system_id of the session it came on. */
  systemId: string | undefined;
}

/** A successful bind (the password is never recorded). */
export interface BindRecord {
  systemId: string;
  mode: BindMode;
  sessionId: string;
}

type Fault =
  | { kind: 'status'; status: number }
  | { kind: 'drop' }
  | { kind: 'delay'; ms: number }
  | { kind: 'disconnect' };

interface Waiter {
  match: (pdu: Pdu) => boolean;
  count: number;
  resolve: (pdus: Pdu[]) => void;
}

/** In-process SMSC for tests. Create it with `createTestSmsc()`. */
export class TestSmsc {
  /** Every request received (binds excluded), in order. */
  readonly received: Pdu[] = [];
  /** submit_sm and data_sm received, decoded. */
  readonly submitted: SubmittedMessage[] = [];
  /** Successful binds. */
  readonly binds: BindRecord[] = [];
  /** Receipts that could not be sent (session closed meanwhile…). */
  readonly errors: Error[] = [];
  /** `smpp://host:port` (or `ssmpp://`). */
  url = '';
  port = 0;

  private readonly faults = new Map<TestSmscCommand, Fault[]>();
  private readonly waiters = new Set<Waiter>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private congestion: number | undefined;
  private nextId = 1;
  readonly server: SmppServer<unknown>;

  /** @internal Use `createTestSmsc()`. */
  constructor(private readonly options: TestSmscOptions = {}) {
    const handlers: Record<string, unknown> = {};
    for (const command of COMMANDS) {
      handlers[command] = (pdu: Pdu, session: ServerSession<unknown>, ctx: HandlerContext) =>
        this.handle(command, pdu, session, ctx);
    }
    this.server = new SmppServer<unknown>({
      authenticate:
        options.authenticate ??
        (({ system_id, password }) =>
          (options.systemId === undefined || system_id === options.systemId) &&
          (options.password === undefined || password === options.password)),
      systemId: 'smpp-ts-test',
      // A dropped request must stay unanswered for as long as the test runs.
      handlerTimeout: 3_600_000,
      inboundWindow: 1000,
      ...(options.tls ? { tls: options.tls } : {}),
      ...options.server,
      handlers: handlers as SmppServerOptions<unknown>['handlers'],
    });
    this.server.on('bind', (s) => {
      if (s.mode && s.systemId !== undefined) {
        this.binds.push({ systemId: s.systemId, mode: s.mode, sessionId: s.id });
      }
    });
  }

  /** @internal */
  async listen(): Promise<this> {
    const addr = await this.server.listen(this.options.port ?? 0, this.options.host ?? '127.0.0.1');
    this.port = addr.port;
    const host = addr.address.includes(':') ? `[${addr.address}]` : addr.address;
    this.url = `${this.options.tls ? 'ssmpp' : 'smpp'}://${host}:${addr.port}`;
    return this;
  }

  /** Bound sessions. */
  get sessions(): ServerSession<unknown>[] {
    return [...this.server.sessions].filter((s) => s.mode !== undefined);
  }

  // ---------------------------------------------------------------- faults

  /** The next `times` requests of `command` are answered with `status`. */
  failNext(command: TestSmscCommand, status: number, times = 1): this {
    return this.addFault(command, { kind: 'status', status }, times);
  }

  /** The next `times` submit_sm are answered with ESME_RTHROTTLED. */
  throttleNext(times = 1): this {
    return this.failNext('submit_sm', COMMAND_STATUS.ESME_RTHROTTLED, times);
  }

  /** The next `times` requests of `command` are never answered (lost response, timeout on the client). */
  dropNext(command: TestSmscCommand, times = 1): this {
    return this.addFault(command, { kind: 'drop' }, times);
  }

  /** The next `times` requests of `command` are answered after `ms`. */
  delayNext(command: TestSmscCommand, ms: number, times = 1): this {
    return this.addFault(command, { kind: 'delay', ms }, times);
  }

  /**
   * The connection is cut when the next request of `command` arrives, before it is answered:
   * the client sees the request in flight when the connection drops.
   */
  disconnectOnNext(command: TestSmscCommand): this {
    return this.addFault(command, { kind: 'disconnect' }, 1);
  }

  /** SMPP 5.0 `congestion_state` (0-100) added to every response; `undefined` to stop. */
  setCongestion(level: number | undefined): this {
    this.congestion = level;
    return this;
  }

  /** Cuts every connection at once (no unbind). The client should reconnect. */
  disconnectAll(): void {
    for (const s of this.server.sessions) s.destroy();
  }

  private addFault(command: TestSmscCommand, fault: Fault, times: number): this {
    const list = this.faults.get(command) ?? [];
    for (let i = 0; i < times; i++) list.push(fault);
    this.faults.set(command, list);
    return this;
  }

  // ---------------------------------------------------------------- waiting

  /**
   * Waits until `count` requests matching `command` (or a predicate) were received in total, and
   * returns them. Rejects after `timeout` ms (default 5 000).
   */
  waitFor(
    command: TestSmscCommand | ((pdu: Pdu) => boolean),
    options: { count?: number; timeout?: number } = {},
  ): Promise<Pdu[]> {
    const match = typeof command === 'function' ? command : (pdu: Pdu) => pdu.command === command;
    const count = options.count ?? 1;
    const done = this.received.filter(match);
    if (done.length >= count) return Promise.resolve(done.slice(0, count));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        const label = typeof command === 'function' ? 'matching requests' : command;
        reject(
          new SmppError(
            'SMPP_TEST_TIMEOUT',
            `Received ${this.received.filter(match).length} of ${count} ${label}`,
          ),
        );
      }, options.timeout ?? 5_000);
      const waiter: Waiter = {
        match,
        count,
        resolve: (pdus) => {
          clearTimeout(timer);
          resolve(pdus);
        },
      };
      this.waiters.add(waiter);
    });
  }

  private record(pdu: Pdu): void {
    this.received.push(pdu);
    for (const w of [...this.waiters]) {
      const found = this.received.filter(w.match);
      if (found.length >= w.count) {
        this.waiters.delete(w);
        w.resolve(found.slice(0, w.count));
      }
    }
  }

  // ---------------------------------------------------------------- inbound traffic

  /**
   * Sends an incoming message (MO) to a receiver or transceiver session: of `systemId` if given,
   * otherwise the first one bound. A long text is split into concatenated segments.
   */
  async sendMo(opts: { from: string; to: string; text: string; systemId?: string }): Promise<void> {
    const session = this.receiverFor(opts.systemId);
    const built = buildParts(opts.text, { reference: Math.floor(Math.random() * 256), registry: encodings });
    for (const part of built.parts) {
      await session.deliver({ source_addr: opts.from, destination_addr: opts.to, ...part });
    }
  }

  /** Sends a delivery receipt for a message, as the SMSC would after a submit. */
  async sendReceipt(opts: {
    messageId: string;
    status: DlrStatus;
    /** Recipient of the original message (source of the receipt). */
    from: string;
    /** Sender of the original message (destination of the receipt). */
    to: string;
    systemId?: string;
    err?: string;
  }): Promise<void> {
    const session = this.receiverFor(opts.systemId);
    const receipt = {
      messageId: opts.messageId,
      status: opts.status,
      source: opts.from,
      destination: opts.to,
      err: opts.err ?? (opts.status === 'DELIVERED' ? '000' : '001'),
    };
    await session.deliverReceipt(receipt);
    if (this.options.duplicateReceipts) await session.deliverReceipt(receipt);
  }

  private receiverFor(
    systemId: string | undefined,
    preferred?: ServerSession<unknown>,
  ): ServerSession<unknown> {
    if (preferred?.canDeliver && (systemId === undefined || preferred.systemId === systemId))
      return preferred;
    const session = this.sessions.find(
      (s) => s.canDeliver && (systemId === undefined || s.systemId === systemId),
    );
    if (!session) {
      throw new SmppError(
        'SMPP_TEST_NO_RECEIVER',
        `No receiver or transceiver session bound${systemId ? ` for ${systemId}` : ''}`,
      );
    }
    return session;
  }

  // ---------------------------------------------------------------- handling

  private async handle(
    command: TestSmscCommand,
    pdu: Pdu,
    session: ServerSession<unknown>,
    ctx: HandlerContext,
  ): Promise<number | Record<string, unknown>> {
    this.record(pdu);
    const isMessage = command === 'submit_sm' || command === 'data_sm';
    const entry = isMessage ? this.submittedEntry(command, pdu, session) : undefined;
    if (entry) this.submitted.push(entry);

    const fault = this.faults.get(command)?.shift();
    if (fault?.kind === 'disconnect') {
      session.destroy();
      return await this.never(ctx);
    }
    if (fault?.kind === 'drop') return await this.never(ctx);
    if (fault?.kind === 'delay') await this.sleep(fault.ms, ctx);
    const extra = this.congestion !== undefined ? { congestion_state: this.congestion } : {};
    if (fault?.kind === 'status') return fault.status;

    switch (command) {
      case 'submit_sm':
      case 'data_sm': {
        const messageId = this.options.messageId?.(this.nextId) ?? String(this.nextId);
        this.nextId++;
        if (entry) entry.messageId = messageId;
        if (command === 'submit_sm') this.scheduleReceipt(pdu as PduOf<'submit_sm'>, messageId, session);
        return { message_id: messageId, ...extra };
      }
      case 'submit_multi': {
        const messageId = this.options.messageId?.(this.nextId) ?? String(this.nextId);
        this.nextId++;
        return { message_id: messageId, unsuccess_sme: [], ...extra };
      }
      case 'query_sm':
        return {
          message_id: (pdu as PduOf<'query_sm'>).message_id,
          final_date: '',
          message_state: MESSAGE_STATE.DELIVERED,
          error_code: 0,
          ...extra,
        };
      default:
        return { ...extra };
    }
  }

  private submittedEntry(
    command: 'submit_sm' | 'data_sm',
    pdu: Pdu,
    session: ServerSession<unknown>,
  ): SubmittedMessage {
    const msg = pdu as PduOf<'submit_sm'>;
    const entry: SubmittedMessage = {
      command,
      pdu: pdu as PduOf<'submit_sm'>,
      from: msg.source_addr,
      to: msg.destination_addr,
      systemId: session.systemId,
    };
    try {
      const content = decodeMessageContent(pdu as Parameters<typeof decodeMessageContent>[0], {
        registry: encodings,
      });
      if (content.text !== undefined) entry.text = content.text;
    } catch {
      // binary or undecodable content: no text
    }
    return entry;
  }

  private scheduleReceipt(pdu: PduOf<'submit_sm'>, messageId: string, session: ServerSession<unknown>): void {
    if ((pdu.registered_delivery & 0x03) === 0) return;
    const policy = this.options.receipts ?? 'DELIVERED';
    const status = typeof policy === 'function' ? policy(pdu) : policy;
    if (status === 'none') return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      let target: ServerSession<unknown>;
      try {
        target = this.receiverFor(session.systemId, session);
      } catch {
        return; // nobody to receive it (transmitter only): dropped, as a real SMSC would keep it
      }
      const receipt = {
        messageId,
        status,
        source: pdu.destination_addr,
        destination: pdu.source_addr,
        err: status === 'DELIVERED' ? '000' : '001',
      };
      const send = async () => {
        await target.deliverReceipt(receipt);
        if (this.options.duplicateReceipts) await target.deliverReceipt(receipt);
      };
      send().catch((err: unknown) => this.errors.push(toError(err)));
    }, this.options.receiptDelay ?? 0);
    this.timers.add(timer);
  }

  /** Never settles until the session closes (then throws, so nothing is answered). */
  private never(ctx: HandlerContext): Promise<never> {
    return new Promise((_, reject) => {
      if (ctx.signal.aborted) reject(ctx.signal.reason);
      ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true });
    });
  }

  private sleep(ms: number, ctx: HandlerContext): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        resolve();
      }, ms);
      this.timers.add(timer);
      ctx.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  /** Forgets what was recorded and the pending faults (sessions stay connected). */
  reset(): void {
    this.received.length = 0;
    this.submitted.length = 0;
    this.binds.length = 0;
    this.errors.length = 0;
    this.faults.clear();
    this.congestion = undefined;
  }

  /** Stops the SMSC and closes every session. */
  async close(): Promise<void> {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    await this.server.close();
  }
}

/** Starts an in-process SMSC on a free port of 127.0.0.1. */
export function createTestSmsc(options: TestSmscOptions = {}): Promise<TestSmsc> {
  return new TestSmsc(options).listen();
}
