#!/usr/bin/env node
import { createRequire } from 'node:module';
import { run } from './main.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const result = await run(process.argv.slice(2), console, version);
if ('server' in result) {
  const { server } = result;
  const stop = () => {
    console.log('stopping…');
    server.close().then(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} else {
  process.exitCode = result.exitCode;
}
