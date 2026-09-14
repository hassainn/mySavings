let strategistFeed = null;
let strategistLoading = false;
let strategistError = false;
function strategistStale() {
  const dates = [strategistFeed?.generatedAt, strategistFeed?.scanGeneratedAt].map(Date.parse);
  return dates.some(date => !Number.isFinite(date) || Date.now() - date > 4 * 86400000 || date - Date.now() > 300000);
}
async function loadStrategist() {
  if (strategistLoading) return;
  strategistLoading = true;
  strategistError = false;
  if (currentPage === 'strategist') strategist();
  try {
    const response = await fetch(`${DATA_ROOT}/strategist-plan.json`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Unavailable');
    const feed = await response.json();
    if (feed.schemaVersion !== 1 || !Array.isArray(feed.ideas) || !Array.isArray(feed.history)) throw new Error('Invalid feed');
    strategistFeed = feed;
  } catch { strategistError = true; }
  finally {
    strategistLoading = false;
    if (currentPage === 'strategist') strategist();
    if (currentPage === 'overview') overview();
  }
}
function strategistVerdict() {
  if (strategistError) return 'Feed unavailable. Watch only until a fresh plan can be loaded.';
  if (!strategistFeed) return 'Loading the daily plan…';
  if (strategistFeed.status === 'setup_required') return 'Awaiting the first complete market scan.';
  if (strategistStale()) return 'Saved plan is stale. Watch only until the scanner refreshes.';
  return strategistFeed.verdict;
}
function strategistPreview() {
  return `<section class="intel-brief"><div><div class="intel-kicker">DAILY STRATEGIST · HUMAN DECISIONS</div><h2>${escapeHTML(strategistVerdict())}</h2><p>Scanner evidence, daily continuity and optional AI commentary.</p></div><button class="btn" onclick="page('strategist')">Open daily plan →</button></section>`;
}
function strategist() {
  const p = strategistFeed;
  const blocked = strategistError || strategistStale() || p?.gate !== 'HEALTHY';
  const money = n => typeof n === 'number' && Number.isFinite(n) ? `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—';
  const ideas = p?.ideas || [];
  const watched = new Set(list.map(x => x.s));
  app.innerHTML = title('AI Strategist', `<button class="btn" onclick="loadStrategist()" ${strategistLoading ? 'disabled' : ''}>${strategistLoading ? 'Refreshing…' : '↻ Refresh saved plan'}</button>`) +
    `<section class="card scan-command strategist-command" aria-live="polite"><div class="intel-kicker">DAILY PLAN · ${escapeHTML(blocked ? 'WATCH ONLY' : 'HUMAN REVIEW')}</div><h2>${escapeHTML(strategistVerdict())}</h2><p>Plan: ${formatPublished(p?.generatedAt)} · Scanner: ${formatPublished(p?.scanGeneratedAt)}</p><p>Refresh loads the latest scheduled result. It does not run the scanner or place an order.</p></section>
    ${p?.status === 'setup_required' ? '<div class="notice">A complete Upstox scan is needed before review candidates can appear. The scheduled plan works without AI commentary.</div>' : ''}
    <div class="scan-console"><section><div class="section-head"><h2>Today’s candidates</h2><span class="muted">${ideas.length} ideas · scanner price references</span></div>
    <div class="signal-stack">${ideas.length ? ideas.map(idea => `<article class="card strategist-idea"><div class="section-head"><h3>${escapeHTML(idea.symbol)} ${watched.has(idea.symbol) ? '· Watching' : ''}</h3><span class="notice">${escapeHTML(blocked ? 'Watch' : idea.state)}</span></div><p>${escapeHTML(idea.name)} · ${escapeHTML(idea.pattern)} · Evidence ${escapeHTML(idea.confidence)}/99</p><div class="scan-summary"><div><small>Entry reference</small><b>${money(idea.entryTrigger)}</b></div><div><small>Structural stop</small><b>${money(idea.stop)}</b></div><div><small>2R reference</small><b>${money(idea.target2R)}</b></div></div><ul>${(idea.evidence || []).map(e => `<li>${escapeHTML(e)}</li>`).join('')}</ul>${(() => { const a = p?.analysis?.bySymbol?.[idea.symbol]; return a ? `<div class="analyst-read"><div class="analyst-verdict"><span class="verdict-chip ${escapeHTML(a.verdict)}">${escapeHTML(a.verdict)}</span><span class="muted">${escapeHTML(a.stage)}</span></div><p><b>Technical</b> — ${escapeHTML(a.technical)}</p><p><b>EPS YoY</b> — ${a.epsGrowth && a.epsGrowth.length ? a.epsGrowth.map(escapeHTML).join(' · ') : 'not verified'}${a.revenueGrowth ? ` · Rev ${escapeHTML(a.revenueGrowth)}` : ''}</p><div class="growth-tags"><span class="growth-chip qual-${escapeHTML(String(a.growthQualified || 'Not verified').replace(/\s+/g, '-'))}">Growth ${escapeHTML(a.growthQualified || 'Not verified')}</span><span class="growth-chip trend">${escapeHTML(a.earningsTrend || 'Not verified')}</span></div><p><b>Fundamental</b> — ${escapeHTML(a.fundamental)}</p><p class="muted"><b>Risk</b> — ${escapeHTML(a.risk)}</p></div>` : ''; })()}<small class="muted">Candle date: ${escapeHTML(idea.asOf)} · Original scan: ${escapeHTML(idea.scanState)}</small></article>`).join('') : '<div class="scan-empty"><h3>No eligible candidates</h3><p>The plan does not substitute sample stocks when data is missing or no setup qualifies.</p></div>'}</div>
    <div class="section-head"><h2>Continuity from the previous session</h2></div><section class="card strategist-idea">${p?.observations?.length ? p.observations.map(o => `<p><b>${escapeHTML(o.symbol)}</b> · ${escapeHTML(o.observation)}</p>`).join('') : '<p>No previous-session observations yet. Continuity builds as new daily scans arrive.</p>'}<p class="muted">Scan observations do not measure trade returns or prove whether an intraday stop or target was touched.</p></section></section>
    <aside class="scan-side"><section class="card"><small>VETERAN ANALYST · MINERVINI · O’NEIL · WEINSTEIN</small><h3>${p?.commentaryStatus === 'available' ? 'Market read' : 'Deterministic plan'}</h3>${p?.analysis?.analyst ? `<p class="muted" style="margin:-2px 0 9px">${escapeHTML(p.analysis.analyst)}</p>` : ''}<p>${escapeHTML(p?.commentary || (p?.commentaryStatus === 'unavailable' ? 'AI commentary is temporarily unavailable. The rule-based plan remains available.' : 'Commentary and per-stock technical + fundamental analysis appear when the grounded AI connection and scanner data are available.'))}</p><p class="muted">Educational research only. Commentary cannot change the gate, candidate list or scanner levels.</p></section>
    <section class="card"><h3>Scanner cautions</h3>${p?.cautions?.length ? p.cautions.map(c => `<p><b>${escapeHTML(c.symbol)}</b> · ${escapeHTML(c.reason)}</p>`).join('') : '<p>No cautions in the saved feed.</p>'}</section>
    <section class="card"><h3>Recent daily memory</h3>${p?.history?.length ? [...p.history].reverse().map(h => `<p><b>${escapeHTML(h.sessionDate)} · ${escapeHTML(h.gate)}</b><br>${escapeHTML(h.verdict)}</p>`).join('') : '<p>No saved sessions yet.</p>'}</section></aside></div>`;
}
