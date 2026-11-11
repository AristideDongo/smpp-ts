// Test harness for the Jasmin suite:
// - `UpstreamSmsc`: the operator SMSC behind Jasmin, played by an smpp-ts SmppServer so the test
//   controls message ids, receipts, errors and MO traffic;
// - `provisionJasmin()`: configures Jasmin through jCli (users, connectors, filters, routes);
// - `TcpCutter`: a TCP relay between the client and Jasmin, to simulate network cuts.
import net from 'node:net';
import {
  COMMAND_STATUS,
  type DlrStatus,
  type PduOf,
  Reassembler,
  type ServerSession,
  SmppServer,
  decodeMessageContent,
} from '../../../src/index.js';
import { Jcli } from './jcli.js';

export const env = {
  jcliHost: process.env.JASMIN_JCLI_HOST ?? '127.0.0.1',
  jcliPort: Number(process.env.JASMIN_JCLI_PORT ?? 8990),
  smppHost: process.env.JASMIN_SMPP_HOST ?? '127.0.0.1',
  smppPort: Number(process.env.JASMIN_SMPP_PORT ?? 2775),
  /** Port of the upstream SMSC on the host, as Jasmin reaches it. */
  upstreamPort: Number(process.env.JASMIN_UPSTREAM_PORT ?? 2776),
  /** Host name of the test machine seen from the Jasmin container. */
  upstreamHost: process.env.JASMIN_UPSTREAM_HOST ?? 'host.docker.internal',
};

/** Accounts created on Jasmin. SMPP passwords are 8 characters at most. */
export const ACCOUNTS = {
  /** Default account: unlimited, MO routed to it. */
  main: { system_id: 'smppts', password: 'secret' },
  /** smpps_throughput = 1 message/s: ESME_RTHROTTLED beyond. */
  slow: { system_id: 'smppslow', password: 'secret' },
  /** Destination filter ^225: ESME_RINVDSTADR otherwise. */
  filtered: { system_id: 'smppfilt', password: 'secret' },
} as const;

/**
 * Destination prefixes that select an upstream behaviour; tests append 4 unique digits
 * (`dest(PREFIX.x)`) so that the records of two tests never mix.
 */
export const PREFIX = {
  delivered: '225070000',
  undeliverable: '225070001',
  expired: '225070002',
  /**
   * The upstream SMSC answers ESME_RTHROTTLED twice, then accepts: Jasmin must retry.
   * Routed to its own connector (`upstream_thr`): Jasmin waits 30 s between retries and holds
   * the connector's queue meanwhile, which would delay every other test.
   */
  throttledUpstream: '225070004',
  /** Routed to the `upstream_hex` connector: hex id in submit_sm_resp, decimal in the receipt. */
  hexIds: '225079900',
} as const;

/** Rejected by the `filtered` account's filter (^225). */
export const OUTSIDE_FILTER = '33600000000';

let counter = Math.floor(Math.random() * 5000);
/** Unique destination with the given behaviour prefix. */
export function dest(prefix: string): string {
  counter = (counter + 1) % 10_000;
  return prefix + String(counter).padStart(4, '0');
}

export interface UpstreamSubmit {
  /** Connector that sent it (upstream bind system_id). */
  connector: string;
  pdu: PduOf<'submit_sm'>;
  /** Id returned in submit_sm_resp (undefined if refused). */
  messageId?: string;
  status: number;
}

/** Upstream SMSC (the "operator" behind Jasmin). */
export class UpstreamSmsc {
  readonly submits: UpstreamSubmit[] = [];
  readonly server: SmppServer;
  private nextId = 1_000_000;
  private readonly attempts = new Map<string, number>();
  private readonly waiters = new Set<() => void>();
  /** Set to `true` to keep Jasmin from binding (connection refused at bind). */
  refuseBinds = false;

  constructor() {
    this.server = new SmppServer<unknown>({
      authenticate: ({ system_id, password }) =>
        !this.refuseBinds && CONNECTORS.some((c) => c.username === system_id) && password === 'jpwd',
      handlers: { submit_sm: (pdu, ss) => this.onSubmit(pdu, ss) },
      // Jasmin's connector sends enquire_link every 30 s; no idle timeout during a test run.
      idleTimeout: 0,
      maxSessionsPerSystemId: 4,
    });
  }

  async listen(): Promise<void> {
    await this.server.listen(env.upstreamPort, '0.0.0.0');
  }

  close(): Promise<void> {
    return this.server.close();
  }

  bound(connector: string): boolean {
    return this.server.sessionsFor(connector).some((s) => s.canDeliver);
  }

  /** Drops every connection from Jasmin (simulates an upstream network cut). */
  dropConnections(): void {
    for (const ss of this.server.sessions) ss.destroy();
  }

  /** Waits until `pred` holds, re-checked on every submit. */
  async waitFor<T>(
    pred: () => T | undefined | false | Promise<T | undefined | false>,
    timeoutMs = 20_000,
    what = 'condition',
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await pred();
      if (v) return v;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 100);
        this.waiters.add(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  /** Submits received for a destination, in arrival order (accepted ones only). */
  acceptedFor(destination: string): UpstreamSubmit[] {
    return this.submits.filter((s) => s.pdu.destination_addr === destination && s.status === 0);
  }

  /** Reassembles the texts received for a destination (concatenated parts or single messages). */
  textsFor(destination: string): string[] {
    const texts: string[] = [];
    const reassembler = new Reassembler();
    for (const { pdu } of this.acceptedFor(destination)) {
      const content = decodeMessageContent(pdu);
      if (!content.concat) {
        texts.push(content.text ?? '');
        continue;
      }
      const done = reassembler.add({
        source: pdu.source_addr,
        destination: pdu.destination_addr,
        concat: content.concat,
        body: content.body,
        dataCoding: pdu.data_coding,
        ...(content.udh?.shift ? { shift: content.udh.shift } : {}),
        ...(content.udh?.locking ? { locking: content.udh.locking } : {}),
        meta: undefined,
      });
      if (done) texts.push(done.text ?? '');
    }
    reassembler.clear();
    return texts;
  }

  private onSubmit(pdu: PduOf<'submit_sm'>, ss: ServerSession<unknown>) {
    const connector = ss.systemId ?? '?';
    const dest = pdu.destination_addr;
    const record: UpstreamSubmit = { connector, pdu, status: 0 };
    this.submits.push(record);
    this.notify();

    if (dest.startsWith(PREFIX.throttledUpstream)) {
      const n = (this.attempts.get(dest) ?? 0) + 1;
      this.attempts.set(dest, n);
      if (n <= 2) {
        record.status = COMMAND_STATUS.ESME_RTHROTTLED;
        return COMMAND_STATUS.ESME_RTHROTTLED;
      }
    }

    const id = this.nextId++;
    // `jasminhx` plays an SMSC that answers in hexadecimal and reports in decimal (dlr_msgid 1).
    const respId = connector === 'jasminhx' ? id.toString(16) : String(id);
    record.messageId = respId;

    const status: DlrStatus | undefined = dest.startsWith(PREFIX.undeliverable)
      ? 'UNDELIVERABLE'
      : dest.startsWith(PREFIX.expired)
        ? 'EXPIRED'
        : 'DELIVERED';
    if (pdu.registered_delivery & 0x03) {
      setTimeout(() => {
        void ss
          .deliverReceipt({
            messageId: String(id),
            status,
            source: pdu.destination_addr,
            destination: pdu.source_addr,
            ...(status === 'UNDELIVERABLE' ? { err: '001' } : {}),
          })
          .catch(() => {});
      }, 200);
    }
    return { message_id: respId };
  }

  private notify(): void {
    for (const w of this.waiters) w();
    this.waiters.clear();
  }
}

/** Jasmin SMPP client connectors, each binding to the upstream SMSC with its own system_id. */
export const CONNECTORS = [
  { cid: 'upstream', username: 'jasmin', extra: {} },
  { cid: 'upstream_hex', username: 'jasminhx', extra: { dlr_msgid: 1 } },
  { cid: 'upstream_thr', username: 'jasminth', extra: {} },
] as const;

/**
 * Configures Jasmin: users, filters and routes are recreated, connectors are created once and
 * then updated and restarted (removing and re-adding a connector with the same cid can make
 * Jasmin 0.11 reject the next queued messages with an AttributeError).
 */
export async function provisionJasmin(): Promise<void> {
  const cli = await Jcli.connect({ host: env.jcliHost, port: env.jcliPort });
  try {
    await cli.run('mtrouter -f');
    await cli.run('morouter -f');
    for (const fid of ['hexdst', 'thrdst']) await cli.run(`filter -r ${fid}`);
    for (const uid of ['smppts', 'smppslow', 'smppfilt']) await cli.run(`user -r ${uid}`);
    await cli.run('group -r smppts');

    await cli.configure('group -a', { gid: 'smppts' });
    const user = (
      uid: string,
      a: { system_id: string; password: string },
      extra: Record<string, string> = {},
    ) =>
      cli.configure('user -a', { username: a.system_id, password: a.password, gid: 'smppts', uid, ...extra });
    await user('smppts', ACCOUNTS.main);
    await user('smppslow', ACCOUNTS.slow, { 'mt_messaging_cred quota smpps_throughput': '1' });
    await user('smppfilt', ACCOUNTS.filtered, { 'mt_messaging_cred valuefilter dst_addr': '^225.*' });

    const existing = await cli.run('smppccm -l');
    for (const { cid, username, extra } of CONNECTORS) {
      const settings = {
        host: env.upstreamHost,
        port: env.upstreamPort,
        username,
        password: 'jpwd',
        bind: 'transceiver',
        submit_throughput: 0,
        con_fail_delay: 1,
        con_loss_delay: 1,
        ...extra,
      };
      if (new RegExp(`#${cid}\\s`).test(existing)) {
        await cli.run(`smppccm -0 ${cid}`);
        await cli.configure(`smppccm -u ${cid}`, settings);
      } else {
        await cli.configure('smppccm -a', { cid, ...settings });
      }
    }

    await cli.configure('filter -a', {
      fid: 'hexdst',
      type: 'DestinationAddrFilter',
      destination_addr: `^${PREFIX.hexIds}`,
    });
    await cli.configure('filter -a', {
      fid: 'thrdst',
      type: 'DestinationAddrFilter',
      destination_addr: `^${PREFIX.throttledUpstream}`,
    });
    await cli.configure('mtrouter -a', {
      type: 'StaticMTRoute',
      order: 20,
      filters: 'thrdst',
      connector: 'smppc(upstream_thr)',
      rate: '0.00',
    });
    await cli.configure('mtrouter -a', {
      type: 'StaticMTRoute',
      order: 10,
      filters: 'hexdst',
      connector: 'smppc(upstream_hex)',
      rate: '0.00',
    });
    await cli.configure('mtrouter -a', { type: 'DefaultRoute', connector: 'smppc(upstream)', rate: '0.00' });
    await cli.configure('morouter -a', { type: 'DefaultRoute', connector: 'smpps(smppts)' });

    for (const { cid } of CONNECTORS) await cli.run(`smppccm -1 ${cid}`);
  } finally {
    await cli.close();
  }
}

/**
 * Stops the connectors, so that they do not spin in a reconnect loop once the upstream SMSC is
 * gone: a connector stopped and restarted during that loop may reject its first message.
 */
export async function stopConnectors(): Promise<void> {
  const cli = await Jcli.connect({ host: env.jcliHost, port: env.jcliPort });
  try {
    for (const { cid } of CONNECTORS) await cli.run(`smppccm -0 ${cid}`);
  } finally {
    await cli.close();
  }
}

/** TCP relay to Jasmin; `cut()` drops every relayed connection at once. */
export class TcpCutter {
  private readonly server: net.Server;
  private readonly pairs = new Set<[net.Socket, net.Socket]>();
  port = 0;

  constructor(
    private readonly targetHost: string,
    private readonly targetPort: number,
  ) {
    this.server = net.createServer((client) => {
      const upstream = net.connect(this.targetPort, this.targetHost);
      const pair: [net.Socket, net.Socket] = [client, upstream];
      this.pairs.add(pair);
      const drop = () => {
        client.destroy();
        upstream.destroy();
        this.pairs.delete(pair);
      };
      client.on('error', drop).on('close', drop);
      upstream.on('error', drop).on('close', drop);
      client.pipe(upstream);
      upstream.pipe(client);
    });
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as net.AddressInfo).port;
    return this.port;
  }

  /** Resets every relayed connection (both sides see the connection drop). */
  cut(): number {
    const n = this.pairs.size;
    for (const [a, b] of this.pairs) {
      a.resetAndDestroy();
      b.destroy();
    }
    this.pairs.clear();
    return n;
  }

  close(): Promise<void> {
    this.cut();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
