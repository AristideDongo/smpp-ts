import type { PduParams } from '../codec/pdu.js';
import { SmppStateError } from '../errors.js';
import type { RequestCommandName } from '../protocol/commands.js';
import { ESM_CLASS } from '../protocol/constants.js';
import type { RequestOptions, ResponseOf, Session } from '../session/session.js';
import type { BindMode, SessionState } from '../session/state-machine.js';
import { type DlrStatus, dlrStatusToMessageState, formatDlr } from '../utils/dlr.js';

/**
 * TLS details of a connection, for client-certificate authentication (mTLS).
 *
 * Two ways to use it, both with `tls.requestCert: true`:
 * - `tls.rejectUnauthorized: true` (the default): TLS itself refuses a client whose certificate is
 *   not signed by one of the configured CAs, so `authenticate()` only ever sees `authorized: true`
 *   and pins the identity it expects (`subject.CN`, `fingerprint256`);
 * - `tls.rejectUnauthorized: false`: every client completes the handshake and the hook decides. Node
 *   then skips chain verification, so `authorized` is **false even for a valid certificate**: pin
 *   `fingerprint256` (or verify the chain yourself), never trust `subject` alone.
 */
export interface TlsPeerInfo {
  /**
   * `true` when the handshake verified the client certificate against the configured CAs.
   * Always `false` with `tls.rejectUnauthorized: false`, which turns verification off (see above).
   */
  authorized: boolean;
  /** Why the certificate was refused, when the handshake did verify it. */
  authorizationError?: string;
  /** Negotiated protocol, e.g. `TLSv1.3`. */
  protocol?: string;
  /** Negotiated cipher suite name. */
  cipher?: string;
  /** Client certificate subject, empty when the client sent none. */
  subject?: Record<string, unknown>;
  /** Issuer of the client certificate. */
  issuer?: Record<string, unknown>;
  /** Certificate fingerprint (SHA-256). */
  fingerprint256?: string;
  /** `notAfter` of the client certificate. */
  validTo?: string;
}

/** Server-side session, exposed to handlers and to the authentication hook. */
export class ServerSession<Ctx = unknown> {
  /** Bind mode, once authenticated. */
  mode: BindMode | undefined;
  /** Context returned by `authenticate`. */
  context: Ctx | undefined;
  /** `interface_version` announced by the peer in its bind (0x34 for v3.4, 0x50 for v5.0). */
  interfaceVersion: number | undefined;

  constructor(
    readonly session: Session,
    /** Client address (the real one behind Proxy Protocol). */
    readonly remoteAddress: string,
    /** TLS details, `undefined` on a plain TCP connection. */
    readonly tls?: TlsPeerInfo,
  ) {}

  get id(): string {
    return this.session.id;
  }

  get systemId(): string | undefined {
    return this.session.systemId;
  }

  get state(): SessionState {
    return this.session.state;
  }

  get canDeliver(): boolean {
    return this.state === 'BOUND_RX' || this.state === 'BOUND_TRX';
  }

  /** Sends a deliver_sm to the client. */
  deliver(params: PduParams<'deliver_sm'>, options?: RequestOptions): Promise<ResponseOf<'deliver_sm'>> {
    if (!this.canDeliver) {
      return Promise.reject(new SmppStateError('deliver_sm', this.state));
    }
    return this.session.request('deliver_sm', params, options);
  }

  /** Sends a delivery receipt (standard text + receipted_message_id / message_state TLVs). */
  deliverReceipt(opts: {
    messageId: string;
    status: DlrStatus;
    source: string;
    destination: string;
    err?: string;
    text?: string;
  }): Promise<ResponseOf<'deliver_sm'>> {
    const text = formatDlr({
      id: opts.messageId,
      status: opts.status,
      ...(opts.err !== undefined ? { err: opts.err } : {}),
      ...(opts.text !== undefined ? { text: opts.text } : {}),
    });
    return this.deliver({
      source_addr: opts.source,
      destination_addr: opts.destination,
      esm_class: ESM_CLASS.MC_DELIVERY_RECEIPT,
      short_message: Buffer.from(text, 'latin1'),
      receipted_message_id: opts.messageId,
      message_state: dlrStatusToMessageState(opts.status),
    });
  }

  /** Generic request to the client. */
  request<C extends RequestCommandName>(
    command: C,
    params?: PduParams<C>,
    options?: RequestOptions,
  ): Promise<ResponseOf<C>> {
    return this.session.request(command, params, options);
  }

  /** Graceful close (unbind, then close). */
  close(): Promise<void> {
    return this.session.close();
  }

  destroy(): void {
    this.session.destroy();
  }
}
