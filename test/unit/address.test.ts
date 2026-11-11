import { describe, expect, it } from 'vitest';
import { NPI, SmppValidationError, TON, isNumericAddress, resolveAddress } from '../../src/index.js';

describe('resolveAddress', () => {
  it('maps +E.164 to TON international and strips the plus', () => {
    expect(resolveAddress('+2250700000000', 'destination')).toEqual({
      addr: '2250700000000',
      ton: TON.INTERNATIONAL,
      npi: NPI.ISDN,
    });
  });

  it('removes separators from human-formatted numbers', () => {
    expect(resolveAddress(' +225 07-00.00 (00) 00 ', 'destination').addr).toBe('2250700000000');
    expect(resolveAddress('07 00 00 00 00', 'destination')).toEqual({
      addr: '0700000000',
      ton: TON.UNKNOWN,
      npi: NPI.ISDN,
    });
  });

  it('converts the 00 international prefix', () => {
    expect(resolveAddress('002250700000000', 'destination')).toMatchObject({
      addr: '2250700000000',
      ton: TON.INTERNATIONAL,
    });
  });

  it('keeps short codes starting with 00 untouched', () => {
    expect(resolveAddress('0012', 'source')).toEqual({ addr: '0012', ton: TON.UNKNOWN, npi: NPI.ISDN });
  });

  it('supports another international prefix, or none', () => {
    expect(resolveAddress('01133612345678', 'destination', { internationalPrefix: '011' })).toMatchObject({
      addr: '33612345678',
      ton: TON.INTERNATIONAL,
    });
    expect(resolveAddress('002250700000000', 'destination', { internationalPrefix: false })).toMatchObject({
      addr: '002250700000000',
      ton: TON.UNKNOWN,
    });
  });

  it('does not strip 00 when TON is forced', () => {
    expect(resolveAddress('002250700000000', 'destination', { ton: TON.NATIONAL })).toMatchObject({
      addr: '002250700000000',
      ton: TON.NATIONAL,
    });
  });

  it('can be disabled entirely', () => {
    expect(() => resolveAddress('07 00', 'destination', { normalize: false })).toThrow(SmppValidationError);
  });

  it('rejects international numbers longer than 15 digits', () => {
    const err = (() => {
      try {
        resolveAddress('+1234567890123456', 'destination');
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(SmppValidationError);
    expect(err).toMatchObject({ field: 'destination_addr', status: 0x0b });
  });

  it('rejects alphanumeric or empty destinations', () => {
    expect(() => resolveAddress('ACME', 'destination')).toThrow(/phone number/);
    expect(() => resolveAddress('  ', 'destination')).toThrow(/required/);
  });

  it('maps alphanumeric senders to TON 5 / NPI 0', () => {
    expect(resolveAddress('MISSOU', 'source')).toEqual({
      addr: 'MISSOU',
      ton: TON.ALPHANUMERIC,
      npi: NPI.UNKNOWN,
    });
    expect(resolveAddress('My Shop', 'source').addr).toBe('My Shop');
  });

  it('rejects alphanumeric senders longer than 11 characters', () => {
    expect(() => resolveAddress('MonEntrepriseCI', 'source')).toThrow(SmppValidationError);
    expect(() => resolveAddress('MonEntrepriseCI', 'source')).toThrow(/15 characters \(max 11\)/);
    expect(resolveAddress('ABCDEFGHIJK', 'source').addr).toBe('ABCDEFGHIJK');
  });

  it('rejects alphanumeric senders outside the GSM alphabet', () => {
    expect(() => resolveAddress('Shop🎉', 'source')).toThrow(/GSM 7-bit/);
  });

  it('lets operators with relaxed rules opt out', () => {
    expect(resolveAddress('MonEntrepriseCI', 'source', { maxAlphanumericLength: 15 }).addr).toBe(
      'MonEntrepriseCI',
    );
    expect(resolveAddress('Shop🎉', 'source', { validateSender: false }).addr).toBe('Shop🎉');
  });

  it('leaves an empty sender to the SMSC default', () => {
    expect(resolveAddress('', 'source')).toEqual({ addr: '', ton: TON.UNKNOWN, npi: NPI.UNKNOWN });
  });

  it('honours explicit TON/NPI', () => {
    expect(resolveAddress('MISSOU', 'source', { ton: 0, npi: 0 })).toEqual({
      addr: 'MISSOU',
      ton: 0,
      npi: 0,
    });
  });
});

describe('isNumericAddress', () => {
  it('detects numbers with or without separators', () => {
    expect(isNumericAddress('+225 07 00')).toBe(true);
    expect(isNumericAddress('+225 07 00', false)).toBe(false);
    expect(isNumericAddress('INFO')).toBe(false);
  });
});
