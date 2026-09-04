const {test}=require('node:test');
const assert=require('node:assert/strict');
const engine=require('../backtest-engine.js');
const loader=require('../backtest-data.js');
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`);
const DAY=86400000;
function fixture(){
 const stocks=['0.000001','1.600001'].map((code,i)=>({code,name:'测试'+i,profit:1,revenue:1,lowPE:80,highPE:200-i*40,lowPS:80,highPS:200-i*40,forecastUpdatedAt:'2026-01-01'}));
 const bars=Array.from({length:50},(_,i)=>({date:new Date(Date.UTC(2026,0,1)+i*DAY).toISOString().slice(0,10),close:100,rawClose:100,open:100,volume:1000}));
 return {version:1,start:'2026-01-22',end:'2026-02-18',market:'ALL',snapshots:[{at:'2026-01-20T10:00:00Z',sha:'baseline',stocks}],assets:stocks.map(s=>({...s,currency:'CNY',anchorCap:100e8,anchorClose:100,bars:structuredClone(bars)})),fx:{},warnings:[],source:{},failures:[]};
}
const opts={start:'2026-01-22',end:'2026-01-25',capital:10000,topN:1,frequency:'weekly',costBps:0};
exports.fixture=fixture;
if(require.main===module){
test('fills at subsequent open, never same signal close; fixed slots leave cash',()=>{
 const d=fixture();d.assets[0].bars.find(b=>b.date===opts.start).open=125;
 const r=engine.run(d,{...opts,topN:4});
 assert.equal(r.trades.length,2);near(r.trades[0].quantity,20);near(r.curve[0].cash,5000);near(r.curve[0].equity,9500);
 assert.ok(r.rebalances[0].selected.every(s=>s.signalDate<opts.start));
});
test('exact cash accounting and doubled costs on flat prices',()=>{
 const d=fixture();const r=engine.run(d,{...opts,costBps:10}),s=engine.run(d,{...opts,costBps:20});
 near(r.metrics.final,10000/1.001);near(r.metrics.fees,10000-r.metrics.final);near(r.curve[0].cash,0);
 assert.ok(s.metrics.final<r.metrics.final);assert.ok(r.curve.every(p=>p.cash>=0));
});
test('daily, weekly and monthly follow distinct calendar buckets',()=>{
 const d=fixture(), counts={daily:28,weekly:5,monthly:2};
 for(const [frequency,count] of Object.entries(counts)) assert.equal(engine.run(d,{...opts,end:d.end,frequency}).rebalances.length,count);
 near(engine.run(d,{...opts,end:d.end,frequency:'daily',costBps:10}).metrics.final,10000/1.001);
});
test('same-day forecasts and prices cannot influence selection',()=>{
 const d=fixture();d.snapshots.push({at:opts.start+'T00:01:00Z',sha:'later',stocks:[{...d.snapshots[0].stocks[1],highPE:500,highPS:500}]});
 d.assets[0].bars.find(b=>b.date===opts.start).rawClose=100000;
 const r=engine.run(d,{...opts,frequency:'daily'});
 assert.equal(r.rebalances[0].snapshotSha,'baseline');assert.equal(r.rebalances[0].selected[0].code,'0.000001');
 assert.equal(r.rebalances[1].snapshotSha,'later');assert.equal(r.rebalances[1].selected[0].code,'1.600001');
 assert.equal(r.trades.find(t=>t.side==='sell').date,'2026-01-23');
});
test('pending closed-market orders do not repeatedly rebalance completed holdings',()=>{
 const d=fixture();d.assets[1].bars=d.assets[1].bars.filter(b=>b.date!==opts.start);
 const r=engine.run(d,{...opts,topN:2});
 assert.deepEqual(r.trades.map(t=>[t.code,t.date,t.side]),[['0.000001','2026-01-22','buy'],['1.600001','2026-01-23','buy']]);
 assert.equal(r.finalHoldings.length,2);near(r.metrics.final,10000);
});
test('later US proceeds cannot fund earlier Asian buys',()=>{
 const d=fixture();d.assets[0].currency='USD';
 d.fx.USD=d.assets[0].bars.map(b=>({date:b.date,close:1}));
 d.snapshots[0].stocks=[d.snapshots[0].stocks[0]];
 d.snapshots.push({at:'2026-01-22T10:00:00Z',sha:'switch',stocks:[{code:'1.600001',name:'Asian',profit:1,lowPE:80,highPE:200,forecastUpdatedAt:'2026-01-01'}]});
 const r=engine.run(d,{...opts,frequency:'daily'});
 assert.equal(r.trades.find(t=>t.side==='sell').date,'2026-01-23');
 assert.equal(r.trades.find(t=>t.code==='1.600001').date,'2026-01-24');
});
test('monthly cash-limited buy survives a later US sale and fills next day',()=>{
 const d=fixture(),a=d.snapshots[0].stocks[0],b=d.snapshots[0].stocks[1];
 d.assets[0].currency='USD';d.fx.USD=d.assets[0].bars.map(b=>({date:b.date,close:1}));
 d.snapshots[0].stocks=[a];d.snapshots.push({at:'2026-01-31T10:00:00Z',sha:'switch',stocks:[b]});
 const r=engine.run(d,{...opts,end:'2026-02-05',frequency:'monthly'});
 assert.deepEqual(r.trades.map(t=>[t.side,t.code,t.date]),[['buy',a.code,'2026-01-22'],['sell',a.code,'2026-02-01'],['buy',b.code,'2026-02-02']]);
 near(r.curve.find(p=>p.date==='2026-02-01').cash,10000);
 near(r.curve.find(p=>p.date==='2026-02-02').cash,0);
});
test('partially filled orders retain shares, without daily notional rebalancing',()=>{
 const d=fixture(),a=d.snapshots[0].stocks[0],b=d.snapshots[0].stocks[1];
 const us={...structuredClone(d.assets[0]),code:'105.TEST',currency:'USD'};d.assets.push(us);
 d.fx.USD=us.bars.map(b=>({date:b.date,close:1}));
 d.snapshots[0].stocks=[a,{...a,code:us.code}];
 d.snapshots.push({at:'2026-01-31T10:00:00Z',sha:'switch',stocks:[a,b]});
 d.assets[0].bars.find(b=>b.date==='2026-02-01').open=140;
 d.assets[1].bars.find(b=>b.date==='2026-02-02').open=80;
 d.assets[1].bars.find(b=>b.date==='2026-02-03').open=120;
 const r=engine.run(d,{...opts,end:'2026-02-05',frequency:'monthly',topN:2});
 const buys=r.trades.filter(t=>t.code===b.code);
 assert.equal(buys.length,2);assert.equal(buys[0].date,'2026-02-01');near(buys[0].quantity,20);
 assert.equal(buys[1].date,'2026-02-02');near(buys[1].quantity,30);
 near(r.finalHoldings.find(h=>h.code===b.code).quantity,50);
 assert.ok(r.curve.every(p=>p.cash>=0));
});
test('FX uses prior date for fills, current close for NAV',()=>{
 const d=fixture();d.assets=d.assets.slice(0,1);d.assets[0].currency='USD';d.fx.USD=d.assets[0].bars.map(b=>({date:b.date,close:b.date<opts.start?7:8}));
 const r=engine.run(d,opts);near(r.trades[0].fx,7);near(r.curve[0].equity,10000*8/7);
});
test('explicit historical market cap supersedes current-share approximation',()=>{
 const d=fixture();d.assets[0].anchorCap=10000e8;
 d.assets[0].bars.forEach(b=>b.marketCap=100e8);
 const r=engine.run(d,opts);assert.equal(r.rebalances[0].selected[0].code,'0.000001');
});
test('missing asset is counted, insufficient trend cannot receive fake score',()=>{
 const d=fixture();d.assets=d.assets.slice(0,1);
 const r=engine.run(d,opts);assert.equal(r.rebalances[0].exclusions.行情缺失,1);
 d.assets[0].bars=d.assets[0].bars.filter(b=>b.date>=opts.start);
 assert.throws(()=>engine.run(d,opts),/没有可评分/);
});
test('held prices cannot silently disappear, stale holding valuation disclosed',()=>{
 const d=fixture();d.assets[0].bars=d.assets[0].bars.filter(b=>b.date<='2026-01-23');
 const r=engine.run(d,{...opts,end:d.end,frequency:'monthly'});
 assert.ok(r.diagnostics.staleHeldDays>0);assert.ok(r.warnings.some(w=>w.includes('超过10天')));
});
test('bad ranges, missing baseline, duplicate bars reject explicitly',()=>{
 assert.throws(()=>engine.run(fixture(),{...opts,end:opts.start}),/开始日期/);
 const d=fixture();d.snapshots[0].at=opts.start+'T01:00:00Z';assert.throws(()=>engine.run(d,opts),/开始日期前/);
 const e=fixture();e.assets[0].bars.push(e.assets[0].bars[0]);assert.throws(()=>engine.run(e,opts),/日期重复/);
});
test('quote adapter adjusts open, keeps raw close, dates by exchange timezone',()=>{
 const d={chart:{result:[{meta:{exchangeTimezoneName:'America/New_York',currency:'USD'},timestamp:[Date.parse('2026-01-22T01:00:00Z')/1000],indicators:{quote:[{close:[100],open:[80],volume:[20]}],adjclose:[{adjclose:[50]}]}}]}};
 const parsed=loader.parseChart(d);assert.equal(parsed.currency,'USD');assert.deepEqual(parsed.bars,[{date:'2026-01-21',rawClose:100,close:50,open:40,volume:20}]);
 delete d.chart.result[0].indicators.adjclose;assert.throws(()=>loader.parseChart(d),/复权/);
 assert.equal(loader.identity('116.00700').symbol,'0700.HK');assert.equal(loader.identity('105.BRK.B').symbol,'BRK-B');assert.equal(loader.identity('1.600519').symbol,'600519.SS');
});
}
