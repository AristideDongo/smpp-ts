import { type StatusCategory, defaultStatusClassifier, statusName } from './protocol/status.js';

/** Base class of every error thrown by the library. */
export class SmppError extends Error {
  /** Stable machine-readable code, usable in a `switch`. */
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Response received with a non-zero command_status. */
export class SmppStatusError extends SmppError {
  readonly status: number;
  readonly statusName: string;
  readonly category: StatusCategory;
  /** Command of the request that failed. */
  readonly command: string;

  constructor(command: string, status: number, category: StatusCategory = defaultStatusClassifier(status)) {
    const name = statusName(status);
    super('SMPP_STATUS', `${command} rejected with ${name} (0x${status.toString(16).padStart(8, '0')})`);
    this.status = status;
    this.statusName = name;
    this.category = category;
    this.command = command;
  }
}

export type TimeoutKind =
  | 'connect'
  | 'bind'
  | 'request'
  | 'enquire_link'
  | 'unbind'
  | 'drain'
  | 'proxy_header';

/** An operation timed out (request, bind, keepalive…). */
export class SmppTimeoutError extends SmppError {
  readonly kind: TimeoutKind;
  readonly timeoutMs: number;
  /** For a request: `true` if the PDU had been written to the socket. */
  readonly written: boolean;

  constructor(kind: TimeoutKind, timeoutMs: number, detail?: string, written = false) {
    super('SMPP_TIMEOUT', `${detail ?? kind} timed out after ${timeoutMs} ms`);
    this.kind = kind;
    this.timeoutMs = timeoutMs;
    this.written = written;
  }
}

/** The connection closed while a request was pending. */
export class SmppConnectionClosedError extends SmppError {
  /**
   * `true`: the PDU was written to the socket and the SMSC may have accepted it (resending may duplicate it).
   * `false`: the PDU never left and can be resent safely.
   */
  readonly written: boolean;

  constructor(written: boolean, message = 'Connection closed', options?: { cause?: unknown }) {
    super('SMPP_CONNECTION_CLOSED', `${message} (request ${written ? 'was' : 'was not'} written)`, options);
    this.written = written;
  }
}

/** The send queue is full (REL-03). */
export class SmppQueueFullError extends SmppError {
  readonly maxQueueSize: number;
  constructor(maxQueueSize: number) {
    super('SMPP_QUEUE_FULL', `Send queue is full (${maxQueueSize} requests)`);
    this.maxQueueSize = maxQueueSize;
  }
}

/** Operation not allowed in the current session state (REL-01, SEC-07). */
export class SmppStateError extends SmppError {
  readonly state: string;
  readonly operation: string;
  /** Equivalent SMPP status (usually ESME_RINVBNDSTS). */
  readonly status: number;

  constructor(operation: string, state: string, status = 0x00000004, reason?: string) {
    super('SMPP_INVALID_STATE', reason ?? `Cannot ${operation} in state ${state}`);
    this.state = state;
    this.operation = operation;
    this.status = status;
  }
}

/** Invalid PDU received. */
export class SmppDecodeError extends SmppError {
  /** SMPP status to send back to the peer. */
  readonly status: number;
  /** Readable header, if any (to answer with the right sequence_number). */
  readonly header?: { command_id: number; command_status: number; sequence_number: number } | undefined;
  /** The stream is out of sync: the session must be closed. */
  readonly fatal: boolean;

  constructor(
    status: number,
    message: string,
    opts: { header?: SmppDecodeError['header']; fatal?: boolean; cause?: unknown } = {},
  ) {
    super('SMPP_DECODE', message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.status = status;
    this.header = opts.header;
    this.fatal = opts.fatal ?? false;
  }
}

/** Invalid parameter caught before sending: no invalid PDU is ever written to the network (SEC-03). */
export class SmppValidationError extends SmppError {
  readonly field: string | undefined;
  readonly status: number;

  constructor(message: string, field?: string, status = 0x00000008) {
    super('SMPP_VALIDATION', message);
    this.field = field;
    this.status = status;
  }
}

/** Partial failure of a multi-segment send. */
export class SmppMultipartError extends SmppError {
  /** Result per segment, in order: message_id or error. */
  readonly results: ReadonlyArray<{ messageId: string } | { error: Error }>;

  constructor(results: ReadonlyArray<{ messageId: string } | { error: Error }>) {
    const failed = results.filter((r) => 'error' in r).length;
    super('SMPP_MULTIPART', `${failed}/${results.length} segment(s) failed`);
    this.results = results;
  }
}

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
