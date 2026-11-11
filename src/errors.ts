import { type StatusCategory, defaultStatusClassifier, statusName } from './protocol/status.js';

/** Classe de base de toutes les erreurs de la lib. */
export class SmppError extends Error {
  /** Code machine stable, utilisable dans un `switch`. */
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Réponse reçue avec un command_status ≠ 0. */
export class SmppStatusError extends SmppError {
  readonly status: number;
  readonly statusName: string;
  readonly category: StatusCategory;
  /** Commande de la requête qui a échoué. */
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

/** Timeout d'une opération (requête, bind, keepalive…). */
export class SmppTimeoutError extends SmppError {
  readonly kind: TimeoutKind;
  readonly timeoutMs: number;
  /** Pour une requête : `true` si le PDU avait été écrit sur le socket. */
  readonly written: boolean;

  constructor(kind: TimeoutKind, timeoutMs: number, detail?: string, written = false) {
    super('SMPP_TIMEOUT', `${detail ?? kind} timed out after ${timeoutMs} ms`);
    this.kind = kind;
    this.timeoutMs = timeoutMs;
    this.written = written;
  }
}

/** Connexion fermée alors qu'une requête était en attente. */
export class SmppConnectionClosedError extends SmppError {
  /**
   * `true` : le PDU a été écrit sur le socket, le SMSC l'a peut-être accepté (risque de doublon en cas de renvoi).
   * `false` : le PDU n'est jamais parti, il peut être renvoyé sans risque.
   */
  readonly written: boolean;

  constructor(written: boolean, message = 'Connection closed', options?: { cause?: unknown }) {
    super('SMPP_CONNECTION_CLOSED', `${message} (request ${written ? 'was' : 'was not'} written)`, options);
    this.written = written;
  }
}

/** File d'envoi pleine (REL-03). */
export class SmppQueueFullError extends SmppError {
  readonly maxQueueSize: number;
  constructor(maxQueueSize: number) {
    super('SMPP_QUEUE_FULL', `Send queue is full (${maxQueueSize} requests)`);
    this.maxQueueSize = maxQueueSize;
  }
}

/** Opération interdite dans l'état courant de la session (REL-01, SEC-07). */
export class SmppStateError extends SmppError {
  readonly state: string;
  readonly operation: string;
  /** Statut SMPP équivalent (ESME_RINVBNDSTS en général). */
  readonly status: number;

  constructor(operation: string, state: string, status = 0x00000004, reason?: string) {
    super('SMPP_INVALID_STATE', reason ?? `Cannot ${operation} in state ${state}`);
    this.state = state;
    this.operation = operation;
    this.status = status;
  }
}

/** PDU reçu invalide. */
export class SmppDecodeError extends SmppError {
  /** Statut SMPP à renvoyer au pair. */
  readonly status: number;
  /** En-tête lisible, si disponible (pour répondre avec le bon sequence_number). */
  readonly header?: { command_id: number; command_status: number; sequence_number: number } | undefined;
  /** Le flux est désynchronisé : la session doit être fermée. */
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

/** Paramètre invalide détecté avant l'envoi : aucun PDU invalide n'est écrit sur le réseau (SEC-03). */
export class SmppValidationError extends SmppError {
  readonly field: string | undefined;
  readonly status: number;

  constructor(message: string, field?: string, status = 0x00000008) {
    super('SMPP_VALIDATION', message);
    this.field = field;
    this.status = status;
  }
}

/** Échec partiel d'un envoi multi-segments. */
export class SmppMultipartError extends SmppError {
  /** Résultat par segment, dans l'ordre : message_id ou erreur. */
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
