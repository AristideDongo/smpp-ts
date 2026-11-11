import type { DataSm, DeliverSm } from '../codec/pdu.js';
import type { EncodingRegistry } from '../encoding/registry.js';
import { toError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { DeliveryTracker } from '../utils/delivery-tracker.js';
import {
  type DeliveryReport,
  type MessageIdFormat,
  buildDeliveryReport,
  isDeliveryReceipt,
} from '../utils/dlr.js';
import { type ReassembledMessage, Reassembler, decodeMessageContent } from '../utils/multipart.js';

export interface InboundMessage {
  from: string;
  to: string;
  /** Text, or `undefined` for binary content. */
  text?: string;
  body: Buffer;
  dataCoding: number;
  parts: number;
  /** Missing segments (partialMessage only). */
  missing: number[];
  pdus: Array<DeliverSm | DataSm>;
}

/** Where the processor reports what it found. */
export interface InboundSink {
  deliveryReport(dlr: DeliveryReport, pdu: DeliverSm | DataSm): void;
  message(message: InboundMessage): void;
  partialMessage(message: InboundMessage): void;
}

export interface InboundProcessorOptions {
  registry: EncodingRegistry;
  logger: Logger;
  packedGsm7?: boolean;
  messageIdFormat?: MessageIdFormat;
  reassembly?: { ttl?: number; maxBuffers?: number };
  /** Receives every delivery receipt (multipart tracking). */
  tracker?: DeliveryTracker;
}

/**
 * Turns incoming deliver_sm / data_sm into delivery receipts and messages, reassembling multipart ones.
 * One instance can be shared by several sessions: the segments of a message, or the receipt of a message,
 * may arrive on another bind than the first segment or the submit.
 */
export class InboundProcessor {
  readonly tracker: DeliveryTracker | undefined;
  private readonly reassembler: Reassembler<DeliverSm | DataSm>;

  constructor(
    private readonly options: InboundProcessorOptions,
    private readonly sink: InboundSink,
  ) {
    this.tracker = options.tracker;
    this.reassembler = new Reassembler({
      ...(options.reassembly?.ttl !== undefined ? { ttl: options.reassembly.ttl } : {}),
      ...(options.reassembly?.maxBuffers !== undefined ? { maxBuffers: options.reassembly.maxBuffers } : {}),
      registry: options.registry,
      onPartial: (msg) => this.sink.partialMessage(toInbound(msg)),
    });
  }

  handle(pdu: DeliverSm | DataSm): void {
    try {
      const content = decodeMessageContent(
        { ...pdu, short_message: 'short_message' in pdu ? pdu.short_message : undefined } as Parameters<
          typeof decodeMessageContent
        >[0],
        { registry: this.options.registry, packedGsm7: this.options.packedGsm7 ?? false },
      );
      if (isDeliveryReceipt(pdu)) {
        const dlr = buildDeliveryReport(pdu, content.text, this.options.messageIdFormat ?? 'as-is');
        if (dlr) {
          this.sink.deliveryReport(dlr, pdu);
          this.tracker?.handle(dlr);
          return;
        }
      }
      if (content.concat) {
        const done = this.reassembler.add({
          source: pdu.source_addr,
          destination: pdu.destination_addr,
          concat: content.concat,
          body: content.body,
          dataCoding: pdu.data_coding,
          ...(content.udh?.shift ? { shift: content.udh.shift } : {}),
          meta: pdu,
        });
        if (done) this.sink.message(toInbound(done));
        return;
      }
      const msg: InboundMessage = {
        from: pdu.source_addr,
        to: pdu.destination_addr,
        body: content.body,
        dataCoding: pdu.data_coding,
        parts: 1,
        missing: [],
        pdus: [pdu],
      };
      if (content.text !== undefined) msg.text = content.text;
      this.sink.message(msg);
    } catch (err) {
      this.options.logger.error('failed to process inbound message', { error: toError(err).message });
    }
  }

  /** Drops incomplete messages and tracked messages. */
  clear(): void {
    this.reassembler.clear();
    this.tracker?.clear();
  }
}

function toInbound(msg: ReassembledMessage<DeliverSm | DataSm>): InboundMessage {
  const out: InboundMessage = {
    from: msg.source,
    to: msg.destination,
    body: msg.body,
    dataCoding: msg.dataCoding,
    parts: msg.total,
    missing: msg.missing,
    pdus: msg.segments.map((s) => s.meta),
  };
  if (msg.text !== undefined) out.text = msg.text;
  return out;
}

/** Whether a registered_delivery value asks for the final receipt whatever the outcome (bits 0-1 = 01). */
export function wantsFinalReceipt(registeredDelivery: number): boolean {
  return (registeredDelivery & 0x03) === 1;
}
