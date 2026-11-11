/**
 * Constantes du protocole SMPP v5.0 (rétrocompatible v3.4).
 * Les noms reprennent ceux de la spécification.
 */

/** Taille de l'en-tête PDU : command_length, command_id, command_status, sequence_number. */
export const HEADER_LENGTH = 16;

/** Valeur maximale d'un sequence_number (le bit de poids fort est réservé). */
export const MAX_SEQUENCE_NUMBER = 0x7fffffff;

/** Bit qui distingue une réponse d'une requête dans command_id. */
export const RESPONSE_BIT = 0x80000000;

export const INTERFACE_VERSION = {
  V33: 0x33,
  V34: 0x34,
  V50: 0x50,
} as const;

/** Type Of Number. */
export const TON = {
  UNKNOWN: 0x00,
  INTERNATIONAL: 0x01,
  NATIONAL: 0x02,
  NETWORK_SPECIFIC: 0x03,
  SUBSCRIBER_NUMBER: 0x04,
  ALPHANUMERIC: 0x05,
  ABBREVIATED: 0x06,
} as const;

/** Numbering Plan Indicator. */
export const NPI = {
  UNKNOWN: 0x00,
  ISDN: 0x01,
  DATA: 0x03,
  TELEX: 0x04,
  LAND_MOBILE: 0x06,
  NATIONAL: 0x08,
  PRIVATE: 0x09,
  ERMES: 0x0a,
  INTERNET: 0x0e,
  WAP_CLIENT_ID: 0x12,
} as const;

/** esm_class : mode de messagerie (bits 1-0), type de message (bits 5-2), fonctionnalités GSM (bits 7-6). */
export const ESM_CLASS = {
  // Mode de messagerie
  DEFAULT_MODE: 0x00,
  DATAGRAM: 0x01,
  FORWARD: 0x02,
  STORE_FORWARD: 0x03,
  MODE_MASK: 0x03,
  // Type de message
  DEFAULT_TYPE: 0x00,
  MC_DELIVERY_RECEIPT: 0x04,
  INTERMEDIATE_DELIVERY_NOTIFICATION: 0x20,
  DELIVERY_ACKNOWLEDGEMENT: 0x08,
  USER_ACKNOWLEDGEMENT: 0x10,
  CONVERSATION_ABORT: 0x18,
  TYPE_MASK: 0x3c,
  // Fonctionnalités GSM
  UDH_INDICATOR: 0x40,
  REPLY_PATH: 0x80,
  UDHI_REPLY_PATH: 0xc0,
  /** Variante utilisée par certaines passerelles (Kannel). */
  KANNEL_UDH_INDICATOR: 0x43,
} as const;

/** registered_delivery. */
export const REGISTERED_DELIVERY = {
  NONE: 0x00,
  FINAL: 0x01,
  FAILURE: 0x02,
  SUCCESS: 0x03,
  SME_ACK_DELIVERY: 0x04,
  SME_ACK_USER: 0x08,
  SME_ACK_BOTH: 0x0c,
  INTERMEDIATE_NOTIFICATION: 0x10,
} as const;

/** data_coding (valeurs SMPP). */
export const DATA_CODING = {
  SMSC_DEFAULT: 0x00,
  IA5: 0x01,
  OCTET_UNSPECIFIED: 0x02,
  LATIN1: 0x03,
  OCTET_UNSPECIFIED_2: 0x04,
  JIS: 0x05,
  CYRILLIC: 0x06,
  LATIN_HEBREW: 0x07,
  UCS2: 0x08,
  PICTOGRAM: 0x09,
  ISO_2022_JP: 0x0a,
  EXTENDED_KANJI: 0x0d,
  KS_C_5601: 0x0e,
} as const;

export const PRIORITY_FLAG = {
  LEVEL_0: 0,
  LEVEL_1: 1,
  LEVEL_2: 2,
  LEVEL_3: 3,
  LEVEL_4: 4,
} as const;

/** message_state (query_sm_resp, TLV message_state). */
export const MESSAGE_STATE = {
  SCHEDULED: 0,
  ENROUTE: 1,
  DELIVERED: 2,
  EXPIRED: 3,
  DELETED: 4,
  UNDELIVERABLE: 5,
  ACCEPTED: 6,
  UNKNOWN: 7,
  REJECTED: 8,
  SKIPPED: 9,
} as const;

/** dest_flag de submit_multi. */
export const DEST_FLAG = {
  SME_ADDRESS: 1,
  DISTRIBUTION_LIST: 2,
} as const;

/** IEI des en-têtes UDH utilisés par la lib. */
export const UDH_IEI = {
  CONCAT_8BIT: 0x00,
  CONCAT_16BIT: 0x08,
  NATIONAL_SINGLE_SHIFT: 0x24,
  NATIONAL_LOCKING_SHIFT: 0x25,
} as const;
