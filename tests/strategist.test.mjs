import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, enrichPlan, updateMemory } from '../scripts/generate-strategist-plan.mjs';

const now = new Date('2026-09-14T12:00:00Z');
const signal = { symbol: 'TEST', name: 'Test fixture', confidence: 90, state: 'Triggered', bias: 'bullish', asOf: '2026-09-14', close: 101, entryTrigger: 100, stop: 95, target2R: 110, evidence: ['Fixture evidence'] };
const scan = { status: 'live', generatedAt: now.toISOString(), marketMood: { evaluated: 100, score: 65 }, signals: [signal] };
const plan = (s = scan, memory = []) => buildPlan(s, {}, memory, now);

test('healthy market preserves scanner levels and permits human review only', () => {
  const p = plan();
  assert.equal(p.gate, 'HEALTHY');
  assert.equal(p.ideas[0].state, 'Review');
  assert.equal(p.ideas[0].stop, 95);
  assert.equal(p.ideas[0].entryTrigger, 100);
});
test('weak and cautious markets force all ideas to Watch', () => {
  for (const score of [0, 34, 44, 45, 54]) {
    const p = plan({ ...scan, marketMood: { evaluated: 100, score } });
    assert.equal(p.ideas[0].state, 'Watch');
    assert.equal(p.gate, score < 45 ? 'WEAK' : 'CAUTION');
  }
});
test('missing, stale, future, partial and invalid breadth fail closed', () => {
  for (const patch of [{ status: 'partial' }, { status: 'setup_required' }, { generatedAt: '2026-09-01' }, { generatedAt: '2026-10-01' }, { marketMood: { score: null, evaluated: 100 } }, { marketMood: { score: 99, evaluated: 0 } }]) {
    const p = plan({ ...scan, ...patch });
    assert.equal(p.gate, 'UNAVAILABLE');
    assert.ok(p.ideas.every(i => i.state === 'Watch'));
  }
  assert.equal(plan({}).ideas.length, 0);
});
test('bearish, invalid levels, stale candles and duplicate symbols cannot become candidates', () => {
  const signals = [signal, signal, ...[{ bias: 'bearish' }, { stop: 101 }, { entryTrigger: null }, { target2R: 99 }, { asOf: '2025-01-01' }, { confidence: NaN }].map((patch, i) => ({ ...signal, symbol: `X${i}`, ...patch }))];
  const p = plan({ ...scan, signals });
  assert.deepEqual(p.ideas.map(i => i.symbol), ['TEST']);
  assert.equal(p.cautions.length, 1);
});
test('memory replaces the same day and keeps 30 daily entries', () => {
  const p = plan();
  const initial = Array.from({ length: 35 }, (_, i) => ({ ...p, sessionDate: new Date(now - (i + 1) * 86400000).toISOString().slice(0, 10) }));
  const memory = updateMemory(updateMemory(initial, p), p);
  assert.equal(memory.length, 30);
  assert.equal(memory.filter(x => x.sessionDate === p.sessionDate).length, 1);
});
test('continuity uses prior session and requires a newer candle', () => {
  const previous = { sessionDate: '2026-09-13', ideas: [{ ...signal, asOf: '2026-09-13' }] };
  assert.match(plan(scan, [previous]).observations[0].observation, /Latest scanned close 101/);
  assert.match(plan({ ...scan, signals: [{ ...signal, asOf: '2026-09-13' }] }, [previous]).observations[0].observation, /outcome unknown/);
});
test('Gemini failure retains deterministic plan and never exposes provider error text', async () => {
  const p = plan();
  const result = await enrichPlan(p, {}, { apiKey: 'test', fetchImpl: async () => { throw Error('secret-value'); } });
  assert.equal(result.commentaryStatus, 'unavailable');
  assert.equal(result.gate, p.gate);
  assert.deepEqual(result.ideas, p.ideas);
  assert.ok(!JSON.stringify(result).includes('secret-value'));
});
test('model fields cannot override gate or price levels', async () => {
  const p = plan();
  const result = await enrichPlan(p, {}, { apiKey: 'test', fetchImpl: async () => ({ ok: true, json: async () => ({ output_text: JSON.stringify({ summary: 'Evidence requires review.', gate: 'BUY', ideas: [] }) }) }) });
  assert.equal(result.commentaryStatus, 'available');
  assert.equal(result.gate, 'HEALTHY');
  assert.deepEqual(result.ideas, p.ideas);
});
test('analyst enrichment adds per-stock analysis without touching ideas, gate or levels', async () => {
  const p = plan();
  const model = { analyst: 'SEPA + CANSLIM', summary: 'Breadth healthy; lead with strength.', stocks: [
    { symbol: 'TEST', stage: 'Stage 2 advancing', technical: 'Trend template intact', fundamental: 'EPS +40%', verdict: 'Leading', risk: 'Loss of stop invalidates' },
    { symbol: 'GHOST', stage: 'Unclear', technical: 'x', fundamental: 'y', verdict: 'Avoid', risk: 'z' } ] };
  const result = await enrichPlan(p, {}, { apiKey: 'test', fetchImpl: async () => ({ ok: true, json: async () => ({ output_text: JSON.stringify(model) }) }) });
  assert.equal(result.commentaryStatus, 'available');
  assert.equal(result.gate, 'HEALTHY');
  assert.deepEqual(result.ideas, p.ideas);
  assert.equal(result.analysis.bySymbol.TEST.verdict, 'Leading');
  assert.equal(result.analysis.bySymbol.TEST.stage, 'Stage 2 advancing');
  assert.ok(!('GHOST' in result.analysis.bySymbol));
});
test('analyst enrichment sanitises invalid verdict and stage from the model', async () => {
  const p = plan();
  const result = await enrichPlan(p, {}, { apiKey: 'test', fetchImpl: async () => ({ ok: true, json: async () => ({ output_text: JSON.stringify({ analyst: 'x', summary: 'ok', stocks: [{ symbol: 'TEST', stage: 'BUY NOW', technical: 'a', fundamental: 'b', verdict: 'STRONG BUY', risk: 'c' }] }) }) }) });
  assert.equal(result.analysis.bySymbol.TEST.verdict, 'Watch');
  assert.equal(result.analysis.bySymbol.TEST.stage, 'Unclear');
});
test('earnings discipline caps a leadership verdict when growth is weak, and captures EPS growth', async () => {
  const p = plan();
  const model = { analyst: 'x', summary: 'ok', stocks: [{ symbol: 'TEST', stage: 'Stage 2 advancing', technical: 't',
    epsGrowth: ['Q1 FY27 +8%', 'Q4 FY26 +14%', 'Q3 FY26 +22%'], revenueGrowth: '+6%', earningsTrend: 'Decelerating', growthQualified: 'No',
    fundamental: 'f', verdict: 'Leading', risk: 'r' }] };
  const result = await enrichPlan(p, {}, { apiKey: 'test', fetchImpl: async () => ({ ok: true, json: async () => ({ output_text: JSON.stringify(model) }) }) });
  const a = result.analysis.bySymbol.TEST;
  assert.equal(a.verdict, 'Watch'); // Leading capped by decelerating / not-qualified growth
  assert.equal(a.earningsTrend, 'Decelerating');
  assert.equal(a.growthQualified, 'No');
  assert.deepEqual(a.epsGrowth, ['Q1 FY27 +8%', 'Q4 FY26 +14%', 'Q3 FY26 +22%']);
});
