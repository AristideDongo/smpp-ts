import { describe, expect, it } from 'vitest';
import {
  buildDeliveryReport,
  formatDlr,
  isDeliveryReceipt,
  normalizeDlrStatus,
  normalizeMessageId,
  parseDlr,
  parseDlrDate,
} from '../../src/utils/dlr.js';
import {
  formatAbsoluteTime,
  formatRelativeTime,
  parseSmppTime,
  smppTimeToDate,
} from '../../src/utils/time.js';

const STANDARD =
  'id:1234567890 sub:001 dlvrd:001 submit date:2411101530 done date:2411101531 stat:DELIVRD err:000 text:Votre code est';

describe('parseDlr', () => {
  it('parses the standard format', () => {
    const r = parseDlr(STANDARD)!;
    expect(r).toMatchObject({
      id: '1234567890',
      sub: '001',
      dlvrd: '001',
      stat: 'DELIVRD',
      err: '000',
      text: 'Votre code est',
    });
    expect(r.submitDate?.toISOString()).toBe('2024-11-10T15:30:00.000Z');
    expect(r.doneDate?.toISOString()).toBe('2024-11-10T15:31:00.000Z');
  });

  it('tolerates case, underscores, seconds, missing fields and other order', () => {
    const r = parseDlr('Stat:UNDELIV ID:abc-1 Submit_Date:241110153045 err:0B1')!;
    expect(r).toMatchObject({ id: 'abc-1', stat: 'UNDELIV', err: '0B1' });
    expect(r.submitDate?.toISOString()).toBe('2024-11-10T15:30:45.000Z');
  });

  it('keeps everything after text:, even key-like content', () => {
    expect(parseDlr('id:1 stat:DELIVRD text:hello id:2 stat:x')?.text).toBe('hello id:2 stat:x');
  });

  it('returns undefined for non-DLR text', () => {
    expect(parseDlr('Bonjour, comment ça va ?')).toBeUndefined();
    expect(parseDlr('')).toBeUndefined();
  });

  it('rejects invalid dates', () => {
    expect(parseDlrDate('2413101530')).toBeUndefined();
    expect(parseDlrDate('abc')).toBeUndefined();
  });
});

describe('DLR normalization', () => {
  it('normalizes statuses', () => {
    expect(normalizeDlrStatus('DELIVRD')).toBe('DELIVERED');
    expect(normalizeDlrStatus('undeliv')).toBe('UNDELIVERABLE');
    expect(normalizeDlrStatus('ACCEPTD')).toBe('ACCEPTED');
    expect(normalizeDlrStatus('REJECTD')).toBe('REJECTED');
    expect(normalizeDlrStatus('weird')).toBe('UNKNOWN');
    expect(normalizeDlrStatus(2)).toBe('DELIVERED');
    expect(normalizeDlrStatus(8)).toBe('REJECTED');
    expect(normalizeDlrStatus(99)).toBe('UNKNOWN');
  });

  it('converts message ids between hex and decimal', () => {
    expect(normalizeMessageId('1A2B', 'hex-to-dec')).toBe('6699');
    expect(normalizeMessageId('6699', 'dec-to-hex')).toBe('1a2b');
    expect(normalizeMessageId('ffffffffffffffffff', 'hex-to-dec')).toBe('4722366482869645213695');
    expect(normalizeMessageId('xyz', 'hex-to-dec')).toBe('xyz');
    expect(normalizeMessageId(' 42 ')).toBe('42');
  });

  it('detects delivery receipts from esm_class', () => {
    expect(isDeliveryReceipt({ esm_class: 0x04 })).toBe(true);
    expect(isDeliveryReceipt({ esm_class: 0x44 })).toBe(true);
    expect(isDeliveryReceipt({ esm_class: 0x20 })).toBe(true);
    expect(isDeliveryReceipt({ esm_class: 0x00 })).toBe(false);
    expect(isDeliveryReceipt({ esm_class: 0x00, receipted_message_id: 'x' })).toBe(true);
  });

  it('prefers TLVs over the text', () => {
    const dlr = buildDeliveryReport(
      {
        esm_class: 4,
        source_addr: '225',
        destination_addr: 'MISSOU',
        receipted_message_id: 'FF',
        message_state: 5,
        network_error_code: { network_type: 3, error_code: 1 },
      },
      STANDARD,
      'hex-to-dec',
    )!;
    expect(dlr).toMatchObject({
      messageId: '255',
      rawMessageId: 'FF',
      status: 'UNDELIVERABLE',
      errorCode: '000',
      submitted: 1,
      delivered: 1,
    });
    expect(dlr.networkError).toEqual({ network_type: 3, error_code: 1 });
  });

  it('falls back to the text', () => {
    const dlr = buildDeliveryReport({ esm_class: 4, source_addr: 'a', destination_addr: 'b' }, STANDARD)!;
    expect(dlr).toMatchObject({ messageId: '1234567890', status: 'DELIVERED', rawStatus: 'DELIVRD' });
    expect(
      buildDeliveryReport({ esm_class: 4, source_addr: 'a', destination_addr: 'b' }, 'nothing'),
    ).toBeUndefined();
  });

  it('formatDlr output parses back', () => {
    const text = formatDlr({ id: 'm1', status: 'EXPIRED', text: 'a'.repeat(30) });
    const parsed = parseDlr(text)!;
    expect(parsed).toMatchObject({ id: 'm1', stat: 'EXPIRED', sub: '001', dlvrd: '000' });
    expect(parsed.text).toHaveLength(20);
  });
});

describe('SMPP times', () => {
  it('parses absolute times with UTC offset', () => {
    const t = parseSmppTime('241110153045204+');
    expect(t?.type).toBe('absolute');
    if (t?.type !== 'absolute') throw new Error();
    // 15:30:45.2 at UTC+1h (4 quarter hours) = 14:30:45.2 UTC
    expect(t.date.toISOString()).toBe('2024-11-10T14:30:45.200Z');
    expect(parseSmppTime('241110153045000-')?.type).toBe('absolute');
  });

  it('parses relative times', () => {
    const t = parseSmppTime('000001020304000R');
    if (t?.type !== 'relative') throw new Error();
    expect(t.durationMs).toBe(((1 * 24 + 2) * 3600 + 3 * 60 + 4) * 1000);
  });

  it('returns undefined for empty, throws for invalid', () => {
    expect(parseSmppTime('')).toBeUndefined();
    expect(() => parseSmppTime('garbage')).toThrow();
    expect(() => parseSmppTime('241310153045000+')).toThrow();
    expect(() => parseSmppTime('241110153045049+')).toThrow();
  });

  it('formats absolute times and round-trips', () => {
    const d = new Date('2024-11-10T14:30:45.200Z');
    expect(formatAbsoluteTime(d)).toBe('241110143045200+');
    expect(formatAbsoluteTime(d, 4)).toBe('241110153045204+');
    expect(formatAbsoluteTime(d, -8)).toBe('241110123045208-');
    for (const off of [-48, -8, 0, 4, 48]) {
      const back = parseSmppTime(formatAbsoluteTime(d, off));
      expect(back?.type === 'absolute' && back.date.getTime()).toBe(d.getTime());
    }
    expect(() => formatAbsoluteTime(new Date('1999-01-01'))).toThrow();
    expect(() => formatAbsoluteTime(d, 49)).toThrow();
  });

  it('formats relative times', () => {
    expect(formatRelativeTime(((1 * 24 + 2) * 3600 + 3 * 60 + 4) * 1000)).toBe('000001020304000R');
    expect(formatRelativeTime(48 * 3600_000)).toBe('000002000000000R');
    // 400 j = 1 an (365 j) + 1 mois (30 j) + 5 j
    expect(formatRelativeTime(400 * 86400_000)).toBe('010105000000000R');
    expect(() => formatRelativeTime(-1)).toThrow();
  });

  it('smppTimeToDate', () => {
    const now = new Date('2024-01-01T00:00:00Z');
    expect(smppTimeToDate('000000010000000R', now)?.toISOString()).toBe('2024-01-01T01:00:00.000Z');
    expect(smppTimeToDate('', now)).toBeUndefined();
  });
});
