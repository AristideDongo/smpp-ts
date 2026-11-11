import { SmppValidationError } from '../errors.js';

/**
 * Dates SMPP (§7.1.1 de la spec) au format `YYMMDDhhmmsstnnp` :
 * - absolue : `t` dixièmes de seconde, `nn` décalage en quarts d'heure, `p` = `+` ou `-` ;
 * - relative : `p` = `R`, les champs sont une durée (années, mois, jours, h, min, s).
 */

export type SmppTime =
  | { type: 'absolute'; date: Date; offsetQuarterHours: number }
  | {
      type: 'relative';
      years: number;
      months: number;
      days: number;
      hours: number;
      minutes: number;
      seconds: number;
      /** Durée approximative (1 an = 365 j, 1 mois = 30 j). */
      durationMs: number;
    };

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** Analyse une date SMPP. Renvoie `undefined` pour une chaîne vide (valeur « immédiate / défaut »). */
export function parseSmppTime(value: string): SmppTime | undefined {
  if (value === '') return undefined;
  const m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d)(\d{2})([+\-R])$/.exec(value);
  if (!m) throw new SmppValidationError(`Invalid SMPP time "${value}"`, 'time', 0x00000061);
  const [, yy, mo, dd, hh, mi, ss, t, nn, p] = m;
  const n = (s: string | undefined) => Number(s);

  if (p === 'R') {
    const years = n(yy);
    const months = n(mo);
    const days = n(dd);
    const hours = n(hh);
    const minutes = n(mi);
    const seconds = n(ss);
    const durationMs =
      ((((years * 365 + months * 30 + days) * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
    return { type: 'relative', years, months, days, hours, minutes, seconds, durationMs };
  }

  const offset = n(nn) * (p === '-' ? -1 : 1);
  if (n(nn) > 48) throw new SmppValidationError(`Invalid UTC offset in "${value}"`, 'time', 0x00000061);
  const localMs = Date.UTC(2000 + n(yy), n(mo) - 1, n(dd), n(hh), n(mi), n(ss), n(t) * 100);
  const date = new Date(localMs - offset * 15 * 60_000);
  if (Number.isNaN(date.getTime()) || n(mo) < 1 || n(mo) > 12 || n(dd) < 1 || n(dd) > 31) {
    throw new SmppValidationError(`Invalid SMPP time "${value}"`, 'time', 0x00000061);
  }
  return { type: 'absolute', date, offsetQuarterHours: offset };
}

/**
 * Formate une date absolue. `offsetQuarterHours` : décalage de l'heure locale exprimée
 * (0 = UTC, 4 = UTC+1…). Années 2000–2099 uniquement.
 */
export function formatAbsoluteTime(date: Date, offsetQuarterHours = 0): string {
  if (!Number.isInteger(offsetQuarterHours) || Math.abs(offsetQuarterHours) > 48) {
    throw new SmppValidationError('offsetQuarterHours must be an integer between -48 and 48', 'time');
  }
  const local = new Date(date.getTime() + offsetQuarterHours * 15 * 60_000);
  const year = local.getUTCFullYear();
  if (year < 2000 || year > 2099) throw new SmppValidationError('Year must be between 2000 and 2099', 'time');
  return (
    pad(year % 100) +
    pad(local.getUTCMonth() + 1) +
    pad(local.getUTCDate()) +
    pad(local.getUTCHours()) +
    pad(local.getUTCMinutes()) +
    pad(local.getUTCSeconds()) +
    String(Math.floor(local.getUTCMilliseconds() / 100)) +
    pad(Math.abs(offsetQuarterHours)) +
    (offsetQuarterHours < 0 ? '-' : '+')
  );
}

/** Formate une durée en date relative (`…000R`). Les secondes fractionnaires sont arrondies vers le bas. */
export function formatRelativeTime(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new SmppValidationError('Duration must be a positive number', 'time');
  }
  let rest = Math.floor(durationMs / 1000);
  const seconds = rest % 60;
  rest = Math.floor(rest / 60);
  const minutes = rest % 60;
  rest = Math.floor(rest / 60);
  const hours = rest % 24;
  let days = Math.floor(rest / 24);
  let months = 0;
  let years = 0;
  if (days > 99) {
    years = Math.floor(days / 365);
    days -= years * 365;
    months = Math.floor(days / 30);
    days -= months * 30;
  }
  if (years > 99) throw new SmppValidationError('Duration too long for SMPP relative time', 'time');
  return `${pad(years)}${pad(months)}${pad(days)}${pad(hours)}${pad(minutes)}${pad(seconds)}000R`;
}

/** Convertit une date SMPP (absolue ou relative) en `Date`, relativement à `now`. */
export function smppTimeToDate(value: string, now: Date = new Date()): Date | undefined {
  const t = parseSmppTime(value);
  if (!t) return undefined;
  return t.type === 'absolute' ? t.date : new Date(now.getTime() + t.durationMs);
}
