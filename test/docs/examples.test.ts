// Every ```ts block of the README and the guides is type-checked against the current API (src/), so a
// renamed option or method breaks this test instead of silently breaking the documentation.
//
// Documentation shortcuts are handled, everything else must compile:
// - `{ …, option }` / `bind: { … }`: `…` stands for the options the example leaves out;
// - `=> …`: a body the example leaves out;
// - free names (`client`, `to`, `db`…) are declared in PRELUDE below, with their real types when they
//   come from smpp-ts. A block that needs another one fails: declare it here on purpose.
// A block preceded by `<!-- doc-test: skip -->` is not checked (pseudo-code).
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const DOCS = [
  'README.md',
  'MIGRATION.md',
  'docs/PRODUCTION.md',
  ...readdirSync(join(ROOT, 'docs/guides'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/guides/${f}`),
];
const VIRTUAL = join(ROOT, '.doc-examples');

const PRELUDE = `
import type { SmppClient, SmppPool, SmppServer, ServerSession, PduParams, SmppClientOptions, BindOptions, SmppServerOptions } from 'smpp-ts';
import type { TestSmsc } from 'smpp-ts/testing';
import type * as vitest from 'vitest';
declare global {
  /** Stands for the options an example leaves out (\`{ …, option }\`). */
  const __base: SmppClientOptions & BindOptions & SmppServerOptions<{ accountId: string }>;
  /** Stands for a body an example leaves out (\`=> …\`). */
  const __any: any;
  const client: SmppClient;
  const pool: SmppPool;
  const server: SmppServer<{ accountId: string }>;
  const session: ServerSession<{ accountId: string }>;
  const smsc: TestSmsc;
  const to: string;
  const from: string;
  const text: string;
  const messageId: string;
  const source: string;
  const destination: string;
  const params: PduParams<'submit_sm'>;
  const key: string;
  const cert: string;
  const readFileSync: typeof import('node:fs').readFileSync;
  const expect: typeof vitest.expect;
  const it: typeof vitest.it;
  function sendOtp(client: SmppClient, to: string): Promise<unknown>;
  function isValidNumber(number: string): boolean;
  function unsubscribe(number: string): void;
  // Application objects (database, cache, HTTP framework, metrics…): their API is not ours.
  const db: any;
  const redis: {
    hset(key: string, field: string, value: string): Promise<number>;
    hdel(key: string, field: string): Promise<number>;
    hgetall(key: string): Promise<Record<string, string>>;
  };
  const vault: any;
  const app: {
    get(path: string, handler: (req: unknown, res: { status(code: number): { json(body: unknown): void } }) => void): void;
  };
  const queue: any;
  const metrics: any;
  const prometheus: any;
  const logger: any;
}
export {};
`;

/** Ambient module stubs for the third-party packages an example imports (a script: no import/export). */
const AMBIENT = `
declare module '@opentelemetry/api' {
  export const metrics: { getMeter(name: string): import('smpp-ts/otel').OtelMeterLike };
}
`;

/** Entry points an example may use without importing them (the import is implied by the text). */
const ENTRIES = {
  'smpp-ts': 'src/index.ts',
  'smpp-ts/testing': 'src/testing/index.ts',
} as const;

interface Block {
  file: string;
  line: number;
  code: string;
}

function extractBlocks(file: string): Block[] {
  const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() !== '```ts') continue;
    const skip = (lines[i - 1] ?? '').includes('doc-test: skip');
    const start = i + 1;
    let end = start;
    while (end < lines.length && lines[end]!.trim() !== '```') end++;
    if (!skip) blocks.push({ file, line: start + 1, code: lines.slice(start, end).join('\n') });
    i = end;
  }
  return blocks;
}

/** Replaces the documentation placeholders (outside strings and comments: `…` there never matches). */
function desugar(code: string): string {
  return code.replace(/([{(,]\s*)…(?=\s*[,}])/g, '$1...__base').replace(/=>\s*…/g, '=> __any');
}

const blocks = DOCS.flatMap(extractBlocks);

/** Names exported by each entry point (values and types). */
function exportsOf(options: ts.CompilerOptions): Map<string, Set<string>> {
  const files = Object.values(ENTRIES).map((f) => join(ROOT, f));
  const program = ts.createProgram(files, options);
  const checker = program.getTypeChecker();
  const out = new Map<string, Set<string>>();
  for (const [module, file] of Object.entries(ENTRIES)) {
    const symbol = checker.getSymbolAtLocation(program.getSourceFile(join(ROOT, file))!)!;
    out.set(module, new Set(checker.getExportsOfModule(symbol).map((s) => s.name)));
  }
  return out;
}

/**
 * Adds `import { … } from 'smpp-ts'` (and smpp-ts/testing) for the exported names a block uses
 * without importing or declaring them.
 */
function withImplicitImports(code: string, exported: Map<string, Set<string>>): string {
  const imported = new Set<string>();
  for (const m of code.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const part of m[1]!.split(',')) {
      const name = part
        .replace(/\btype\b/, '')
        .split(/\bas\b/)
        .pop()!
        .trim();
      if (name) imported.add(name);
    }
  }
  const declared = new Set(
    [...code.matchAll(/\b(?:const|let|var|function|class|interface|type)\s+([A-Za-z_$][\w$]*)/g)].map(
      (m) => m[1]!,
    ),
  );
  const used = new Set(code.match(/\b[A-Za-z_$][\w$]*\b/g) ?? []);
  const taken = new Set<string>();
  const lines: string[] = [];
  for (const [module, names] of exported) {
    const missing = [...used].filter(
      (n) => names.has(n) && !imported.has(n) && !declared.has(n) && !taken.has(n),
    );
    for (const n of missing) taken.add(n);
    if (missing.length > 0) lines.push(`import { ${missing.join(', ')} } from '${module}';`);
  }
  return lines.length > 0 ? `${lines.join('\n')}\n${code}` : code;
}
const fileOf = (b: Block, i: number) =>
  join(VIRTUAL, `${b.file.replace(/[^a-z0-9]+/gi, '_')}_${b.line}_${i}.ts`);

function typeCheck(): Map<string, string[]> {
  const sources = new Map<string, string>([
    [join(VIRTUAL, 'prelude.d.ts'), PRELUDE],
    [join(VIRTUAL, 'ambient.d.ts'), AMBIENT],
  ]);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noUncheckedIndexedAccess: true,
    skipLibCheck: true,
    noEmit: true,
    types: ['node'],
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    baseUrl: ROOT,
    paths: {
      'smpp-ts': ['src/index.ts'],
      'smpp-ts/testing': ['src/testing/index.ts'],
      'smpp-ts/otel': ['src/otel/index.ts'],
    },
  };
  const exported = exportsOf(options);
  blocks.forEach((b, i) => {
    sources.set(fileOf(b, i), `${withImplicitImports(desugar(b.code), exported)}\nexport {};\n`);
  });
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version, onError, create) => {
    const text = sources.get(resolve(name));
    if (text !== undefined) return ts.createSourceFile(name, text, version, true);
    return getSourceFile(name, version, onError, create);
  };
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => sources.has(resolve(name)) || fileExists(name);
  const readFile = host.readFile.bind(host);
  host.readFile = (name) => sources.get(resolve(name)) ?? readFile(name);
  const program = ts.createProgram([...sources.keys()], options, host);

  const errors = new Map<string, string[]>();
  for (const d of ts.getPreEmitDiagnostics(program)) {
    const name = d.file ? resolve(d.file.fileName) : 'global';
    const where = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line : 0;
    const message = `line ${where + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
    errors.set(name, [...(errors.get(name) ?? []), message]);
  }
  return errors;
}

describe('documentation examples', () => {
  const errors = typeCheck();

  it('finds the examples', () => {
    expect(blocks.length).toBeGreaterThan(40);
    // The prelude itself must compile, or every block would pass for the wrong reason.
    expect(errors.get(join(VIRTUAL, 'prelude.d.ts')) ?? []).toEqual([]);
    expect(errors.get(join(VIRTUAL, 'ambient.d.ts')) ?? []).toEqual([]);
    expect(errors.get('global') ?? []).toEqual([]);
  });

  blocks.forEach((b, i) => {
    it(`${b.file}:${b.line} compiles`, () => {
      const found = errors.get(fileOf(b, i)) ?? [];
      expect(found, `${relative(ROOT, dirname(fileOf(b, i)))}\n${desugar(b.code)}`).toEqual([]);
    });
  });
});
