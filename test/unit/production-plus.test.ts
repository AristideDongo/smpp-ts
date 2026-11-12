import { describe, expect, it } from 'vitest';
import {
  MemoryDedupStore,
  RequestQueue,
  estimateText,
  nonGsm7Characters,
  normalizeForGsm7,
  prepareText,
} from '../../src/index.js';
import { createPendingRequest } from '../../src/session/window.js';
import { Deduplicator } from '../../src/utils/dedup.js';

describe('normalizeForGsm7', () => {
  it('replaces typographic punctuation and keeps GSM7 characters', () => {
    const r = normalizeForGsm7('L’été «cool» – à bientôt…');
    // ô has no punctuation equivalent: kept in punctuation mode
    expect(r.text).toBe('L\'été "cool" - à bientôt...');
    expect(r.gsm7).toBe(false);
    expect(r.replacements.map((x) => x.from)).toEqual(['’', '«', '»', '–', ' ', '…']);
    expect(r.replacements[0]).toEqual({ index: 1, from: '’', to: "'" });
  });

  it('transliterates accented letters missing from GSM7 only in transliterate mode', () => {
    const r = normalizeForGsm7('Côte d’Ivoire, garçon, cœur, naïve, été', { mode: 'transliterate' });
    expect(r.text).toBe("Cote d'Ivoire, garcon, coeur, naive, été");
    expect(r.gsm7).toBe(true);
  });

  it('removes invisible characters and leaves emoji alone', () => {
    const r = normalizeForGsm7('a​b﻿c 🎉', { mode: 'transliterate' });
    expect(r.text).toBe('abc 🎉');
    expect(r.gsm7).toBe(false);
  });

  it('never replaces a character a national table can encode', () => {
    // ç is in the Turkish single shift table
    expect(normalizeForGsm7('ç', { mode: 'transliterate', shift: 'tr' }).text).toBe('ç');
    expect(normalizeForGsm7('ç', { mode: 'transliterate' }).text).toBe('c');
  });

  it('lists the characters that force UCS2', () => {
    expect(nonGsm7Characters('Côte d’Ivoire ô')).toEqual(['ô', '’']);
    expect(nonGsm7Characters('hello €')).toEqual([]);
  });
});

describe('prepareText / estimateText', () => {
  it('keeps the normalized text only when it saves segments', () => {
    const text = 'Votre code est 123456. Ne le partagez pas, c’est personnel et valable 10 minutes.';
    expect(text.length).toBeGreaterThan(70); // UCS2: 2 segments, GSM7: 1
    expect(prepareText(text).text).toBe(text); // off by default
    // A short text fits in one SMS either way: kept as it is
    expect(prepareText('c’est', { normalize: 'punctuation' }).text).toBe('c’est');
    const p = prepareText(text, { normalize: 'punctuation' });
    expect(p.text).toContain("c'est");
    expect(p.replacements).toHaveLength(1);
    // Still UCS2 because of the emoji: nothing to gain, sent unchanged
    const emoji = 'C’est fait 🎉';
    expect(prepareText(emoji, { normalize: 'transliterate' })).toEqual({ text: emoji, replacements: [] });
  });

  it('does not normalize when a non-GSM encoding is forced', () => {
    const text = 'c’est';
    expect(prepareText(text, { normalize: 'punctuation', encoding: 'ucs2' }).text).toBe(text);
  });

  it('makes a forced GSM7 encoding possible', () => {
    const p = prepareText('c’est', { normalize: 'punctuation', encoding: 'gsm7' });
    expect(p.text).toBe("c'est");
  });

  it('estimates the cost and suggests normalization', () => {
    const text =
      'Bonjour, votre colis arrive aujourd’hui entre 14h et 16h. Merci de votre confiance et à bientôt sur notre boutique en ligne !';
    const e = estimateText(text);
    expect(e.encoding).toBe('ucs2');
    expect(e.segments).toBe(2);
    expect(e.nonGsm7).toEqual(['’', 'ô']);
    expect(e.suggestion).toEqual({ normalize: 'transliterate', segments: 1, encoding: 'gsm7' });

    const n = estimateText(text, { normalize: 'transliterate' });
    expect(n.encoding).toBe('gsm7');
    expect(n.segments).toBe(1);
    expect(n.segmentsWithoutNormalization).toBe(2);
    expect(n.replacements.map((r) => r.from)).toEqual(['’', 'ô']);
    expect(n.text).toContain("aujourd'hui");
    expect(n.suggestion).toBeUndefined();
  });

  it('suggests punctuation first when it is enough', () => {
    const e = estimateText(
      'Merci d’avoir commandé chez nous. Votre colis partira demain matin, bonne journée.',
    );
    expect(e.suggestion?.normalize).toBe('punctuation');
  });
});

describe('deduplication', () => {
  it('MemoryDedupStore remembers keys for their ttl and stays bounded', () => {
    let now = 0;
    const store = new MemoryDedupStore(3, () => now);
    expect(store.seen('a', 100)).toBe(false);
    expect(store.seen('a', 100)).toBe(true);
    now = 100;
    expect(store.seen('a', 100)).toBe(false); // expired, recorded again
    store.seen('b', 1000);
    store.seen('c', 1000);
    store.seen('d', 1000);
    expect(store.size).toBe(3);
    expect(store.seen('a', 1000)).toBe(false); // evicted as the oldest
  });

  it('Deduplicator: receipts on, messages off by default', () => {
    const d = new Deduplicator();
    expect(d.receipt('id1', 'DELIVRD', 'x>y')).toBe(false);
    expect(d.receipt('id1', 'DELIVRD', 'x>y')).toBe(true);
    expect(d.receipt('id1', 'UNDELIV', 'x>y')).toBe(false);
    expect(d.message('a', 'b', 0, Buffer.from('hi'))).toBe(false);
    expect(d.message('a', 'b', 0, Buffer.from('hi'))).toBe(false);
  });

  it('Deduplicator: messages when enabled, keyed on content', () => {
    const d = new Deduplicator({ messages: true, receipts: false });
    expect(d.receipt('id1', 'DELIVRD', 'x>y')).toBe(false);
    expect(d.receipt('id1', 'DELIVRD', 'x>y')).toBe(false);
    expect(d.message('a', 'b', 0, Buffer.from('hi'))).toBe(false);
    expect(d.message('a', 'b', 0, Buffer.from('hi'))).toBe(true);
    expect(d.message('a', 'b', 0, Buffer.from('ho'))).toBe(false);
    expect(d.message('a', 'c', 0, Buffer.from('hi'))).toBe(false);
  });

  it('uses a custom store', () => {
    const keys: string[] = [];
    const d = new Deduplicator({ store: { seen: (k) => (keys.includes(k) ? true : (keys.push(k), false)) } });
    d.receipt('1', 'DELIVRD', 'p');
    expect(d.receipt('1', 'DELIVRD', 'p')).toBe(true);
    expect(keys).toHaveLength(1);
  });
});

describe('priority queue (RequestQueue)', () => {
  const make = (priority?: number) =>
    createPendingRequest({ command: 'submit_sm', encoded: Buffer.alloc(16), timeoutMs: 0, priority }).request;

  it('serves higher priorities first, FIFO within a priority', () => {
    const q = new RequestQueue({ fairness: 0 });
    const low1 = make(0);
    const low2 = make(0);
    const high = make(3);
    const mid = make(1);
    for (const r of [low1, low2, high, mid]) q.push(r);
    expect(q.sizes).toEqual([2, 1, 0, 1]);
    expect(q.peek()).toBe(high);
    expect([q.shift(), q.shift(), q.shift(), q.shift()]).toEqual([high, mid, low1, low2]);
    expect(q.size).toBe(0);
  });

  it('clamps priorities to 0..3', () => {
    expect(make(9).priority).toBe(3);
    expect(make(-2).priority).toBe(0);
    expect(make(Number.NaN).priority).toBe(0);
    expect(make(1.7).priority).toBe(1);
  });

  it('starvation guard lets the longest-waiting lower request out', () => {
    const q = new RequestQueue({ fairness: 2 });
    const low = make(0);
    const mid = make(1);
    q.push(low);
    q.push(mid);
    const highs = Array.from({ length: 6 }, () => make(3));
    for (const h of highs) q.push(h);
    const order = Array.from({ length: 8 }, () => q.shift());
    // 2 high, then the oldest lower one (low), 2 high, then mid, then the rest
    expect(order).toEqual([highs[0], highs[1], low, highs[2], highs[3], mid, highs[4], highs[5]]);
  });

  it('peek and shift agree, and remove keeps the count right', () => {
    const q = new RequestQueue({ fairness: 1 });
    const a = make(0);
    const b = make(3);
    const c = make(3);
    q.push(a);
    q.push(b);
    q.push(c);
    for (let i = 0; i < 2; i++) {
      const next = q.peek();
      expect(q.shift()).toBe(next);
    }
    q.remove(c);
    q.remove(c);
    expect(q.size).toBe(q.sizes.reduce((x, y) => x + y, 0));
  });
});
