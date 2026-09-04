/* Score portfolio replay. No network, DOM, credentials or future-price eligibility checks. */
const ScoreBacktest = (() => {
    const scoring = typeof StockScore !== 'undefined' ? StockScore : require('./score.js');
    const DAY = 86400000;
    const positive = n => Number.isFinite(n) && n > 0;
    const epoch = d => Date.parse(d + 'T00:00:00Z');
    const localDay = d => new Date(d + 'T12:00:00');
    const age = (a,b) => (epoch(a) - epoch(b)) / DAY;
    function prior(rows, date, inclusive = false) {
        let lo=0, hi=rows.length;
        while(lo<hi) { const mid=(lo+hi)>>1; if(inclusive ? rows[mid].date<=date : rows[mid].date<date) lo=mid+1; else hi=mid; }
        return lo-1;
    }
    function bucket(date, frequency) {
        if(frequency==='daily') return date;
        if(frequency==='monthly') return date.slice(0,7);
        const d=new Date(epoch(date)), weekday=(d.getUTCDay()+6)%7;
        return new Date(+d-weekday*DAY).toISOString().slice(0,10);
    }
    function validate(data, options) {
        if(!data || data.version!==1 || !Array.isArray(data.snapshots) || !data.snapshots.length || !Array.isArray(data.assets)) throw Error('缺少历史股票池或行情数据');
        if(!/^\d{4}-\d{2}-\d{2}$/.test(options.start) || !/^\d{4}-\d{2}-\d{2}$/.test(options.end) || !Number.isFinite(epoch(options.start)) || !Number.isFinite(epoch(options.end)) || options.start>=options.end) throw Error('开始日期须早于结束日期');
        if(!positive(options.capital) || !Number.isInteger(options.topN) || options.topN<1 || options.topN>100) throw Error('检查初始资金及持仓数量（1–100）');
        if(!['daily','weekly','monthly'].includes(options.frequency) || !Number.isFinite(options.costBps) || options.costBps<0 || options.costBps>500) throw Error('检查调仓周期及单边成本（0–500基点）');
        if(options.start<data.start || options.end>data.end) throw Error(`数据范围为 ${data.start} 至 ${data.end}，请重新加载所需区间`);
        if(!data.snapshots.some(s=>Date.parse(s.at)<epoch(options.start))) throw Error('开始日期前没有已保存的股票池，请选择更晚的开始日期');
    }
    function run(data, options, progress = () => {}) {
        options={market:'ALL',...options};
        validate(data, options);
        const cost=options.costBps/10000, snapshots=[...data.snapshots].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
        const assets=new Map(), fx=data.fx || {}, warnings=new Set(data.warnings || []);
        for(const asset of data.assets) {
            if(options.market!=='ALL' && asset.currency!==options.market) continue;
            if(assets.has(asset.code)) throw Error('行情数据包含重复代码：'+asset.code);
            const bars=asset.bars.filter(b=>positive(b.close)).map(b=>({...b})).sort((a,b)=>a.date.localeCompare(b.date));
            if(bars.some((b,i)=>i && b.date===bars[i-1].date)) throw Error('行情日期重复：'+asset.code);
            assets.set(asset.code,{...asset,bars,byDate:new Map(bars.map(b=>[b.date,b]))});
        }
        for(const rows of Object.values(fx)) rows.sort((a,b)=>a.date.localeCompare(b.date));
        const days=[...new Set([...assets.values()].flatMap(a=>a.bars.map(b=>b.date)))].filter(d=>d>=options.start && d<=options.end).sort();
        if(!days.length) throw Error('所选区间没有交易行情');
        function rate(currency,date,inclusive=false) {
            if(currency==='CNY') return 1;
            const rows=fx[currency] || [], i=prior(rows,date,inclusive);
            if(i<0 || !positive(rows[i].close) || age(date,rows[i].date)>10) return null;
            return rows[i].close;
        }
        function lastPrice(asset,date,inclusive) {
            const i=prior(asset.bars,date,inclusive);
            return i>=0 ? asset.bars[i] : null;
        }
        const positions=new Map(), trades=[], curve=[], rebalances=[];
        let cash=options.capital, fees=0, turnover=0, peak=options.capital, maxDrawdown=0, currentBucket=null, targets=null, snapshotIndex=-1, hadCandidate=false;
        let unavailableValuations=0, staleHeldDays=0;
        function nav(date,inclusive) {
            let result=cash;
            for(const [code,qty] of positions) {
                const asset=assets.get(code), bar=lastPrice(asset,date,inclusive), r=rate(asset.currency,date,inclusive);
                if(!bar || !r) throw Error(`持仓 ${code} 缺少 ${date} 的估值价格或汇率，回测已停止`);
                if(age(date,bar.date)>10) { staleHeldDays++; warnings.add(`持仓 ${code} 有超过10天无更新行情；按最后价格估值，结果可能不完整`); }
                result+=qty*bar.close*r;
            }
            return result;
        }
        function fill(code,qty,price,fxRate,date,side,score) {
            if(qty<=1e-10) return;
            const notional=qty*price*fxRate, fee=notional*cost;
            cash+=(side==='sell' ? notional-fee : -notional-fee);
            const held=(positions.get(code)||0)+(side==='sell' ? -qty : qty);
            if(held<1e-8) positions.delete(code); else positions.set(code,held);
            fees+=fee; turnover+=notional;
            trades.push({date,code,name:assets.get(code).name,side,quantity:qty,price,fx:fxRate,notional,fee,score:score ?? null});
        }
        days.forEach((date,dayIndex)=>{
            const cutoff=epoch(date);
            while(snapshotIndex+1<snapshots.length && Date.parse(snapshots[snapshotIndex+1].at)<cutoff) snapshotIndex++;
            const nextBucket=bucket(date,options.frequency);
            if(nextBucket!==currentBucket) {
                currentBucket=nextBucket;
                const snapshot=snapshots[snapshotIndex];
                if(!snapshot) throw Error('缺少调仓日之前的股票池记录：'+date);
                const ranked=[], exclusions={行情缺失:0,趋势不足:0,估值缺失:0,汇率缺失:0};
                for(const stock of snapshot.stocks) {
                    const asset=assets.get(stock.code);
                    if(!asset) {
                        const currency=/^(0|1)\./.test(stock.code)?'CNY':/^116\./.test(stock.code)?'HKD':'USD';
                        if(options.market==='ALL' || currency===options.market) exclusions.行情缺失++;
                        continue;
                    }
                    const i=prior(asset.bars,date), bar=asset.bars[i];
                    if(i<0 || age(date,bar.date)>10) { exclusions.行情缺失++; continue; }
                    if(!rate(asset.currency,date)) { exclusions.汇率缺失++; continue; }
                    const closes=asset.bars.slice(Math.max(0,i-19),i+1).map(b=>b.rawClose);
                    const state=scoring.trend(closes);
                    if(state===null) { exclusions.趋势不足++; continue; }
                    // A supplied per-date marketCap supersedes the fixed-share approximation.
                    const cap=positive(bar.marketCap) ? bar.marketCap/1e8 : positive(asset.anchorCap) && positive(asset.anchorClose) ? asset.anchorCap*bar.rawClose/asset.anchorClose/1e8 : null;
                    const result=scoring.calculate(stock,{cap,trend:state,now:localDay(date)});
                    if(result.total===null) { exclusions.估值缺失++; continue; }
                    ranked.push({code:stock.code,name:stock.name,score:result.total,confidence:result.confidence,signalDate:bar.date});
                }
                ranked.sort((a,b)=>b.score-a.score || a.code.localeCompare(b.code));
                const selected=ranked.slice(0,options.topN), equity=nav(date,false);
                hadCandidate ||= selected.length>0;
                unavailableValuations+=Object.values(exclusions).reduce((a,b)=>a+b,0);
                // Missing slots stay in cash; each valid slot targets 1/topN of pre-trade NAV.
                const slot=equity/options.topN;
                targets=new Map(selected.map(s=>[s.code,{value:slot,score:s.score}]));
                for(const code of positions.keys()) if(!targets.has(code)) targets.set(code,{value:0,score:null});
                rebalances.push({date,snapshotAt:snapshot.at,snapshotSha:snapshot.sha,equity,selected,eligible:ranked.length,exclusions});
            }
            if(targets) {
                // Asian markets open before US markets; later sales cannot finance earlier buys.
                for(const session of ['ASIA','US']) {
                    const opens=new Map();
                    for(const code of targets.keys()) {
                        const asset=assets.get(code), bar=asset.byDate.get(date), r=rate(asset.currency,date);
                        if((asset.currency==='USD'?'US':'ASIA')!==session) continue;
                        if(bar && positive(bar.open) && positive(bar.volume) && r) opens.set(code,{price:bar.open,fx:r});
                    }
                    // Orders persist until that market can trade or the next scheduled rebalance supersedes them.
                    for(const [code,qty] of [...positions]) {
                        if(!targets.has(code)) continue;
                        const quote=opens.get(code); if(!quote) continue;
                        const target=targets.get(code), wanted=target ? target.value/(quote.price*quote.fx) : 0;
                        if(qty>wanted) fill(code,qty-wanted,quote.price,quote.fx,date,'sell',target?.score);
                    }
                    const buys=[];
                    for(const [code,target] of targets) {
                        const quote=opens.get(code); if(!quote) continue;
                        const qty=Math.max(0,target.value/(quote.price*quote.fx)-(positions.get(code)||0));
                        if(qty>1e-10) buys.push({code,qty,...quote,score:target.score});
                    }
                    const required=buys.reduce((sum,b)=>sum+b.qty*b.price*b.fx*(1+cost),0), scale=required>0 ? Math.min(1,Math.max(0,cash)/required) : 0;
                    buys.forEach(b=>fill(b.code,b.qty*scale,b.price,b.fx,date,'buy',b.score));
                    // Do not rebalance already filled markets every day between scheduled decisions.
                    for(const code of opens.keys()) targets.delete(code);
                }
                if(!targets.size) targets=null;
            }
            if(cash < -1e-5) throw Error('资金核算异常：现金为负');
            cash=Math.max(0,cash);
            const equity=nav(date,true); peak=Math.max(peak,equity);
            const drawdown=equity/peak-1; maxDrawdown=Math.min(maxDrawdown,drawdown);
            curve.push({date,equity,cash,drawdown,holdings:positions.size});
            if(dayIndex%20===0) progress(dayIndex/days.length);
        });
        if(!hadCandidate) throw Error('没有可评分标的：请检查历史预测、20日行情窗口及市值数据');
        const final=curve.at(-1).equity, years=Math.max(1/365.25,age(options.end,options.start)/365.25);
        let previous=options.capital;
        const returns=curve.map(p=>{const r=p.equity/previous-1;previous=p.equity;return r;});
        const mean=returns.reduce((s,r)=>s+r,0)/returns.length;
        const variance=returns.length>1 ? returns.reduce((s,r)=>s+(r-mean)**2,0)/(returns.length-1) : 0;
        if(years<5) warnings.add('历史区间不足5年，不能据此判断策略的长期稳定性');
        if(trades.length<30) warnings.add('成交记录少于30笔，样本较少');
        if(rebalances.some(r=>r.selected.length<options.topN)) warnings.add('部分调仓日不足目标持仓数，空缺仓位保留现金');
        const finalHoldings=[...positions].map(([code,quantity])=>({code,name:assets.get(code).name,quantity,value:quantity*lastPrice(assets.get(code),days.at(-1),true).close*rate(assets.get(code).currency,days.at(-1),true)}));
        return {options,curve,trades,rebalances,finalHoldings,warnings:[...warnings],diagnostics:{unavailableValuations,staleHeldDays},metrics:{initial:options.capital,final,totalReturn:final/options.capital-1,cagr:(final/options.capital)**(1/years)-1,maxDrawdown,volatility:Math.sqrt(variance*252),sharpe:variance>0 ? mean/Math.sqrt(variance)*Math.sqrt(252) : null,fees,turnover:turnover/(curve.reduce((s,p)=>s+p.equity,0)/curve.length),tradeCount:trades.length,rebalanceCount:rebalances.length},source:data.source,generatedAt:new Date().toISOString()};
    }
    return {run,prior,bucket};
})();
if(typeof module!=='undefined' && module.exports) module.exports=ScoreBacktest;
