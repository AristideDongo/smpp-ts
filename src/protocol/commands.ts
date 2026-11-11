/**
 * Declarative table of SMPP v5.0 commands and their mandatory parameters.
 * It is the source of truth the codec and the TypeScript types derive from.
 *
 * `max` lengths of C-Octet Strings include the terminating null byte, as in the spec.
 */

export type FieldType =
  | 'uint8'
  | 'uint16'
  | 'uint32'
  | 'cstring'
  /** short_message length (computed automatically when encoding). */
  | 'sm_length'
  /** Octet String of length sm_length. */
  | 'short_message'
  /** number_of_dests + list of dest_address (submit_multi). */
  | 'dest_address_list'
  /** no_unsuccess + list of unsuccess_sme (submit_multi_resp). */
  | 'unsuccess_sme_list';

export interface FieldDefinition {
  readonly name: string;
  readonly type: FieldType;
  readonly max?: number;
  /** Secret value: never logged (SEC-02). */
  readonly sensitive?: boolean;
  /** Phone number: maskable with `redactNumbers`. */
  readonly number?: boolean;
  /** Message content: maskable with `redactContent`. */
  readonly content?: boolean;
}

export interface CommandDefinition {
  readonly id: number;
  readonly params: readonly FieldDefinition[];
}

const u8 = <N extends string>(name: N) => ({ name, type: 'uint8' }) as const;
const cstr = <N extends string, M extends number>(name: N, max: M) =>
  ({ name, type: 'cstring', max }) as const;
const addr = <N extends string, M extends number>(name: N, max: M) =>
  ({ name, type: 'cstring', max, number: true }) as const;
const smLength = { name: 'sm_length', type: 'sm_length' } as const;
const shortMessage = { name: 'short_message', type: 'short_message', max: 255, content: true } as const;

const bindParams = [
  cstr('system_id', 16),
  { name: 'password', type: 'cstring', max: 9, sensitive: true },
  cstr('system_type', 13),
  u8('interface_version'),
  u8('addr_ton'),
  u8('addr_npi'),
  cstr('address_range', 41),
] as const;

const bindRespParams = [cstr('system_id', 16)] as const;

const smParams = [
  cstr('service_type', 6),
  u8('source_addr_ton'),
  u8('source_addr_npi'),
  addr('source_addr', 21),
  u8('dest_addr_ton'),
  u8('dest_addr_npi'),
  addr('destination_addr', 21),
  u8('esm_class'),
  u8('protocol_id'),
  u8('priority_flag'),
  cstr('schedule_delivery_time', 17),
  cstr('validity_period', 17),
  u8('registered_delivery'),
  u8('replace_if_present_flag'),
  u8('data_coding'),
  u8('sm_default_msg_id'),
  smLength,
  shortMessage,
] as const;

const messageIdOnly = [cstr('message_id', 65)] as const;
const empty = [] as const;

export const COMMANDS = {
  generic_nack: { id: 0x80000000, params: empty },
  bind_receiver: { id: 0x00000001, params: bindParams },
  bind_receiver_resp: { id: 0x80000001, params: bindRespParams },
  bind_transmitter: { id: 0x00000002, params: bindParams },
  bind_transmitter_resp: { id: 0x80000002, params: bindRespParams },
  query_sm: {
    id: 0x00000003,
    params: [cstr('message_id', 65), u8('source_addr_ton'), u8('source_addr_npi'), addr('source_addr', 21)],
  },
  query_sm_resp: {
    id: 0x80000003,
    params: [cstr('message_id', 65), cstr('final_date', 17), u8('message_state'), u8('error_code')],
  },
  submit_sm: { id: 0x00000004, params: smParams },
  submit_sm_resp: { id: 0x80000004, params: messageIdOnly },
  deliver_sm: { id: 0x00000005, params: smParams },
  deliver_sm_resp: { id: 0x80000005, params: messageIdOnly },
  unbind: { id: 0x00000006, params: empty },
  unbind_resp: { id: 0x80000006, params: empty },
  replace_sm: {
    id: 0x00000007,
    params: [
      cstr('message_id', 65),
      u8('source_addr_ton'),
      u8('source_addr_npi'),
      addr('source_addr', 21),
      cstr('schedule_delivery_time', 17),
      cstr('validity_period', 17),
      u8('registered_delivery'),
      u8('sm_default_msg_id'),
      smLength,
      shortMessage,
    ],
  },
  replace_sm_resp: { id: 0x80000007, params: empty },
  cancel_sm: {
    id: 0x00000008,
    params: [
      cstr('service_type', 6),
      cstr('message_id', 65),
      u8('source_addr_ton'),
      u8('source_addr_npi'),
      addr('source_addr', 21),
      u8('dest_addr_ton'),
      u8('dest_addr_npi'),
      addr('destination_addr', 21),
    ],
  },
  cancel_sm_resp: { id: 0x80000008, params: empty },
  bind_transceiver: { id: 0x00000009, params: bindParams },
  bind_transceiver_resp: { id: 0x80000009, params: bindRespParams },
  outbind: {
    id: 0x0000000b,
    params: [cstr('system_id', 16), { name: 'password', type: 'cstring', max: 9, sensitive: true }],
  },
  enquire_link: { id: 0x00000015, params: empty },
  enquire_link_resp: { id: 0x80000015, params: empty },
  submit_multi: {
    id: 0x00000021,
    params: [
      cstr('service_type', 6),
      u8('source_addr_ton'),
      u8('source_addr_npi'),
      addr('source_addr', 21),
      { name: 'dest_address', type: 'dest_address_list' },
      u8('esm_class'),
      u8('protocol_id'),
      u8('priority_flag'),
      cstr('schedule_delivery_time', 17),
      cstr('validity_period', 17),
      u8('registered_delivery'),
      u8('replace_if_present_flag'),
      u8('data_coding'),
      u8('sm_default_msg_id'),
      smLength,
      shortMessage,
    ],
  },
  submit_multi_resp: {
    id: 0x80000021,
    params: [cstr('message_id', 65), { name: 'unsuccess_sme', type: 'unsuccess_sme_list' }],
  },
  alert_notification: {
    id: 0x00000102,
    params: [
      u8('source_addr_ton'),
      u8('source_addr_npi'),
      addr('source_addr', 65),
      u8('esme_addr_ton'),
      u8('esme_addr_npi'),
      addr('esme_addr', 65),
    ],
  },
  data_sm: {
    id: 0x00000103,
    params: [
      cstr('service_type', 6),
      u8('source_addr_ton'),
      u8('source_addr_npi'),
      addr('source_addr', 65),
      u8('dest_addr_ton'),
      u8('dest_addr_npi'),
      addr('destination_addr', 65),
      u8('esm_class'),
      u8('registered_delivery'),
      u8('data_coding'),
    ],
  },
  data_sm_resp: { id: 0x80000103, params: messageIdOnly },
  broadcast_sm: {
    id: 0x00000111,
    params: [
      cstr('service_type', 6),
      u8('source_addr_ton'),
      u8('source_addr_npi'),
      addr('source_addr', 21),
      cstr('message_id', 65),
      u8('priority_flag'),
      cstr('schedule_delivery_time', 17),
      cstr('validity_period', 17),
      u8('replace_if_present_flag'),
      u8('data_coding'),
      u8('sm_default_msg_id'),
    ],
  },
  broadcast_sm_resp: { id: 0x80000111, params: messageIdOnly },
  query_broadcast_sm: {
    id: 0x00000112,
    params: [cstr('message_id', 65), u8('source_addr_ton'), u8('source_addr_npi'), addr('source_addr', 21)],
  },
  query_broadcast_sm_resp: { id: 0x80000112, params: messageIdOnly },
  cancel_broadcast_sm: {
    id: 0x00000113,
    params: [
      cstr('service_type', 6),
      cstr('message_id', 65),
      u8('source_addr_ton'),
      u8('source_addr_npi'),
      addr('source_addr', 21),
    ],
  },
  cancel_broadcast_sm_resp: { id: 0x80000113, params: empty },
} as const satisfies Record<string, CommandDefinition>;

export type CommandName = keyof typeof COMMANDS;

/** Request commands (those expecting a response, plus alert_notification/outbind). */
export type RequestCommandName = Exclude<CommandName, `${string}_resp` | 'generic_nack'>;
export type ResponseCommandName = Extract<CommandName, `${string}_resp`>;

/** Requests the spec defines without a response. */
export const NO_RESPONSE_COMMANDS: ReadonlySet<CommandName> = new Set<CommandName>([
  'alert_notification',
  'outbind',
]);

const BY_ID = new Map<number, CommandName>(
  (Object.entries(COMMANDS) as [CommandName, CommandDefinition][]).map(([name, def]) => [def.id, name]),
);

export function commandNameById(id: number): CommandName | undefined {
  return BY_ID.get(id >>> 0);
}

export function isResponseCommand(name: CommandName): name is ResponseCommandName | 'generic_nack' {
  return name === 'generic_nack' || name.endsWith('_resp');
}

/** Name of the response expected for a request, or `undefined` if it has none. */
export function responseNameOf(name: CommandName): ResponseCommandName | undefined {
  if (isResponseCommand(name) || NO_RESPONSE_COMMANDS.has(name)) return undefined;
  return `${name}_resp` as ResponseCommandName;
}

// ---------------------------------------------------------------------------
// Types derived from the table
// ---------------------------------------------------------------------------

export interface DestAddressSme {
  dest_flag: 1;
  dest_addr_ton: number;
  dest_addr_npi: number;
  destination_addr: string;
}

export interface DestAddressDl {
  dest_flag: 2;
  dl_name: string;
}

export type DestAddress = DestAddressSme | DestAddressDl;

export interface UnsuccessSme {
  dest_addr_ton: number;
  dest_addr_npi: number;
  destination_addr: string;
  error_status_code: number;
}

type FieldValue<F> = F extends { type: 'uint8' | 'uint16' | 'uint32' | 'sm_length' }
  ? number
  : F extends { type: 'cstring' }
    ? string
    : F extends { type: 'short_message' }
      ? Buffer
      : F extends { type: 'dest_address_list' }
        ? DestAddress[]
        : F extends { type: 'unsuccess_sme_list' }
          ? UnsuccessSme[]
          : never;

type ParamsTuple<C extends CommandName> = (typeof COMMANDS)[C]['params'];

/** Mandatory (decoded) parameters of a command. */
export type CommandParams<C extends CommandName> = {
  -readonly [F in ParamsTuple<C>[number] as F['name']]: FieldValue<F>;
};
