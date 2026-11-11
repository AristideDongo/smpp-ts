import { COMMANDS } from './protocol/commands.js';
import { TLVS } from './protocol/tlv.js';

/** Injectable logger interface, compatible with pino and console. */
export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const noop = () => {};

/** Silent logger (default). */
export const silentLogger: Logger = { debug: noop, info: noop, warn: noop, error: noop };

/**
 * Adapts a pino-style logger (`logger.info(meta, msg)`) or console (`console.info(msg, meta)`).
 * For console, pass `console` directly: its (msg, meta) signature is compatible.
 */
export function pinoAdapter(pino: {
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}): Logger {
  return {
    debug: (msg, meta) => pino.debug(meta ?? {}, msg),
    info: (msg, meta) => pino.info(meta ?? {}, msg),
    warn: (msg, meta) => pino.warn(meta ?? {}, msg),
    error: (msg, meta) => pino.error(meta ?? {}, msg),
  };
}

export interface RedactOptions {
  /** Masks `short_message` and `message_payload` (personal data). Default: false. */
  redactContent?: boolean;
  /** Partially masks numbers (`source_addr`, `destination_addr`…). Default: false. */
  redactNumbers?: boolean;
}

export const REDACTED = '***';

const SENSITIVE_FIELDS = new Set<string>();
const CONTENT_FIELDS = new Set<string>();
const NUMBER_FIELDS = new Set<string>(['dl_name']);

for (const def of Object.values(COMMANDS)) {
  for (const p of def.params as readonly {
    name: string;
    sensitive?: boolean;
    content?: boolean;
    number?: boolean;
  }[]) {
    if (p.sensitive) SENSITIVE_FIELDS.add(p.name);
    if (p.content) CONTENT_FIELDS.add(p.name);
    if (p.number) NUMBER_FIELDS.add(p.name);
  }
}
for (const [name, def] of Object.entries(TLVS) as [string, { content?: boolean; sensitive?: boolean }][]) {
  if (def.content) CONTENT_FIELDS.add(name);
  if (def.sensitive) SENSITIVE_FIELDS.add(name);
}
NUMBER_FIELDS.add('callback_num');

/** Partially masks a number: keeps the first 4 and last 2 characters. */
export function maskNumber(value: string): string {
  if (value.length <= 6) return '*'.repeat(value.length);
  return value.slice(0, 4) + '*'.repeat(value.length - 6) + value.slice(-2);
}

function redactValue(key: string, value: unknown, opts: RedactOptions): unknown {
  if (SENSITIVE_FIELDS.has(key)) return REDACTED;
  if (opts.redactContent && CONTENT_FIELDS.has(key)) return REDACTED;
  if (opts.redactNumbers && NUMBER_FIELDS.has(key)) {
    if (typeof value === 'string') return maskNumber(value);
    if (Buffer.isBuffer(value)) return REDACTED;
  }
  if (Buffer.isBuffer(value))
    return `<${value.length} bytes:${value.subarray(0, 64).toString('hex')}${value.length > 64 ? '…' : ''}>`;
  if (Array.isArray(value)) return value.map((v) => redactValue(key, v, opts));
  if (value && typeof value === 'object') return redactObject(value as Record<string, unknown>, opts);
  return value;
}

function redactObject(obj: Record<string, unknown>, opts: RedactOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = redactValue(k, v, opts);
  return out;
}

/**
 * Copy of a PDU (or of parameters) ready to log:
 * secrets are always masked, content and numbers depending on options (SEC-02).
 */
export function redactPdu(pdu: object, opts: RedactOptions = {}): Record<string, unknown> {
  return redactObject(pdu as Record<string, unknown>, opts);
}

/** True when the field is declared sensitive in the protocol table. */
export function isSensitiveField(name: string): boolean {
  return SENSITIVE_FIELDS.has(name);
}
