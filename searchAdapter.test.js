// server/services/searchAdapter.test.js — web search adapter tests.
// Run with: node --test searchAdapter.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { SearchRouter, rankResults } from './server/services/searchAdapter.js';

test('SearchRouter returns empty array when no providers', async () => {
  const router = new SearchRouter([]);
  const results = await router.search('test query');
  assert.equal(results.length, 0);
});

test('SearchRouter returns results from first provider', async () => {
  const called = [];
  const router = new SearchRouter([
    {
      id: 'test-provider',
      name: 'Test',
      async search(query) {
        called.push(query);
        return [
          { title: 'Result 1', url: 'https://example.com/1', claim: 'claim 1', kind: 'web_source' },
        ];
      },
    },
  ]);
  const results = await router.search('battery connector spec');
  assert.equal(results.length, 1);
  assert.equal(called[0], 'battery connector spec');
});

test('SearchRouter skips failed providers and tries next', async () => {
  const router = new SearchRouter([
    {
      id: 'failing',
      name: 'Failing',
      async search() { throw new Error('down'); },
    },
    {
      id: 'working',
      name: 'Working',
      async search() {
        return [
          { title: 'Result', url: 'https://example.com/ok', claim: 'ok', kind: 'web_source' },
        ];
      },
    },
  ]);
  const results = await router.search('query');
  assert.equal(results.length, 1);
  assert.equal(results[0].url, 'https://example.com/ok');
});

test('rankResults sorts by score descending', () => {
  const results = [
    { title: 'Unofficial', url: 'https://blog.example.com/x', claim: 'random', kind: 'web_source' },
    { title: 'Official Manual', url: 'https://example.com/support/manual', claim: 'battery connector pinout', kind: 'web_source' },
  ];
  const ranked = rankResults(results, 'battery connector spec');
  assert.equal(ranked[0].title, 'Official Manual');
  assert.ok(ranked[0].score > ranked[1].score);
});

test('rankResults limits to top 6', () => {
  const results = [];
  for (let i = 0; i < 10; i++) {
    results.push({ title: `Result ${i}`, url: `https://example.com/${i}`, claim: `claim ${i}`, kind: 'web_source' });
  }
  const ranked = rankResults(results, 'query');
  assert.equal(ranked.length, 6);
});

test('rankResults empty input', () => {
  const ranked = rankResults([], 'query');
  assert.equal(ranked.length, 0);
});
