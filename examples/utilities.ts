/**
 * Utilitaires sans réseau : segments, encodage, DLR, dates.
 *
 *   npx tsx examples/utilities.ts
 */
import { countSegments, detectEncoding, formatRelativeTime, parseDlr, parseSmppTime } from '../src/index.js';

console.log(countSegments('Bonjour {monde} €'));
// { encoding: 'gsm7', segments: 1, units: 20, perSegment: 160, remaining: 140, ... }

console.log(countSegments('Fenêtre '.repeat(20)));
// { encoding: 'ucs2', segments: 3, ... }

console.log(detectEncoding('Fenêtre', { allowLatin1: true })); // { encoding: 'latin1' }
console.log(detectEncoding('Şişli', { shiftTables: ['tr'] })); // { encoding: 'gsm7', shift: 'tr' }

console.log(
  parseDlr(
    'id:123 sub:001 dlvrd:001 submit date:2411101530 done date:2411101531 stat:DELIVRD err:000 text:Hi',
  ),
);

console.log(formatRelativeTime(2 * 3600_000)); // '000000020000000R' (validité : 2 h)
console.log(parseSmppTime('241110153045204+'));
