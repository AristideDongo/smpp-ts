import { canEncodeGsm7 } from '../encoding/gsm7.js';
import { SmppValidationError } from '../errors.js';
import { NPI, TON } from '../protocol/constants.js';
import { COMMAND_STATUS } from '../protocol/status.js';

/** Normalization and validation options for `sendText` addresses. */
export interface AddressOptions {
  /**
   * Strips separators from numbers (spaces, dashes, dots, parentheses, slashes)
   * and turns the international prefix (`00…`) into TON international. Default: `true`.
   */
  normalize?: boolean;
  /**
   * International call prefix converted to TON 1 (e.g. `00` in Europe and Africa,
   * `011` in North America). `false` to disable. Default: `'00'`.
   */
  internationalPrefix?: string | false;
  /**
   * Maximum length of an alphanumeric sender. The GSM standard (3GPP TS 23.040) limits
   * the TP-OA field to 11 characters: beyond that, networks truncate or reject the message.
   * Default: 11.
   */
  maxAlphanumericLength?: number;
  /**
   * Validates the alphanumeric sender (length, GSM 7-bit characters).
   * `false` to let through an off-standard value an operator accepts. Default: `true`.
   */
  validateSender?: boolean;
}

export interface ResolvedAddress {
  addr: string;
  ton: number;
  npi: number;
}

/** Maximum length of an E.164 number (country code included). */
const E164_MAX_DIGITS = 15;
/** Below this, a number starting with `00` is treated as a short code, not an international number. */
const MIN_INTERNATIONAL_DIGITS = 7;
const SEPARATORS = /[\s\-.()/]/g;

/** True when `addr` is a number (after optionally stripping separators). */
export function isNumericAddress(addr: string, normalize = true): boolean {
  const s = normalize ? addr.trim().replace(SEPARATORS, '') : addr;
  return /^\+?\d+$/.test(s);
}

/**
 * Normalizes an address and picks TON/NPI when they are not given:
 * - empty → TON 0, NPI 0 (the SMSC applies its default sender);
 * - alphanumeric → TON 5 (alphanumeric), NPI 0;
 * - `+digits` or `00digits` → TON 1 (international), NPI 1 (E.164), prefix removed;
 * - digits → TON 0 (unknown), NPI 1.
 *
 * Throws `SmppValidationError` for an address no network would accept
 * (alphanumeric destination, alphanumeric sender too long, international number > 15 digits).
 */
export function resolveAddress(
  raw: string,
  role: 'source' | 'destination',
  options: AddressOptions & { ton?: number | undefined; npi?: number | undefined } = {},
): ResolvedAddress {
  const field = role === 'source' ? 'source_addr' : 'destination_addr';
  const normalize = options.normalize ?? true;
  const trimmed = normalize ? raw.trim() : raw;

  if (trimmed === '') {
    if (role === 'destination') {
      throw new SmppValidationError('Destination address is required', field, COMMAND_STATUS.ESME_RINVDSTADR);
    }
    return { addr: '', ton: options.ton ?? TON.UNKNOWN, npi: options.npi ?? NPI.UNKNOWN };
  }

  if (!isNumericAddress(trimmed, normalize)) {
    if (role === 'destination') {
      throw new SmppValidationError(
        `Destination address must be a phone number, got "${raw}"`,
        field,
        COMMAND_STATUS.ESME_RINVDSTADR,
      );
    }
    if (options.validateSender ?? true)
      validateAlphanumericSender(trimmed, options.maxAlphanumericLength ?? 11);
    return { addr: trimmed, ton: options.ton ?? TON.ALPHANUMERIC, npi: options.npi ?? NPI.UNKNOWN };
  }

  let digits = normalize ? trimmed.replace(SEPARATORS, '') : trimmed;
  let international = false;
  if (digits.startsWith('+')) {
    digits = digits.slice(1);
    international = true;
  } else if (normalize && options.ton === undefined) {
    const prefix = options.internationalPrefix ?? '00';
    if (prefix && digits.startsWith(prefix) && digits.length - prefix.length >= MIN_INTERNATIONAL_DIGITS) {
      digits = digits.slice(prefix.length);
      international = true;
    }
  }

  const ton = options.ton ?? (international ? TON.INTERNATIONAL : TON.UNKNOWN);
  if (ton === TON.INTERNATIONAL && digits.length > E164_MAX_DIGITS) {
    throw new SmppValidationError(
      `International number has ${digits.length} digits (E.164 allows at most ${E164_MAX_DIGITS})`,
      field,
      role === 'source' ? COMMAND_STATUS.ESME_RINVSRCADR : COMMAND_STATUS.ESME_RINVDSTADR,
    );
  }
  return { addr: digits, ton, npi: options.npi ?? NPI.ISDN };
}

function validateAlphanumericSender(sender: string, maxLength: number): void {
  const length = [...sender].length;
  if (length > maxLength) {
    throw new SmppValidationError(
      `Alphanumeric sender "${sender}" has ${length} characters (max ${maxLength}): networks truncate or reject it`,
      'source_addr',
      COMMAND_STATUS.ESME_RINVSRCADR,
    );
  }
  if (!canEncodeGsm7(sender)) {
    throw new SmppValidationError(
      `Alphanumeric sender "${sender}" contains characters outside the GSM 7-bit alphabet`,
      'source_addr',
      COMMAND_STATUS.ESME_RINVSRCADR,
    );
  }
}
