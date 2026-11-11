/**
 * Table déclarative des TLV (Tag-Length-Value) SMPP v5.0, section 4.8.4.
 */

export type TlvType =
  /** Entier non signé 1 octet. */
  | 'uint8'
  /** Entier non signé 2 octets. */
  | 'uint16'
  /** Entier non signé 4 octets. */
  | 'uint32'
  /** Chaîne terminée par un octet nul (longueur max incluant le nul). */
  | 'cstring'
  /** Chaîne d'octets brute. */
  | 'octets'
  /** network_error_code : type de réseau (1 octet) + code d'erreur (2 octets). */
  | 'network_error'
  /** TLV sans valeur (longueur 0) ou à 1 octet optionnel. */
  | 'flag';

export interface TlvDefinition {
  readonly tag: number;
  readonly type: TlvType;
  /** Longueur minimale de la valeur en octets. */
  readonly min?: number;
  /** Longueur maximale de la valeur en octets. */
  readonly max?: number;
  /** Le TLV peut apparaître plusieurs fois : la valeur est alors un tableau. */
  readonly multiple?: boolean;
  /** Valeur sensible, masquée dans les logs. */
  readonly sensitive?: boolean;
  /** Contenu de message (masqué si `redactContent`). */
  readonly content?: boolean;
}

export const TLVS = {
  dest_addr_subunit: { tag: 0x0005, type: 'uint8' },
  dest_network_type: { tag: 0x0006, type: 'uint8' },
  dest_bearer_type: { tag: 0x0007, type: 'uint8' },
  dest_telematics_id: { tag: 0x0008, type: 'uint16' },
  source_addr_subunit: { tag: 0x000d, type: 'uint8' },
  source_network_type: { tag: 0x000e, type: 'uint8' },
  source_bearer_type: { tag: 0x000f, type: 'uint8' },
  source_telematics_id: { tag: 0x0010, type: 'uint8' },
  qos_time_to_live: { tag: 0x0017, type: 'uint32' },
  payload_type: { tag: 0x0019, type: 'uint8' },
  additional_status_info_text: { tag: 0x001d, type: 'cstring', max: 256 },
  receipted_message_id: { tag: 0x001e, type: 'cstring', max: 65 },
  ms_msg_wait_facilities: { tag: 0x0030, type: 'uint8' },
  privacy_indicator: { tag: 0x0201, type: 'uint8' },
  source_subaddress: { tag: 0x0202, type: 'octets', min: 2, max: 23 },
  dest_subaddress: { tag: 0x0203, type: 'octets', min: 2, max: 23 },
  user_message_reference: { tag: 0x0204, type: 'uint16' },
  user_response_code: { tag: 0x0205, type: 'uint8' },
  source_port: { tag: 0x020a, type: 'uint16' },
  destination_port: { tag: 0x020b, type: 'uint16' },
  sar_msg_ref_num: { tag: 0x020c, type: 'uint16' },
  language_indicator: { tag: 0x020d, type: 'uint8' },
  sar_total_segments: { tag: 0x020e, type: 'uint8' },
  sar_segment_seqnum: { tag: 0x020f, type: 'uint8' },
  sc_interface_version: { tag: 0x0210, type: 'uint8' },
  callback_num_pres_ind: { tag: 0x0302, type: 'uint8' },
  callback_num_atag: { tag: 0x0303, type: 'octets', max: 65 },
  number_of_messages: { tag: 0x0304, type: 'uint8' },
  callback_num: { tag: 0x0381, type: 'octets', min: 4, max: 19 },
  dpf_result: { tag: 0x0420, type: 'uint8' },
  set_dpf: { tag: 0x0421, type: 'uint8' },
  ms_availability_status: { tag: 0x0422, type: 'uint8' },
  network_error_code: { tag: 0x0423, type: 'network_error' },
  message_payload: { tag: 0x0424, type: 'octets', max: 65535, content: true },
  delivery_failure_reason: { tag: 0x0425, type: 'uint8' },
  more_messages_to_send: { tag: 0x0426, type: 'uint8' },
  message_state: { tag: 0x0427, type: 'uint8' },
  congestion_state: { tag: 0x0428, type: 'uint8' },
  ussd_service_op: { tag: 0x0501, type: 'uint8' },
  broadcast_channel_indicator: { tag: 0x0600, type: 'uint8' },
  broadcast_content_type: { tag: 0x0601, type: 'octets', min: 3, max: 3 },
  broadcast_content_type_info: { tag: 0x0602, type: 'octets', max: 255 },
  broadcast_message_class: { tag: 0x0603, type: 'uint8' },
  broadcast_rep_num: { tag: 0x0604, type: 'uint16' },
  broadcast_frequency_interval: { tag: 0x0605, type: 'octets', min: 3, max: 3 },
  broadcast_area_identifier: { tag: 0x0606, type: 'octets', max: 100, multiple: true },
  broadcast_error_status: { tag: 0x0607, type: 'uint32' },
  broadcast_area_success: { tag: 0x0608, type: 'uint8', multiple: true },
  broadcast_end_time: { tag: 0x0609, type: 'cstring', max: 17 },
  broadcast_service_group: { tag: 0x060a, type: 'octets', max: 255 },
  billing_identification: { tag: 0x060b, type: 'octets', max: 1024 },
  source_network_id: { tag: 0x060d, type: 'cstring', max: 65 },
  dest_network_id: { tag: 0x060e, type: 'cstring', max: 65 },
  source_node_id: { tag: 0x060f, type: 'octets', min: 6, max: 6 },
  dest_node_id: { tag: 0x0610, type: 'octets', min: 6, max: 6 },
  dest_addr_np_resolution: { tag: 0x0611, type: 'uint8' },
  dest_addr_np_information: { tag: 0x0612, type: 'octets', min: 10, max: 10 },
  dest_addr_np_country: { tag: 0x0613, type: 'octets', min: 1, max: 5 },
  display_time: { tag: 0x1201, type: 'uint8' },
  sms_signal: { tag: 0x1203, type: 'uint16' },
  ms_validity: { tag: 0x1204, type: 'octets', min: 1, max: 4 },
  alert_on_message_delivery: { tag: 0x130c, type: 'flag' },
  its_reply_type: { tag: 0x1380, type: 'uint8' },
  its_session_info: { tag: 0x1383, type: 'octets', min: 2, max: 2 },
} as const satisfies Record<string, TlvDefinition>;

export type StandardTlvName = keyof typeof TLVS;

export interface NetworkErrorCode {
  network_type: number;
  error_code: number;
}

/** Type TypeScript d'une valeur TLV selon son type déclaré. */
export type TlvValueOf<T extends TlvType> = T extends 'uint8' | 'uint16' | 'uint32'
  ? number
  : T extends 'cstring'
    ? string
    : T extends 'network_error'
      ? NetworkErrorCode
      : T extends 'flag'
        ? true | number
        : Buffer;

type TlvEntry<N extends StandardTlvName> = (typeof TLVS)[N];

/** Valeurs TLV standards, toutes optionnelles. */
export type TlvParams = {
  [N in StandardTlvName]?: TlvEntry<N> extends { multiple: true }
    ? TlvValueOf<TlvEntry<N>['type']>[]
    : TlvValueOf<TlvEntry<N>['type']>;
};

/** TLV non reconnu, conservé tel quel au décodage et réémis à l'encodage. */
export interface UnknownTlv {
  tag: number;
  value: Buffer;
}
