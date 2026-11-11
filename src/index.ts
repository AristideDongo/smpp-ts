// Client / server
export { SmppClient } from './client/client.js';
export type {
  BindOptions,
  ClientEvents,
  InboundMessage,
  RawApi,
  SendTextOptions,
  SendTextResult,
  SmppClientOptions,
} from './client/client.js';
export { backoffDelay } from './client/reconnect.js';
export type { BackoffOptions, ReconnectOptions, RetryOptions } from './client/reconnect.js';

export { SmppServer } from './server/server.js';
export type {
  AuthContext,
  Authenticate,
  HandledCommand,
  Handler,
  HandlerResult,
  Handlers,
  ServerEvents,
  SmppServerOptions,
} from './server/server.js';
export { ServerSession } from './server/server-session.js';
export { BindFailureTracker, safeCompare } from './server/auth.js';
export type { BindFailurePolicy } from './server/auth.js';

// Session
export { Session } from './session/session.js';
export type {
  RequestOptions,
  ResponseOf,
  SessionEvents,
  SessionOptions,
  SessionTimeouts,
} from './session/session.js';
export { canSend, isBound } from './session/state-machine.js';
export type { BindMode, SessionRole, SessionState } from './session/state-machine.js';
export { TokenBucket } from './session/rate-limiter.js';
export type { RateLimitOptions } from './session/rate-limiter.js';
export { RequestQueue } from './session/window.js';

// Codec
export {
  PduCodec,
  decodePdu,
  defaultCodec,
  encodePdu,
  isCommand,
  DEFAULT_MAX_PDU_LENGTH,
} from './codec/pdu.js';
export type {
  CodecOptions,
  CustomTlvDefinition,
  DataSm,
  DeliverSm,
  Pdu,
  PduHeader,
  PduInput,
  PduOf,
  PduParams,
  SubmitSm,
} from './codec/pdu.js';
export { Framer } from './codec/framer.js';

// Protocol
export {
  COMMANDS,
  commandNameById,
  isResponseCommand,
  responseNameOf,
} from './protocol/commands.js';
export type {
  CommandName,
  CommandParams,
  DestAddress,
  RequestCommandName,
  ResponseCommandName,
  UnsuccessSme,
} from './protocol/commands.js';
export * from './protocol/constants.js';
export {
  COMMAND_STATUS,
  COMMAND_STATUS_V34_ALIASES,
  defaultStatusClassifier,
  isThrottlingStatus,
  statusName,
} from './protocol/status.js';
export type { CommandStatusName, StatusCategory, StatusClassifier } from './protocol/status.js';
export { TLVS } from './protocol/tlv.js';
export type {
  NetworkErrorCode,
  StandardTlvName,
  TlvDefinition,
  TlvParams,
  TlvType,
  UnknownTlv,
} from './protocol/tlv.js';

// Encodings
export {
  EncodingRegistry,
  asciiCodec,
  decodeText,
  encodeText,
  encodings,
  gsm7Codec,
  latin1Codec,
  ucs2Codec,
} from './encoding/registry.js';
export type { TextCodec } from './encoding/registry.js';
export {
  canEncodeGsm7,
  decodeGsm7,
  encodeGsm7,
  gsm7Length,
  packSeptets,
  unpackSeptets,
} from './encoding/gsm7.js';
export type { NationalLanguage } from './encoding/gsm7.js';
export { detectEncoding } from './encoding/detect.js';
export type { DetectOptions, DetectionResult, DetectedEncoding } from './encoding/detect.js';

// Utilities
export { countSegments, splitText } from './utils/segments.js';
export type { MultipartStrategy, SegmentInfo, SegmentOptions } from './utils/segments.js';
export {
  Reassembler,
  buildParts,
  buildUdh,
  decodeMessageContent,
  hasUdhIndicator,
  parseUdh,
} from './utils/multipart.js';
export type {
  ConcatInfo,
  InformationElement,
  OutboundPart,
  ParsedUdh,
  ReassembledMessage,
} from './utils/multipart.js';
export {
  buildDeliveryReport,
  formatDlr,
  isDeliveryReceipt,
  normalizeDlrStatus,
  normalizeMessageId,
  parseDlr,
} from './utils/dlr.js';
export type { DeliveryReport, DlrStatus, MessageIdFormat, ParsedDlrText } from './utils/dlr.js';
export { DeliveryTracker, isFinalDlrStatus } from './utils/delivery-tracker.js';
export type { DeliveryTrackerOptions, MessageOutcome, MessageStatus } from './utils/delivery-tracker.js';
export { isNumericAddress, resolveAddress } from './utils/address.js';
export type { AddressOptions, ResolvedAddress } from './utils/address.js';
export { formatAbsoluteTime, formatRelativeTime, parseSmppTime, smppTimeToDate } from './utils/time.js';
export type { SmppTime } from './utils/time.js';

// Transport
export { buildTlsOptions, parseSmppUrl } from './transport/connection.js';
export type { Endpoint, TlsClientOptions } from './transport/connection.js';
export { CidrList, parseProxyHeader } from './transport/proxy-protocol.js';
export type { ProxyHeader, ProxyProtocolOptions } from './transport/proxy-protocol.js';

// Errors, logs, metrics
export {
  SmppConnectionClosedError,
  SmppDecodeError,
  SmppAbortError,
  SmppError,
  SmppMultipartError,
  SmppQueueFullError,
  SmppStateError,
  SmppStatusError,
  SmppTimeoutError,
  SmppValidationError,
} from './errors.js';
export type { TimeoutKind } from './errors.js';
export { REDACTED, maskNumber, pinoAdapter, redactPdu, silentLogger } from './logger.js';
export type { Logger, RedactOptions } from './logger.js';
export type { Metric, MetricName } from './metrics.js';
