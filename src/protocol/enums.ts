/**
 * Allowed values of the enumerated PDU fields (SEC-03), checked when encoding with
 * `new PduCodec({ validateEnums: true })`.
 *
 * Only encoding is checked, never decoding: operators do send values the specification does not
 * list, and refusing an incoming PDU over a `ton` of 7 would drop real traffic. On the way out the
 * trade-off is the other way around — a value the specification does not allow is a bug in the
 * caller, and the SMSC would answer `ESME_RINV…` anyway, one round trip later.
 */
import { DATA_CODING, NPI, TON } from './constants.js';
import { COMMAND_STATUS } from './status.js';

/** A field's check: `true` when the value is allowed. */
export interface EnumRule {
  allowed(value: number): boolean;
  /** SMPP status reported with the validation error. */
  status: number;
  /** Human-readable description of what is allowed. */
  expected: string;
}

const TON_VALUES = new Set<number>(Object.values(TON));
const NPI_VALUES = new Set<number>(Object.values(NPI));
const DATA_CODING_VALUES = new Set<number>(Object.values(DATA_CODING));

const ton = (status: number): EnumRule => ({
  allowed: (v) => TON_VALUES.has(v),
  status,
  expected: 'a TON of 0 to 6',
});

const npi = (status: number): EnumRule => ({
  allowed: (v) => NPI_VALUES.has(v),
  status,
  expected: 'an NPI listed by the specification (0, 1, 3, 4, 6, 8, 9, 10, 14, 18)',
});

/**
 * `data_coding`: the SMPP values, plus the 3GPP TS 23.038 general coding groups an SMSC passes
 * through — message class present (0x10-0x1f, used by flash SMS) and the data coding / message
 * class group (0xf0-0xff).
 */
const dataCoding: EnumRule = {
  allowed: (v) => DATA_CODING_VALUES.has(v) || (v >= 0x10 && v <= 0x1f) || (v >= 0xf0 && v <= 0xff),
  status: COMMAND_STATUS.ESME_RINVDCS,
  expected: 'an SMPP data_coding, a message-class value (0x10-0x1f) or 0xf0-0xff',
};

/** Checks by field name, applied to every command that carries the field. */
export const ENUM_RULES: Readonly<Record<string, EnumRule>> = {
  source_addr_ton: ton(COMMAND_STATUS.ESME_RINVSRCTON),
  source_addr_npi: npi(COMMAND_STATUS.ESME_RINVSRCNPI),
  dest_addr_ton: ton(COMMAND_STATUS.ESME_RINVDSTTON),
  dest_addr_npi: npi(COMMAND_STATUS.ESME_RINVDSTNPI),
  esme_addr_ton: ton(COMMAND_STATUS.ESME_RINVSRCTON),
  esme_addr_npi: npi(COMMAND_STATUS.ESME_RINVSRCNPI),
  addr_ton: ton(COMMAND_STATUS.ESME_RINVSRCTON),
  addr_npi: npi(COMMAND_STATUS.ESME_RINVSRCNPI),
  data_coding: dataCoding,
  priority_flag: {
    allowed: (v) => v <= 4,
    status: COMMAND_STATUS.ESME_RINVPRTFLG,
    expected: '0 to 4',
  },
  registered_delivery: {
    allowed: (v) => (v & ~0x1f) === 0,
    status: COMMAND_STATUS.ESME_RINVREGDLVFLG,
    expected: 'a combination of the receipt, acknowledgement and intermediate bits (0x00-0x1f)',
  },
  replace_if_present_flag: {
    allowed: (v) => v <= 1,
    status: COMMAND_STATUS.ESME_RINVREPFLAG,
    expected: '0 or 1',
  },
  esm_class: {
    // Bits 5-2 (message type) only take the listed combinations; the others are reserved.
    allowed: (v) => {
      const type = v & 0x3c;
      return (
        type === 0x00 || type === 0x04 || type === 0x08 || type === 0x10 || type === 0x18 || type === 0x20
      );
    },
    status: COMMAND_STATUS.ESME_RINVESMCLASS,
    expected: 'a message type listed by the specification in bits 5-2',
  },
} as const;
