import type { PduParams } from '../codec/pdu.js';
import { SmppStateError } from '../errors.js';
import type { RequestCommandName } from '../protocol/commands.js';
import { ESM_CLASS } from '../protocol/constants.js';
import type { RequestOptions, ResponseOf, Session } from '../session/session.js';
import type { BindMode, SessionState } from '../session/state-machine.js';
import { type DlrStatus, dlrStatusToMessageState, formatDlr } from '../utils/dlr.js';

/** Server-side session, exposed to handlers and to the authentication hook. */
export class ServerSession<Ctx = unknown> {
  /** Bind mode, once authenticated. */
  mode: BindMode | undefined;
  /** Context returned by `authenticate`. */
  context: Ctx | undefined;

  constructor(
    readonly session: Session,
    /** Client address (the real one behind Proxy Protocol). */
    readonly remoteAddress: string,
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
