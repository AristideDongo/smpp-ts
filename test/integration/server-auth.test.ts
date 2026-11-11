import { afterEach, describe, expect, it } from 'vitest';
import {
  COMMAND_STATUS,
  SmppClient,
  type SmppClientOptions,
  SmppError,
  SmppServer,
  type SmppServerOptions,
  SmppStatusError,
} from '../../src/index.js';
import { sleep, until } from '../helpers/raw-smsc.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
});

async function startServer(options: Partial<SmppServerOptions<unknown>> = {}) {
  const server = new SmppServer<unknown>({
    authenticate: ({ password }) => password === 'secret',
    handlers: { submit_sm: () => ({ message_id: 'M1' }) },
    ...options,
  });
  const { port } = await server.listen(0, '127.0.0.1');
  cleanups.push(() => server.close());
  return { server, port };
}

function makeClient(port: number, options: Partial<SmppClientOptions> = {}) {
  const client = new SmppClient({
    url: `smpp://127.0.0.1:${port}`,
    bind: { mode: 'transceiver', system_id: 'acme', password: 'secret' },
    reconnect: false,
    retry: false,
    ...options,
  });
  cleanups.push(() => client.close());
  return client;
}

async function bindStatus(port: number, system_id = 'acme', password = 'secret'): Promise<number | 'closed'> {
  const client = makeClient(port, { bind: { mode: 'transceiver', system_id, password } });
  try {
    await client.connect();
    return 0;
  } catch (err) {
    return err instanceof SmppStatusError ? err.status : 'closed';
  }
}

describe('#23: authenticate() only binds on true or an object', () => {
  it.each([
    ['0', 0],
    ['empty string', ''],
    ['NaN', Number.NaN],
    ["'yes'", 'yes'],
    ['1', 1],
    ['null', null],
    ['undefined', undefined],
    ['false', false],
  ])('returning %s → ESME_RBINDFAIL', async (_label, value) => {
    const { port } = await startServer({ authenticate: () => value as never });
    expect(await bindStatus(port)).toBe(COMMAND_STATUS.ESME_RBINDFAIL);
  });

  it.each([
    ['true', true],
    ['{}', {}],
    ['a context object', { id: 7 }],
  ])('returning %s → bound', async (_label, value) => {
    const { server, port } = await startServer({ authenticate: async () => value });
    expect(await bindStatus(port)).toBe(0);
    const [ss] = [...server.sessions];
    expect(ss?.context).toEqual(value === true ? undefined : value);
  });
});

describe('#24: only credential refusals count toward the IP ban', () => {
  it('binds over maxSessionsPerSystemId do not ban the IP', async () => {
    const { server, port } = await startServer({
      maxSessionsPerSystemId: 1,
      bindFailures: { maxAttempts: 3, banMs: 60_000 },
    });
    const reasons: string[] = [];
    server.on('bindFailed', (i) => reasons.push(`${i.reason}:${i.banned}`));
    expect(await bindStatus(port, 'campaign-app')).toBe(0);
    for (let i = 0; i < 5; i++)
      expect(await bindStatus(port, 'campaign-app')).toBe(COMMAND_STATUS.ESME_RBINDFAIL);
    expect(await bindStatus(port, 'otp-app')).toBe(0);
    expect(reasons).toEqual(Array(5).fill('limit:false'));
  });

  it('authenticate() throwing → ESME_RSYSERR, no ban', async () => {
    let down = true;
    const { server, port } = await startServer({
      bindFailures: { maxAttempts: 3, banMs: 60_000 },
      authenticate: () => {
        if (down) throw new Error('database down');
        return true;
      },
    });
    const reasons: string[] = [];
    server.on('bindFailed', (i) => reasons.push(i.reason));
    for (let i = 0; i < 5; i++) expect(await bindStatus(port)).toBe(COMMAND_STATUS.ESME_RSYSERR);
    down = false;
    expect(await bindStatus(port)).toBe(0);
    expect(reasons).toEqual(Array(5).fill('error'));
  });

  it('authenticate() timing out → ESME_RSYSERR, no ban, signal aborted', async () => {
    const signals: AbortSignal[] = [];
    const { server, port } = await startServer({
      handlerTimeout: 30,
      bindFailures: { maxAttempts: 2, banMs: 60_000 },
      authenticate: ({ signal, system_id }) => {
        signals.push(signal);
        return system_id === 'fast' ? true : new Promise(() => {});
      },
    });
    const reasons: string[] = [];
    server.on('bindFailed', (i) => reasons.push(i.reason));
    for (let i = 0; i < 3; i++) expect(await bindStatus(port, 'slow')).toBe(COMMAND_STATUS.ESME_RSYSERR);
    expect(await bindStatus(port, 'fast')).toBe(0);
    expect(reasons).toEqual(['timeout', 'timeout', 'timeout']);
    expect(signals.slice(0, 3).every((s) => s.aborted)).toBe(true);
    expect((signals[0]?.reason as SmppError).code).toBe('SMPP_HANDLER_TIMEOUT');
    expect(signals[3]?.aborted).toBe(false);
  });

  it('wrong passwords still ban the IP', async () => {
    const { server, port } = await startServer({ bindFailures: { maxAttempts: 2, banMs: 60_000 } });
    const failed: Array<{ reason: string; banned: boolean }> = [];
    server.on('bindFailed', ({ reason, banned }) => failed.push({ reason, banned }));
    await bindStatus(port, 'acme', 'bad');
    await bindStatus(port, 'acme', 'bad');
    expect(failed).toEqual([
      { reason: 'credentials', banned: false },
      { reason: 'credentials', banned: true },
    ]);
    expect(await bindStatus(port)).toBe('closed');
  });
});

describe('#25: handlers receive an AbortSignal', () => {
  it('aborted with SMPP_HANDLER_TIMEOUT once ESME_RSYSERR was sent', async () => {
    let seen: AbortSignal | undefined;
    let committed = false;
    const { port } = await startServer({
      handlerTimeout: 50,
      handlers: {
        submit_sm: async (_pdu, _ss, { signal }) => {
          seen = signal;
          await sleep(150);
          if (!signal.aborted) committed = true;
          return { message_id: 'late' };
        },
      },
    });
    const client = makeClient(port);
    await client.connect();
    await expect(client.submit({ destination_addr: '1' })).rejects.toMatchObject({
      status: COMMAND_STATUS.ESME_RSYSERR,
    });
    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toBeInstanceOf(SmppError);
    expect((seen?.reason as SmppError).code).toBe('SMPP_HANDLER_TIMEOUT');
    await sleep(150);
    expect(committed).toBe(false);
  });

  it('aborted with SMPP_SESSION_CLOSED when the session closes', async () => {
    let seen: AbortSignal | undefined;
    const { server, port } = await startServer({
      handlerTimeout: 60_000,
      handlers: {
        submit_sm: (_pdu, _ss, { signal }) => {
          seen = signal;
          return new Promise(() => {});
        },
      },
    });
    const client = makeClient(port);
    await client.connect();
    void client.submit({ destination_addr: '1' }).catch(() => {});
    await until(() => seen !== undefined);
    expect(seen?.aborted).toBe(false);
    for (const ss of server.sessions) ss.destroy();
    await until(() => seen?.aborted === true);
    expect((seen?.reason as SmppError).code).toBe('SMPP_SESSION_CLOSED');
  });

  it('not aborted when the handler answers in time', async () => {
    let seen: AbortSignal | undefined;
    const { port } = await startServer({
      handlers: {
        submit_sm: (_pdu, _ss, { signal }) => {
          seen = signal;
          return { message_id: 'ok' };
        },
      },
    });
    const client = makeClient(port);
    await client.connect();
    await client.submit({ destination_addr: '1' });
    expect(seen?.aborted).toBe(false);
  });
});

describe('#31: one close listener per session, not per in-flight handler', () => {
  it('25 slow handlers in flight: no MaxListenersExceededWarning, listener count stays constant', async () => {
    const warnings: Error[] = [];
    const onWarning = (w: Error) => {
      if (w.name === 'MaxListenersExceededWarning') warnings.push(w);
    };
    process.on('warning', onWarning);
    cleanups.push(async () => process.off('warning', onWarning));

    let running = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { server, port } = await startServer({
      inboundWindow: 25,
      handlers: {
        submit_sm: async () => {
          running++;
          await gate;
          return { message_id: 'M' };
        },
      },
    });
    const client = makeClient(port, { window: 25 });
    await client.connect();
    const [ss] = [...server.sessions];
    const before = ss!.session.listenerCount('close');

    const sends = Array.from({ length: 25 }, () => client.submit({ destination_addr: '1' }));
    await until(() => running === 25);
    expect(ss!.session.listenerCount('close')).toBe(before);

    release();
    await Promise.all(sends);
    expect(ss!.session.listenerCount('close')).toBe(before);
    await sleep(10); // warnings are emitted on the next tick
    expect(warnings).toEqual([]);
  });

  it('every in-flight handler is still aborted when the session closes', async () => {
    const signals: AbortSignal[] = [];
    const { server, port } = await startServer({
      inboundWindow: 15,
      handlerTimeout: 60_000,
      handlers: {
        submit_sm: (_pdu, _ss, { signal }) => {
          signals.push(signal);
          return new Promise(() => {});
        },
      },
    });
    const client = makeClient(port, { window: 15 });
    await client.connect();
    for (let i = 0; i < 15; i++) void client.submit({ destination_addr: '1' }).catch(() => {});
    await until(() => signals.length === 15);
    for (const ss of server.sessions) ss.destroy();
    await until(() => signals.every((s) => s.aborted));
    expect(signals.every((s) => (s.reason as SmppError).code === 'SMPP_SESSION_CLOSED')).toBe(true);
  });
});
