import { ESM_CLASS, MESSAGE_STATE } from '../protocol/constants.js';
import type { NetworkErrorCode } from '../protocol/tlv.js';

export type DlrStatus =
  | 'DELIVERED'
  | 'EXPIRED'
  | 'DELETED'
  | 'UNDELIVERABLE'
  | 'ACCEPTED'
  | 'UNKNOWN'
  | 'REJECTED'
  | 'ENROUTE'
  | 'SKIPPED';

/** Fields extracted from a receipt text ("id:… sub:… dlvrd:… …" format). */
export interface ParsedDlrText {
  id?: string;
  sub?: string;
  dlvrd?: string;
  submitDate?: Date;
  doneDate?: Date;
  /** Raw status (e.g. `DELIVRD`). */
  stat?: string;
  err?: string;
  text?: string;
  /** Every key/value pair found, keys lowercased. */
  fields: Record<string, string>;
}

export interface DeliveryReport {
  /** Message identifier, normalized according to `messageIdFormat`. */
  messageId: string;
  /** Identifier as received. */
  rawMessageId: string;
  status: DlrStatus;
  /** Raw status (`stat:` text or message_state TLV value). */
  rawStatus: string;
  errorCode?: string;
  networkError?: NetworkErrorCode;
  submitDate?: Date;
  doneDate?: Date;
  submitted?: number;
  delivered?: number;
  text?: string;
  source: string;
  destination: string;
}

const STATUS_ALIASES: Record<string, DlrStatus> = {
  DELIVRD: 'DELIVERED',
  DELIVERED: 'DELIVERED',
  EXPIRED: 'EXPIRED',
  DELETED: 'DELETED',
  UNDELIV: 'UNDELIVERABLE',
  UNDELIVERABLE: 'UNDELIVERABLE',
  ACCEPTD: 'ACCEPTED',
  ACCEPTED: 'ACCEPTED',
  UNKNOWN: 'UNKNOWN',
  REJECTD: 'REJECTED',
  REJECTED: 'REJECTED',
  ENROUTE: 'ENROUTE',
  SKIPPED: 'SKIPPED',
  FAILED: 'UNDELIVERABLE',
  FAIL: 'UNDELIVERABLE',
};

const STATE_BY_VALUE: Record<number, DlrStatus> = {
  [MESSAGE_STATE.ENROUTE]: 'ENROUTE',
  [MESSAGE_STATE.DELIVERED]: 'DELIVERED',
  [MESSAGE_STATE.EXPIRED]: 'EXPIRED',
  [MESSAGE_STATE.DELETED]: 'DELETED',
  [MESSAGE_STATE.UNDELIVERABLE]: 'UNDELIVERABLE',
  [MESSAGE_STATE.ACCEPTED]: 'ACCEPTED',
  [MESSAGE_STATE.UNKNOWN]: 'UNKNOWN',
  [MESSAGE_STATE.REJECTED]: 'REJECTED',
  [MESSAGE_STATE.SKIPPED]: 'SKIPPED',
};

/** Normalizes a text status (`DELIVRD`, `undeliv`…) or a message_state value. */
export function normalizeDlrStatus(raw: string | number): DlrStatus {
  if (typeof raw === 'number') return STATE_BY_VALUE[raw] ?? 'UNKNOWN';
  return STATUS_ALIASES[raw.trim().toUpperCase()] ?? 'UNKNOWN';
}

/**
 * Receipt date `YYMMDDhhmm[ss]`. The time zone is not transmitted, so the date is read as UTC.
 * Returns `undefined` for an invalid format.
 */
export function parseDlrDate(value: string): Date | undefined {
  const m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?$/.exec(value.trim());
  if (!m) return undefined;
  const [, yy, mo, dd, hh, mi, ss] = m;
  const d = new Date(
    Date.UTC(2000 + Number(yy), Number(mo) - 1, Number(dd), Number(hh), Number(mi), Number(ss ?? 0)),
  );
  return Number.isNaN(d.getTime()) || d.getUTCMonth() !== Number(mo) - 1 ? undefined : d;
}

// Recognized keys, including variants seen at operators.
const KEY_PATTERN = /(id|sub|dlvrd|submit[ _]?date|done[ _]?date|stat|err|text)\s*:/gi;

/** Parses a delivery receipt text. Tolerates variants (case, spacing, order, missing keys). */
export function parseDlr(text: string): ParsedDlrText | undefined {
  const matches = [...text.matchAll(KEY_PATTERN)].filter((m) => {
    // A key must start the text or follow a separator (avoids a nested "text:…id:…").
    const before = m.index === 0 ? ' ' : text[m.index - 1];
    return before === ' ' || before === '\t' || before === '\n' || before === ',' || before === ';';
  });
  if (matches.length === 0) return undefined;

  const fields: Record<string, string> = {};
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const key = m[1]!.toLowerCase().replace(/[ _]/g, '');
    if (key in fields) continue;
    const start = m.index + m[0].length;
    // `text:` takes the rest; other keys stop at the next key.
    const next = key === 'text' ? undefined : matches[i + 1];
    const end = next ? next.index : text.length;
    fields[key] = text.slice(start, end).trim().replace(/[,;]$/, '');
    if (key === 'text') break;
  }
  if (!('id' in fields) && !('stat' in fields)) return undefined;

  const result: ParsedDlrText = { fields };
  if (fields.id !== undefined) result.id = fields.id;
  if (fields.sub !== undefined) result.sub = fields.sub;
  if (fields.dlvrd !== undefined) result.dlvrd = fields.dlvrd;
  if (fields.stat !== undefined) result.stat = fields.stat;
  if (fields.err !== undefined) result.err = fields.err;
  if (fields.text !== undefined) result.text = fields.text;
  const submit = fields.submitdate !== undefined ? parseDlrDate(fields.submitdate) : undefined;
  const done = fields.donedate !== undefined ? parseDlrDate(fields.donedate) : undefined;
  if (submit) result.submitDate = submit;
  if (done) result.doneDate = done;
  return result;
}

export type MessageIdFormat = 'as-is' | 'hex-to-dec' | 'dec-to-hex';

/**
 * Normalizes a message_id: some SMSCs return the ID in hexadecimal in the DLR
 * and in decimal in submit_sm_resp (or the other way around).
 */
export function normalizeMessageId(id: string, format: MessageIdFormat = 'as-is'): string {
  const trimmed = id.trim();
  try {
    if (format === 'hex-to-dec' && /^[0-9a-f]+$/i.test(trimmed)) return BigInt(`0x${trimmed}`).toString(10);
    if (format === 'dec-to-hex' && /^\d+$/.test(trimmed)) return BigInt(trimmed).toString(16);
  } catch {
    // out-of-range value: returned as is
  }
  return trimmed;
}

export interface DlrPduLike {
  esm_class: number;
  source_addr: string;
  destination_addr: string;
  receipted_message_id?: string;
  message_state?: number;
  network_error_code?: NetworkErrorCode;
}

/** True when a deliver_sm / data_sm is a delivery receipt. */
export function isDeliveryReceipt(pdu: { esm_class: number; receipted_message_id?: string }): boolean {
  const type = pdu.esm_class & ESM_CLASS.TYPE_MASK;
  return (
    type === ESM_CLASS.MC_DELIVERY_RECEIPT ||
    type === ESM_CLASS.INTERMEDIATE_DELIVERY_NOTIFICATION ||
    (type === 0 && pdu.receipted_message_id !== undefined)
  );
}

/**
 * Builds a normalized receipt. The `receipted_message_id`, `message_state`
 * and `network_error_code` TLVs take precedence over the text when present.
 */
export function buildDeliveryReport(
  pdu: DlrPduLike,
  text: string | undefined,
  messageIdFormat: MessageIdFormat = 'as-is',
): DeliveryReport | undefined {
  const parsed = text ? parseDlr(text) : undefined;
  const rawId = pdu.receipted_message_id ?? parsed?.id;
  if (rawId === undefined) return undefined;

  const rawStatus = pdu.message_state !== undefined ? String(pdu.message_state) : (parsed?.stat ?? 'UNKNOWN');
  const status =
    pdu.message_state !== undefined ? normalizeDlrStatus(pdu.message_state) : normalizeDlrStatus(rawStatus);

  const report: DeliveryReport = {
    messageId: normalizeMessageId(rawId, messageIdFormat),
    rawMessageId: rawId,
    status,
    rawStatus,
    source: pdu.source_addr,
    destination: pdu.destination_addr,
  };
  if (parsed?.err !== undefined) report.errorCode = parsed.err;
  if (pdu.network_error_code) report.networkError = pdu.network_error_code;
  if (parsed?.submitDate) report.submitDate = parsed.submitDate;
  if (parsed?.doneDate) report.doneDate = parsed.doneDate;
  if (parsed?.sub !== undefined && /^\d+$/.test(parsed.sub)) report.submitted = Number(parsed.sub);
  if (parsed?.dlvrd !== undefined && /^\d+$/.test(parsed.dlvrd)) report.delivered = Number(parsed.dlvrd);
  if (parsed?.text !== undefined) report.text = parsed.text;
  return report;
}

const STATUS_TEXT: Record<DlrStatus, string> = {
  DELIVERED: 'DELIVRD',
  EXPIRED: 'EXPIRED',
  DELETED: 'DELETED',
  UNDELIVERABLE: 'UNDELIV',
  ACCEPTED: 'ACCEPTD',
  UNKNOWN: 'UNKNOWN',
  REJECTED: 'REJECTD',
  ENROUTE: 'ENROUTE',
  SKIPPED: 'SKIPPED',
};

const STATE_VALUE: Record<DlrStatus, number> = {
  DELIVERED: MESSAGE_STATE.DELIVERED,
  EXPIRED: MESSAGE_STATE.EXPIRED,
  DELETED: MESSAGE_STATE.DELETED,
  UNDELIVERABLE: MESSAGE_STATE.UNDELIVERABLE,
  ACCEPTED: MESSAGE_STATE.ACCEPTED,
  UNKNOWN: MESSAGE_STATE.UNKNOWN,
  REJECTED: MESSAGE_STATE.REJECTED,
  ENROUTE: MESSAGE_STATE.ENROUTE,
  SKIPPED: MESSAGE_STATE.SKIPPED,
};

/** message_state value matching a normalized status. */
export function dlrStatusToMessageState(status: DlrStatus): number {
  return STATE_VALUE[status];
}

function formatDlrDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

export interface FormatDlrOptions {
  id: string;
  status: DlrStatus;
  submitDate?: Date;
  doneDate?: Date;
  err?: string;
  submitted?: number;
  delivered?: number;
  /** Start of the original text (20 characters max). */
  text?: string;
}

/** Produces receipt text in the common format (server / simulator side). */
export function formatDlr(o: FormatDlrOptions): string {
  const now = new Date();
  const sub = String(o.submitted ?? 1).padStart(3, '0');
  const dlvrd = String(o.delivered ?? (o.status === 'DELIVERED' ? 1 : 0)).padStart(3, '0');
  return (
    `id:${o.id} sub:${sub} dlvrd:${dlvrd} submit date:${formatDlrDate(o.submitDate ?? now)} ` +
    `done date:${formatDlrDate(o.doneDate ?? now)} stat:${STATUS_TEXT[o.status]} err:${o.err ?? '000'} text:${(o.text ?? '').slice(0, 20)}`
  );
}
