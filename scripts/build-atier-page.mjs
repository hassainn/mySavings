import { readFileSync } from "node:fs";

// Builds the standalone "Alpha Swing A-Tier" shareable page from a scanner
// results JSON (docs/data/scanner-results.json). Prints the full HTML to stdout.
//   node scripts/build-atier-page.mjs [path-to-scanner-results.json] > atier.html

const dataPath = process.argv[2] || "docs/data/scanner-results.json";
const j = JSON.parse(readFileSync(dataPath, "utf8"));
const S = Array.isArray(j.signals) ? j.signals : [];

const r1 = (n) => (Number.isFinite(n) ? Number(n.toFixed(1)) : 0);
const mapCard = (s) => ({
  s: s.symbol,
  n: s.name || s.symbol,
  c: s.close,
  chg: r1(s.changePct),
  st: s.state,
  rs: s.sepa?.rsRating ?? null,
  tr: s.sepa?.trendScore ?? 0,
  rv: r1(s.indicators?.relativeVolume || 0),
  ext: r1(s.sepa?.extensionPct || 0),
  rsi: Math.round(s.indicators?.rsi14 || 0),
  e: s.entryTrigger,
  sl: s.stop,
  t: s.target2R,
});

const APLUS = S.filter((x) => x.grade === "A+").map(mapCard);
const AGRADE = S.filter((x) => x.grade === "A").map(mapCard);

const NEARMISS = S.filter(
  (x) => x.sepa?.sepaBreakout && x.sepa?.rsRating >= 95 && !x.sepa?.superPerformer,
)
  .map((s) => {
    const c = mapCard(s);
    const rv50 = s.sepa?.rvol50;
    const ext = s.sepa?.extensionPct;
    const rsi = s.indicators?.rsi14;
    const pb = s.sepa?.pctBelow52High;
    const f = [];
    if (!(rv50 >= 2)) f.push(`volume ${rv50 == null ? "?" : rv50.toFixed(1)}× — needs ≥ 2×`);
    if (!(ext <= 2.5)) f.push(`extension ${(ext ?? 0).toFixed(1)}% — over 2.5%`);
    if (!(rsi == null || rsi >= 55)) f.push(`RSI ${Math.round(rsi)} — needs ≥ 55`);
    if (!(pb <= 10)) f.push("more than 10% below the 52-week high");
    c.miss = f.length ? f[0] : "base tightness / top-25% of range";
    c.struct = f.length === 0;
    return c;
  })
  .sort((a, b) => (a.struct !== b.struct ? (a.struct ? -1 : 1) : a.ext - b.ext));

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDate = (iso) => {
  // Read the calendar date directly so an IST (+05:30) asOf keeps its own day
  // instead of rolling back to the UTC date.
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso);
  return `${parseInt(m[3], 10)} ${months[parseInt(m[2], 10) - 1]} ${m[1]}`;
};
const asOfIso = S[0]?.asOf || j.generatedAt || new Date().toISOString();
const mood = j.marketMood || {};
const uni = j.universe || {};
const META = {
  asOf: fmtDate(asOfIso),
  scanned: Number(uni.scanned || 0).toLocaleString("en-IN"),
  failed: String(uni.failed ?? 0),
  mood: mood.label || "—",
  adv: (mood.advancersPct ?? "—") + "%",
};

const payload = { META, APLUS, AGRADE, NEARMISS };

const html = `<title>Alpha Swing A-Tier</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Serif:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
:root{
  --bg:#EFF2EF; --surface:#FFFFFF; --surface-2:#F3F5F2;
  --ink:#161A18; --muted:#5B655F; --faint:#E4E8E3; --line:#D3D9D2;
  --accent:#0B7A52; --accent-ink:#0A5C3E; --accent-soft:#E0F0E8;
  --gold:#8A6410; --gold-soft:#F3E9CD;
  --up:#137A48; --up-soft:#E2F0E7;
  --down:#B23B3B; --down-soft:#F6E3E1;
  --wait:#8A6410; --wait-soft:#F5EAD0;
  --shadow:0 1px 2px rgba(20,30,25,.04),0 6px 20px rgba(20,30,25,.05);
  --serif:"IBM Plex Serif",Georgia,serif;
  --sans:"IBM Plex Sans",system-ui,sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,monospace;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --bg:#0E1512; --surface:#16201B; --surface-2:#1A251F;
    --ink:#E9EFEA; --muted:#93A199; --faint:#233029; --line:#2B3830;
    --accent:#39BC8B; --accent-ink:#9FE3C8; --accent-soft:#123326;
    --gold:#E1C27C; --gold-soft:#2C2513;
    --up:#4FBD84; --up-soft:#14301F;
    --down:#E38585; --down-soft:#331A1A;
    --wait:#DBB162; --wait-soft:#2C2513;
    --shadow:0 1px 2px rgba(0,0,0,.3),0 6px 22px rgba(0,0,0,.35);
  }
}
:root[data-theme="dark"]{
  --bg:#0E1512; --surface:#16201B; --surface-2:#1A251F;
  --ink:#E9EFEA; --muted:#93A199; --faint:#233029; --line:#2B3830;
  --accent:#39BC8B; --accent-ink:#9FE3C8; --accent-soft:#123326;
  --gold:#E1C27C; --gold-soft:#2C2513;
  --up:#4FBD84; --up-soft:#14301F;
  --down:#E38585; --down-soft:#331A1A;
  --wait:#DBB162; --wait-soft:#2C2513;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 6px 22px rgba(0,0,0,.35);
}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font-family:var(--sans);line-height:1.55;-webkit-font-smoothing:antialiased}
.wrap{max-width:1120px;margin:0 auto;padding:32px 20px 64px}
.tnum{font-variant-numeric:tabular-nums}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
.eyebrow{font-family:var(--mono);font-size:11px;font-weight:500;letter-spacing:.18em;text-transform:uppercase;color:var(--accent)}
h1{font-family:var(--serif);font-weight:600;font-size:34px;line-height:1.1;margin:8px 0 6px;text-wrap:balance;letter-spacing:-.01em}
.lede{color:var(--muted);font-size:15px;max-width:60ch;margin:0}
.themebtn{font-family:var(--sans);font-size:12px;color:var(--muted);background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:7px 13px;cursor:pointer;display:inline-flex;align-items:center;gap:7px;white-space:nowrap}
.themebtn:hover{border-color:var(--muted);color:var(--ink)}
.strip{display:flex;flex-wrap:wrap;gap:10px;margin:22px 0 6px}
.stat{background:var(--surface);border:1px solid var(--faint);border-radius:10px;padding:10px 14px;min-width:112px}
.stat .k{font-family:var(--mono);font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.stat .v{font-family:var(--serif);font-size:20px;font-weight:500;margin-top:2px}
.stat.mood .v{color:var(--wait)}
.legend{display:flex;flex-wrap:wrap;gap:16px 22px;align-items:center;margin:20px 0 4px;padding:13px 16px;background:var(--surface-2);border:1px solid var(--faint);border-radius:10px;font-size:12.5px;color:var(--muted)}
.legend b{color:var(--ink);font-weight:500}
.legend .grp{display:flex;align-items:center;gap:8px}
.chip{font-family:var(--mono);font-size:11px;font-weight:500;padding:2px 8px;border-radius:6px}
.rs-hi{background:var(--accent);color:#fff}
.rs-mid{background:transparent;color:var(--accent);border:1px solid var(--accent)}
.rs-na{background:var(--surface);color:var(--muted);border:1px solid var(--line)}
.mini{display:inline-flex;height:8px;width:44px;border-radius:3px;overflow:hidden;vertical-align:middle}
.mini i{display:block;height:100%}
section{margin-top:38px}
.sechead{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;padding-bottom:12px;border-bottom:2px solid var(--line)}
.sechead .mark{width:11px;height:11px;border-radius:3px;align-self:center}
.sechead h2{font-family:var(--serif);font-weight:600;font-size:21px;margin:0;letter-spacing:-.01em}
.sechead .n{font-family:var(--mono);font-size:13px;color:var(--muted)}
.sechead .desc{color:var(--muted);font-size:13.5px;margin-left:auto}
.t-aplus .mark{background:var(--gold)} .t-aplus h2{color:var(--gold)}
.t-a .mark{background:var(--accent)} .t-a h2{color:var(--accent)}
.t-nm .mark{background:var(--wait)} .t-nm h2{color:var(--wait)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(232px,1fr));gap:14px;margin-top:16px}
.card{background:var(--surface);border:1px solid var(--faint);border-radius:12px;padding:15px 16px 14px;box-shadow:var(--shadow);display:flex;flex-direction:column;transition:border-color .15s,transform .15s}
.card:hover{border-color:var(--line);transform:translateY(-1px)}
.c-top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
.tkr{font-family:var(--mono);font-size:15px;font-weight:600;letter-spacing:.01em}
.nm{font-size:11.5px;color:var(--muted);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:150px}
.px{display:flex;align-items:baseline;gap:8px;margin-top:11px}
.price{font-family:var(--mono);font-size:19px;font-weight:500}
.chg{font-family:var(--mono);font-size:12.5px;color:var(--up)}
.rr{margin:13px 0 3px}
.rr-track{position:relative;height:7px;border-radius:4px;background:var(--surface-2);overflow:hidden}
.rr-risk{position:absolute;top:0;bottom:0;left:0;background:var(--down-soft)}
.rr-reward{position:absolute;top:0;bottom:0;background:var(--up-soft)}
.rr-entry{position:absolute;top:-2px;bottom:-2px;width:2px;background:var(--muted)}
.rr-now{position:absolute;top:50%;width:9px;height:9px;border-radius:50%;background:var(--accent);border:2px solid var(--surface);transform:translate(-50%,-50%)}
.rr-cap{display:flex;justify-content:space-between;font-family:var(--mono);font-size:10px;color:var(--muted);margin-top:5px}
.metrics{display:grid;grid-template-columns:1fr 1fr;gap:6px 12px;margin:13px 0;padding:11px 0;border-top:1px solid var(--faint);border-bottom:1px solid var(--faint);font-size:12px}
.metrics div{display:flex;justify-content:space-between}
.metrics span{color:var(--muted)}
.metrics b{font-family:var(--mono);font-weight:500}
.metrics b.hot{color:var(--wait)}
.miss{font-size:11.5px;padding:7px 10px;border-radius:8px;margin:0 0 12px;background:var(--wait-soft);color:var(--wait)}
.miss.struct{background:var(--accent-soft);color:var(--accent-ink)}
.miss b{font-weight:600}
.levels{display:flex;flex-direction:column;gap:4px;font-size:12px}
.levels div{display:flex;justify-content:space-between}
.levels span{color:var(--muted)}
.levels b{font-family:var(--mono);font-weight:500}
.levels b.dn{color:var(--down)} .levels b.up{color:var(--up)}
.foot{display:flex;justify-content:space-between;align-items:center;margin-top:13px}
.pill{font-family:var(--mono);font-size:11px;font-weight:500;padding:3px 10px;border-radius:6px}
.pill.trig{background:var(--accent-soft);color:var(--accent-ink)}
.pill.armed{background:var(--wait-soft);color:var(--wait)}
.rrtag{font-family:var(--mono);font-size:11px;color:var(--muted)}
.notes{margin-top:44px;padding-top:22px;border-top:1px solid var(--line);display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:22px}
.notes h3{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);font-weight:500;margin:0 0 9px}
.notes p{font-size:13px;color:var(--muted);margin:0 0 9px;max-width:62ch}
.notes b{color:var(--ink);font-weight:500}
.disc{margin-top:22px;font-size:12px;color:var(--muted);background:var(--surface-2);border:1px solid var(--faint);border-radius:10px;padding:13px 16px}
@media (max-width:480px){h1{font-size:27px}.wrap{padding:24px 16px 52px}.sechead .desc{margin-left:0;flex-basis:100%}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>

<div class="wrap">
  <header class="top">
    <div>
      <div class="eyebrow">Alpha Swing · SEPA screen</div>
      <h1>A-tier swing setups</h1>
      <p class="lede">The strongest Minervini trend-template breakouts from the daily NSE scan — ranked A+, A, and near-miss super-performer — with entry, stop and 2R target for each.</p>
    </div>
    <button class="themebtn" id="themeBtn" aria-label="Toggle colour theme"><span id="themeIcon">◑</span><span id="themeTxt">Theme</span></button>
  </header>
  <div class="strip" id="strip"></div>
  <div class="legend">
    <span class="grp"><b>RS</b> <span class="chip rs-hi">≥95</span> <span class="chip rs-mid">80–94</span> <span class="chip rs-na">n/a</span></span>
    <span class="grp"><b>State</b> <span class="pill trig">Triggered</span> <span class="pill armed">Armed</span></span>
    <span class="grp"><b>Risk→reward bar</b> <span class="mini"><i style="width:33%;background:var(--down-soft)"></i><i style="width:67%;background:var(--up-soft)"></i></span> stop · <span style="color:var(--muted)">|</span> entry · <span style="color:var(--accent)">●</span> now · target</span>
  </div>
  <section class="t-aplus"><div class="sechead t-aplus"><span class="mark"></span><h2>Tier A+</h2><span class="n" id="n-aplus"></span><span class="desc">Elite base breakouts — 8/8 trend, strong RS, confirmed volume</span></div><div class="grid" id="grid-aplus"></div></section>
  <section class="t-a"><div class="sechead t-a"><span class="mark"></span><h2>Tier A</h2><span class="n" id="n-a"></span><span class="desc">Strong Stage-2 breakouts one notch below A+</span></div><div class="grid" id="grid-a"></div></section>
  <section class="t-nm"><div class="sechead t-nm"><span class="mark"></span><h2>Near-miss super-performers</h2><span class="n" id="n-nm"></span><span class="desc">RS ≥ 95 breakouts, one strict gate from the elite tag</span></div><div class="grid" id="grid-nm"></div></section>
  <div class="notes">
    <div><h3>How the tiers are graded</h3>
      <p><b>A+</b> — a super-performer, or a Stage-2 breakout with a perfect 8/8 trend template, RS ≥ 88, and confidence ≥ 88.</p>
      <p><b>A</b> — Stage 2, trend ≥ 7/8, a breakout or fresh trigger, RS ≥ 80, confidence ≥ 80.</p>
      <p><b>Near-miss</b> — RS ≥ 95 with a SEPA breakout that failed one strict super-performer gate; several names also appear in A+ (a different lens on the same setup).</p></div>
    <div><h3>Super-performer gates</h3>
      <p>On top of a Stage-2 SEPA breakout: <b>RS ≥ 95 · volume ≥ 2× 50-day · extension ≤ 2.5% past pivot · RSI ≥ 55 · within 10% of the 52-week high · close in the top 25% of the day’s range · a tight contracting base.</b> All must hold on the same bar.</p></div>
    <div><h3>Reading a card</h3>
      <p>Price is the last close. <b>Ext</b> is how far price has already run past the 20-day pivot — higher means more chase risk. The bar spans stop→target; the dot is where price sits now. Every setup is framed at a 2R target.</p></div>
  </div>
  <div class="disc" id="disc"></div>
</div>

<script>
const P=${JSON.stringify(payload)};
const META=P.META,APLUS=P.APLUS,AGRADE=P.AGRADE,NEARMISS=P.NEARMISS;
const fmt=n=>n.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
const rsCls=r=>r==null?'rs-na':r>=95?'rs-hi':'rs-mid';
function bar(d){
  const span=d.t-d.sl;
  const entryPct=span>0?Math.max(0,Math.min(100,(d.e-d.sl)/span*100)):33;
  const nowPct=span>0?Math.max(0,Math.min(100,(d.c-d.sl)/span*100)):50;
  return '<div class="rr"><div class="rr-track">'
    +'<div class="rr-risk" style="width:'+entryPct.toFixed(1)+'%"></div>'
    +'<div class="rr-reward" style="left:'+entryPct.toFixed(1)+'%;right:0"></div>'
    +'<div class="rr-entry" style="left:'+entryPct.toFixed(1)+'%"></div>'
    +'<div class="rr-now" style="left:'+nowPct.toFixed(1)+'%"></div>'
    +'</div><div class="rr-cap"><span>stop '+fmt(d.sl)+'</span><span>tgt '+fmt(d.t)+'</span></div></div>';
}
function card(d){
  const extHot=d.ext>10?' class="hot"':'';
  return '<article class="card">'
    +'<div class="c-top"><div><div class="tkr">'+d.s+'</div><div class="nm">'+d.n+'</div></div>'
    +'<span class="chip '+rsCls(d.rs)+'">RS '+(d.rs==null?'—':d.rs)+'</span></div>'
    +'<div class="px"><span class="price tnum">₹'+fmt(d.c)+'</span><span class="chg tnum">+'+d.chg.toFixed(1)+'%</span></div>'
    +bar(d)
    +'<div class="metrics"><div><span>Trend</span><b>'+d.tr+'/8</b></div><div><span>RVol</span><b>'+d.rv+'×</b></div>'
    +'<div><span>Ext</span><b'+extHot+'>'+d.ext+'%</b></div><div><span>RSI</span><b>'+d.rsi+'</b></div></div>'
    +(d.miss?('<div class="miss'+(d.struct?' struct':'')+'"><b>Missed:</b> '+d.miss+'</div>'):'')
    +'<div class="levels"><div><span>Entry</span><b>'+fmt(d.e)+'</b></div>'
    +'<div><span>Stop</span><b class="dn">'+fmt(d.sl)+'</b></div>'
    +'<div><span>Target</span><b class="up">'+fmt(d.t)+'</b></div></div>'
    +'<div class="foot"><span class="pill '+(d.st==='Triggered'?'trig':'armed')+'">'+d.st+'</span><span class="rrtag">2R</span></div>'
    +'</article>';
}
document.getElementById('strip').innerHTML=[
  ['As of',META.asOf],['Universe',META.scanned+' scanned'],['Failures',META.failed],
  ['A+ / A / near-miss',APLUS.length+' / '+AGRADE.length+' / '+NEARMISS.length]
].map(x=>'<div class="stat"><div class="k">'+x[0]+'</div><div class="v tnum">'+x[1]+'</div></div>').join('')
+'<div class="stat mood"><div class="k">Market mood</div><div class="v">'+META.mood+' · '+META.adv+' adv</div></div>';
document.getElementById('grid-aplus').innerHTML=APLUS.map(card).join('')||'<p style="color:var(--muted);font-size:13px">No A+ setups in this scan.</p>';
document.getElementById('grid-a').innerHTML=AGRADE.map(card).join('')||'<p style="color:var(--muted);font-size:13px">No A-grade setups in this scan.</p>';
document.getElementById('grid-nm').innerHTML=NEARMISS.map(card).join('')||'<p style="color:var(--muted);font-size:13px">No near-miss super-performers in this scan.</p>';
document.getElementById('n-aplus').textContent=APLUS.length+' names';
document.getElementById('n-a').textContent=AGRADE.length+' names';
document.getElementById('n-nm').textContent=NEARMISS.length+' names';
document.getElementById('disc').innerHTML='<b style="color:var(--ink);font-weight:500">Not investment advice.</b> These are the deterministic outputs of a confluence screen on the '+META.asOf+' close — an educational research aid, not recommendations. Confidence is a scoring heuristic, not a win-rate. Prices, gaps and liquidity change; confirm every level and your own risk before acting.';
(function(){
  const root=document.documentElement,btn=document.getElementById('themeBtn'),ic=document.getElementById('themeIcon'),tx=document.getElementById('themeTxt');
  let saved=null; try{saved=localStorage.getItem('atier-theme')}catch(e){}
  if(saved){root.setAttribute('data-theme',saved)}
  const sync=()=>{const dark=root.getAttribute('data-theme')==='dark'||(!root.getAttribute('data-theme')&&matchMedia('(prefers-color-scheme:dark)').matches);ic.textContent=dark?'☀':'☾';tx.textContent=dark?'Light':'Dark';};
  sync();
  btn.addEventListener('click',()=>{const cur=root.getAttribute('data-theme')==='dark'?'light':'dark';root.setAttribute('data-theme',cur);try{localStorage.setItem('atier-theme',cur)}catch(e){}sync();});
})();
</script>`;

process.stdout.write(html);
