import { canEncodeGsm7 } from '../encoding/gsm7.js';
import { SmppValidationError } from '../errors.js';
import { NPI, TON } from '../protocol/constants.js';
import { COMMAND_STATUS } from '../protocol/status.js';

/** Options de normalisation et de validation des adresses de `sendText`. */
export interface AddressOptions {
  /**
   * Retire les séparateurs des numéros (espaces, tirets, points, parenthèses, barres obliques)
   * et convertit le préfixe international (`00…`) en TON international. Défaut : `true`.
   */
  normalize?: boolean;
  /**
   * Préfixe d'appel international à convertir en TON 1 (ex. `00` en Europe et en Afrique,
   * `011` en Amérique du Nord). `false` pour désactiver. Défaut : `'00'`.
   */
  internationalPrefix?: string | false;
  /**
   * Longueur maximale d'un expéditeur alphanumérique. La norme GSM (3GPP TS 23.040) limite
   * le champ TP-OA à 11 caractères : au-delà, les réseaux tronquent ou rejettent le message.
   * Défaut : 11.
   */
  maxAlphanumericLength?: number;
  /**
   * Valide l'expéditeur alphanumérique (longueur, caractères GSM 7 bits).
   * `false` pour laisser passer une valeur hors norme acceptée par un opérateur. Défaut : `true`.
   */
  validateSender?: boolean;
}

export interface ResolvedAddress {
  addr: string;
  ton: number;
  npi: number;
}

/** Longueur maximale d'un numéro E.164 (indicatif pays compris). */
const E164_MAX_DIGITS = 15;
/** En dessous, un numéro précédé de `00` est traité comme un code court, pas comme un numéro international. */
const MIN_INTERNATIONAL_DIGITS = 7;
const SEPARATORS = /[\s\-.()/]/g;

/** Vrai si `addr` est un numéro (après retrait éventuel des séparateurs). */
export function isNumericAddress(addr: string, normalize = true): boolean {
  const s = normalize ? addr.trim().replace(SEPARATORS, '') : addr;
  return /^\+?\d+$/.test(s);
}

/**
 * Normalise une adresse et choisit TON/NPI quand ils ne sont pas fournis :
 * - vide → TON 0, NPI 0 (le SMSC applique son expéditeur par défaut) ;
 * - alphanumérique → TON 5 (alphanumeric), NPI 0 ;
 * - `+chiffres` ou `00chiffres` → TON 1 (international), NPI 1 (E.164), préfixe retiré ;
 * - chiffres → TON 0 (unknown), NPI 1.
 *
 * Lève `SmppValidationError` pour une adresse qu'aucun réseau n'acceptera
 * (destination alphanumérique, expéditeur alphanumérique trop long, numéro international > 15 chiffres).
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
