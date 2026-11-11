import { afterEach, describe, expect, it } from 'vitest';
import { type CliOutput, run } from '../../src/cli/main.js';
import { type InboundMessage, SmppClient, type SmppServer } from '../../src/index.js';
import { until } from '../helpers/raw-smsc.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
});

function capture() {
  const lines: string[] = [];
  const errors: string[] = [];
  const out: CliOutput = { log: (l) => lines.push(l), error: (l) => errors.push(l) };
  return { out, lines, errors };
}

async function simulator(...args: string[]) {
  const { out, lines } = capture();
  const result = await run(['smsc', '--port', '0', ...args], out);
  if (!('server' in result)) throw new Error('simulator did not start');
  const server: SmppServer = result.server;
  cleanups.push(() => server.close());
  return { server, port: server.address!.port, lines };
}

describe('CLI', () => {
  it('prints the help, the version, and rejects unknown commands or options', async () => {
    const help = capture();
    expect(await run(['--help'], help.out)).toEqual({ exitCode: 0 });
    expect(help.lines[0]).toMatch(/smpp-ts smsc/);
    expect(await run([], capture().out)).toEqual({ exitCode: 2 });
    const v = capture();
    expect(await run(['--version'], v.out, '9.9.9')).toEqual({ exitCode: 0 });
    expect(v.lines).toEqual(['9.9.9']);
    expect(await run(['nope'], capture().out)).toEqual({ exitCode: 2 });
    const bad = capture();
    expect(await run(['smsc', '--dlr', 'maybe'], bad.out)).toEqual({ exitCode: 2 });
    expect(bad.errors[0]).toMatch(/--dlr must be/);
    expect(await run(['smsc', '--unknown'], capture().out)).toEqual({ exitCode: 2 });
    expect(await run(['send', '--to', '1'], capture().out)).toEqual({ exitCode: 2 });
  });

  it('send → simulator: message ids, then the final receipt', async () => {
    const { port, lines } = await simulator('--system-id', 'demo', '--password', 'pw', '--dlr-delay', '20');
    const cli = capture();
    const result = await run(
      [
        'send',
        '--url',
        `smpp://127.0.0.1:${port}`,
        '--system-id',
        'demo',
        '--password',
        'pw',
        '--from',
        'APP',
        '--to',
        '+2250700000000',
        '--text',
        'Code 123456',
        '--dlr',
      ],
      cli.out,
    );
    expect(result).toEqual({ exitCode: 0 });
    expect(cli.lines).toEqual(['sent: 1 part(s), GSM7, message id(s): 1', 'receipt: DELIVERED']);
    expect(lines.some((l) => l.includes('submit_sm  APP → 2250700000000  id=1  "Code 123456"'))).toBe(true);
  });

  it('exit code 1 on an undeliverable receipt or a refused bind', async () => {
    const { port } = await simulator('--dlr', 'undeliverable', '--dlr-delay', '0', '--password', 'pw');
    const base = [
      'send',
      '--url',
      `smpp://127.0.0.1:${port}`,
      '--system-id',
      'x',
      '--from',
      'A',
      '--to',
      '1',
    ];
    expect(await run([...base, '--password', 'pw', '--text', 'hi', '--dlr'], capture().out)).toEqual({
      exitCode: 1,
    });
    const refused = capture();
    expect(await run([...base, '--password', 'bad', '--text', 'hi'], refused.out)).toEqual({ exitCode: 1 });
    expect(refused.errors[0]).toMatch(/ESME_RBINDFAIL/);
  });

  it('--echo answers each SMS with an MO, in UCS2', async () => {
    const { port } = await simulator('--echo', '--dlr', 'none');
    const client = new SmppClient({
      url: `smpp://127.0.0.1:${port}`,
      bind: { mode: 'transceiver', system_id: 'a', password: 'b' },
      reconnect: false,
    });
    cleanups.push(() => client.close());
    const messages: InboundMessage[] = [];
    client.on('message', (m) => messages.push(m));
    await client.connect();
    await client.sendText({ from: '1234', to: '2250700000000', text: 'Merci 🎉' });
    await until(() => messages.length === 1);
    expect(messages[0]).toMatchObject({ text: 'echo: Merci 🎉', from: '2250700000000', to: '1234' });
  });

  it('listens on 127.0.0.1 by default', async () => {
    const { server } = await simulator();
    expect(server.address!.address).toBe('127.0.0.1');
  });
});
