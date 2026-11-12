#!/usr/bin/env node
// Minimal SMSC "sink" for benchmarks: raw node:net, no SMPP library, so it measures the client only.
// Answers bind_*, enquire_link and unbind, and every submit_sm with a submit_sm_resp. Responses to one
// TCP chunk are written in one go, as a real SMSC does under load.
//
//   node bench/sink.mjs [port]   → prints "listening <port>" on stdout once ready
//
// Run in its own process (bench/run.mjs forks it) so client and sink do not share a CPU core.

import net from 'node:net';

const BIND_RESP = { 1: 0x80000001, 2: 0x80000002, 9: 0x80000009 };
const ENQUIRE_LINK = 0x00000015;
const UNBIND = 0x00000006;
const SUBMIT_SM = 0x00000004;

function header(length, id, status, seq) {
  const b = Buffer.allocUnsafe(length);
  b.writeUInt32BE(length, 0);
  b.writeUInt32BE(id, 4);
  b.writeUInt32BE(status, 8);
  b.writeUInt32BE(seq, 12);
  return b;
}

let messageId = 0;

const server = net.createServer((socket) => {
  socket.setNoDelay(true);
  let pending = Buffer.alloc(0);
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    const out = [];
    let offset = 0;
    while (pending.length - offset >= 16) {
      const length = pending.readUInt32BE(offset);
      if (length < 16 || length > 65536) {
        socket.destroy();
        return;
      }
      if (pending.length - offset < length) break;
      const id = pending.readUInt32BE(offset + 4);
      const seq = pending.readUInt32BE(offset + 12);
      offset += length;
      if (id === SUBMIT_SM) {
        const mid = Buffer.from(`${++messageId}\0`, 'latin1');
        const resp = header(16 + mid.length, 0x80000004, 0, seq);
        mid.copy(resp, 16);
        out.push(resp);
      } else if (BIND_RESP[id] !== undefined) {
        const sid = Buffer.from('sink\0', 'latin1');
        const resp = header(16 + sid.length, BIND_RESP[id], 0, seq);
        sid.copy(resp, 16);
        out.push(resp);
      } else if (id === ENQUIRE_LINK) {
        out.push(header(16, 0x80000015, 0, seq));
      } else if (id === UNBIND) {
        out.push(header(16, 0x80000006, 0, seq));
        socket.end(Buffer.concat(out));
        return;
      } else if ((id & 0x80000000) === 0) {
        out.push(header(16, 0x80000000, 0x00000003, seq)); // generic_nack ESME_RINVCMDID
      }
    }
    pending = offset === pending.length ? Buffer.alloc(0) : pending.subarray(offset);
    if (out.length > 0) socket.write(out.length === 1 ? out[0] : Buffer.concat(out));
  });
});

server.listen(Number(process.argv[2] ?? 0), '127.0.0.1', () => {
  process.stdout.write(`listening ${server.address().port}\n`);
});
process.on('disconnect', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
