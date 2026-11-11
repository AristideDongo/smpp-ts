import net from 'node:net';
import { Framer } from '../../src/codec/framer.js';
import { type Pdu, type PduInput, decodePdu, encodePdu } from '../../src/codec/pdu.js';

export interface RawConnection {
  socket: net.Socket;
  received: Pdu[];
  send(pdu: PduInput): void;
  sendRaw(buf: Buffer): void;
}

export interface RawSmsc {
  port: number;
  connections: RawConnection[];
  /** Waits for a received PDU matching the predicate (any connection). */
  waitFor(
    pred: (pdu: Pdu, conn: RawConnection) => boolean,
    timeoutMs?: number,
  ): Promise<{ pdu: Pdu; conn: RawConnection }>;
  close(): Promise<void>;
}

/**
 * Hand-driven fake SMSC: each received PDU goes to `onPdu`, which decides what to answer.
 * By default, accepts any bind and answers enquire_link / unbind.
 */
export async function createRawSmsc(
  onPdu: (pdu: Pdu, conn: RawConnection) => void = defaultBehaviour,
): Promise<RawSmsc> {
  const connections: RawConnection[] = [];
  const waiters: Array<{
    pred: (pdu: Pdu, conn: RawConnection) => boolean;
    resolve: (v: { pdu: Pdu; conn: RawConnection }) => void;
  }> = [];
  const server = net.createServer((socket) => {
    const framer = new Framer();
    const conn: RawConnection = {
      socket,
      received: [],
      send: (pdu) => {
        if (!socket.destroyed) socket.write(encodePdu(pdu));
      },
      sendRaw: (buf) => {
        if (!socket.destroyed) socket.write(buf);
      },
    };
    connections.push(conn);
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      const { frames } = framer.push(chunk);
      for (const f of frames) {
        let pdu: Pdu;
        try {
          pdu = decodePdu(f);
        } catch {
          continue;
        }
        conn.received.push(pdu);
        onPdu(pdu, conn);
        for (const w of [...waiters]) {
          if (w.pred(pdu, conn)) {
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve({ pdu, conn });
          }
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    connections,
    waitFor(pred, timeoutMs = 5000) {
      for (const conn of connections) {
        const found = conn.received.find((p) => pred(p, conn));
        if (found) return Promise.resolve({ pdu: found, conn });
      }
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('waitFor timeout')), timeoutMs);
        waiters.push({
          pred,
          resolve: (v) => {
            clearTimeout(t);
            resolve(v);
          },
        });
      });
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of connections) c.socket.destroy();
        server.close(() => resolve());
      }),
  };
}

export function defaultBehaviour(pdu: Pdu, conn: RawConnection): void {
  switch (pdu.command) {
    case 'bind_transceiver':
    case 'bind_transmitter':
    case 'bind_receiver':
      conn.send({ command: `${pdu.command}_resp`, sequence_number: pdu.sequence_number, system_id: 'RAW' });
      break;
    case 'enquire_link':
      conn.send({ command: 'enquire_link_resp', sequence_number: pdu.sequence_number });
      break;
    case 'unbind':
      conn.send({ command: 'unbind_resp', sequence_number: pdu.sequence_number });
      conn.socket.end();
      break;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until a condition becomes true. */
export async function until(cond: () => boolean, timeoutMs = 5000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('until: timeout');
    await sleep(stepMs);
  }
}
