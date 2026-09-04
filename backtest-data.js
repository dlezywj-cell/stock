/* Historical private-repository snapshots + the stock page's existing quote proxy. */
const BacktestData = (() => {
    const PROXY='https://stock-proxy.dlezywj.workers.dev/?';
    const DAY=86400000;
    let dbPromise;
    const memory=new Map();
    function db() {
        if(!dbPromise) dbPromise=new Promise(resolve=>{
            if(typeof indexedDB==='undefined') return resolve(null);
            const request=indexedDB.open('stock_backtest_cache',1);
            request.onupgradeneeded=()=>request.result.createObjectStore('responses');
            request.onsuccess=()=>resolve(request.result); request.onerror=()=>resolve(null);
        });
        return dbPromise;
    }
    async function cached(key) {
        if(memory.has(key)) return memory.get(key);
        const database=await db(); if(!database) return null;
        return new Promise(resolve=>{
            const r=database.transaction('responses').objectStore('responses').get(key);
            r.onsuccess=()=>resolve(r.result || null); r.onerror=()=>resolve(null);
        });
    }
    async function saveCache(key,value) {
        memory.set(key,value);
        const database=await db(); if(!database) return;
        try { const tx=database.transaction('responses','readwrite'); tx.objectStore('responses').put(value,key); tx.onerror=()=>{}; } catch {}
    }
    async function clearCache() {
        memory.clear(); const database=await db();
        if(database) await new Promise((resolve,reject)=>{const tx=database.transaction('responses','readwrite');tx.objectStore('responses').clear();tx.oncomplete=resolve;tx.onerror=()=>reject(Error('缓存清理失败'));});
    }
    async function json(url,{headers={},signal,ttl=0,cacheKey=url}={}) {
        const saved=ttl ? await cached(cacheKey) : null;
        if(saved && Date.now()-saved.at<ttl) return saved.value;
        for(let attempt=0;attempt<3;attempt++) {
            if(signal?.aborted) throw new DOMException('已取消','AbortError');
            const timeout=new AbortController(), cancel=()=>timeout.abort();
            signal?.addEventListener('abort',cancel,{once:true});
            const timer=setTimeout(cancel,25000);
            try {
                const response=await fetch(url,{headers,signal:timeout.signal,cache:'no-store'});
                if(!response.ok) {
                    const error=Error(response.status===401 || response.status===403 ? `访问失败 (${response.status})，请检查 GitHub Token、权限或接口限额` : `请求失败 (${response.status})`);
                    error.permanent=response.status<500 && response.status!==429;
                    throw error;
                }
                const value=await response.json();
                if(ttl) await saveCache(cacheKey,{at:Date.now(),value});
                return value;
            } catch(error) {
                if(signal?.aborted) throw new DOMException('已取消','AbortError');
                if(error.permanent || attempt===2) throw error.name==='AbortError' ? Error('请求超时，请稍后重试') : error;
            } finally {clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
            await new Promise((resolve,reject)=>{
                const abort=()=>{clearTimeout(retry);reject(new DOMException('已取消','AbortError'));};
                const retry=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},500*(attempt+1));
                signal?.addEventListener('abort',abort,{once:true});
            });
        }
    }
    async function parallel(items,limit,fn,signal) {
        const results=new Array(items.length); let cursor=0;
        await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
            while(cursor<items.length) {if(signal?.aborted) throw new DOMException('已取消','AbortError');const i=cursor++;results[i]=await fn(items[i],i);}
        })); return results;
    }
    function identity(code) {
        let secid=code;
        if(code.endsWith('.SH')) secid='1.'+code.slice(0,-3);
        else if(code.endsWith('.SZ')) secid='0.'+code.slice(0,-3);
        else if(code.endsWith('.HK')) secid='116.'+code.slice(0,-3);
        else if(!/^\d+\./.test(code)) secid='105.'+code;
        const [market,...rest]=secid.split('.'), ticker=rest.join('.');
        if(market==='0' || market==='1') return {secid,symbol:ticker+(market==='0'?'.SZ':'.SS'),currency:'CNY'};
        if(market==='116') return {secid,symbol:String(Number(ticker)).padStart(4,'0')+'.HK',currency:'HKD'};
        if(['105','106','107'].includes(market)) return {secid,symbol:ticker.replace(/\./g,'-'),currency:'USD'};
        throw Error('不支持的股票代码：'+code);
    }
    function parseChart(value) {
        const result=value?.chart?.result?.[0];
        if(!result?.timestamp?.length) throw Error(value?.chart?.error?.description || '无历史行情');
        const quote=result.indicators?.quote?.[0], adjusted=result.indicators?.adjclose?.[0]?.adjclose;
        if(!quote || !adjusted) throw Error('缺少复权价格');
        const timezone=result.meta?.exchangeTimezoneName || 'UTC';
        const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'});
        const rows=[];
        result.timestamp.forEach((t,i)=>{
            const close=quote.close?.[i], adj=adjusted[i], open=quote.open?.[i];
            if(!(Number.isFinite(close) && close>0 && Number.isFinite(adj) && adj>0)) return;
            const parts=Object.fromEntries(formatter.formatToParts(new Date(t*1000)).map(p=>[p.type,p.value]));
            rows.push({date:`${parts.year}-${parts.month}-${parts.day}`,rawClose:close,close:adj,open:Number.isFinite(open) && open>0 ? open*adj/close : null,volume:quote.volume?.[i] || 0});
        });
        return {bars:[...new Map(rows.map(b=>[b.date,b])).values()].sort((a,b)=>a.date.localeCompare(b.date)),currency:result.meta?.currency};
    }
    async function chart(symbol,start,end,signal) {
        const period1=Math.floor(Date.parse(start+'T00:00:00Z')/1000)-75*86400;
        const period2=Math.floor(Date.parse(end+'T00:00:00Z')/1000)+86400;
        const target=`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&events=div%2Csplits`;
        const value=await json(PROXY+encodeURIComponent(target),{signal,ttl:6*3600000});
        const parsed=parseChart(value); parsed.bars=parsed.bars.filter(b=>b.date<=end); return parsed;
    }
    async function load(options,config,progress,signal) {
        if(!config.token || !config.username || !config.repo) throw Error('请在设置中填写 GitHub Token，或先在股票池完成设置');
        const base=`https://api.github.com/repos/${encodeURIComponent(config.username)}/${encodeURIComponent(config.repo)}`;
        const headers={Accept:'application/vnd.github+json',Authorization:`Bearer ${config.token}`};
        const github=(path,ttl=0)=>json(base+path,{headers,signal,ttl,cacheKey:base+path});
        progress('读取历史保存记录',0);
        const branch=encodeURIComponent(config.branch || 'main'), cutoff=options.start+'T00:00:00Z';
        const baseline=await github(`/commits?path=data.json&sha=${branch}&until=${encodeURIComponent(cutoff)}&per_page=1`);
        if(!baseline.length) throw Error('开始日期之前没有 GitHub 保存记录，请选择更晚的日期');
        const commits=[...baseline];
        for(let page=1;page<=100;page++) {
            const rows=await github(`/commits?path=data.json&sha=${branch}&since=${encodeURIComponent(cutoff)}&until=${options.end}T23:59:59Z&per_page=100&page=${page}`);
            commits.push(...rows);
            if(rows.length<100) break;
            if(page===100) throw Error('历史记录过多，请缩短区间');
        }
        const ordered=[...new Map(commits.map(c=>[c.sha,c])).values()].sort((a,b)=>Date.parse(a.commit.committer.date)-Date.parse(b.commit.committer.date));
        // Only the last commit known before each UTC-day signal cutoff can affect this daily model.
        const needed=new Map();let pointer=-1;
        for(let day=Date.parse(options.start+'T00:00:00Z');day<=Date.parse(options.end+'T00:00:00Z');day+=DAY) {
            while(pointer+1<ordered.length && Date.parse(ordered[pointer+1].commit.committer.date)<day) pointer++;
            if(pointer>=0) needed.set(ordered[pointer].sha,ordered[pointer]);
        }
        let done=0;
        const snapshots=await parallel([...needed.values()],4,async commit=>{
            const file=await github(`/contents/data.json?ref=${commit.sha}`,365*DAY);
            if(typeof file.content!=='string') throw Error('历史 data.json 无法读取：'+commit.sha.slice(0,7));
            const bytes=Uint8Array.from(atob(file.content.replace(/\s/g,'')),c=>c.charCodeAt(0));
            const stocks=JSON.parse(new TextDecoder().decode(bytes));
            if(!Array.isArray(stocks)) throw Error('历史股票池格式不兼容');
            progress(`读取历史股票池 ${++done}/${needed.size}`,.15*done/needed.size);
            // Copy only fields needed for scores; notes and unrelated private content stay out of exports.
            const clean=stocks.map(s=>({code:s.code,name:s.name,profit:s.profit,lowPE:s.lowPE,highPE:s.highPE,revenue:s.revenue,lowPS:s.lowPS,highPS:s.highPS,forecastUpdatedAt:StockScore.forecastDate(s)}));
            return {at:commit.commit.committer.date,sha:commit.sha,stocks:clean};
        },signal);
        snapshots.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
        const universe=new Map(), warnings=[], failures=[];
        snapshots.forEach(s=>s.stocks.forEach(stock=>{try {const id=identity(stock.code);if(options.market==='ALL' || options.market===id.currency) universe.set(stock.code,{code:stock.code,name:stock.name,...id});}catch(error){failures.push({code:stock.code,reason:error.message});}}));
        if(!universe.size) throw Error('历史股票池中没有所选市场的标的');
        const list=[...universe.values()], anchors=new Map();
        const quoteHosts=['push2.eastmoney.com','82.push2.eastmoney.com','push2delay.eastmoney.com'];
        let preferredHost=quoteHosts[0];
        for(let start=0;start<list.length;start+=50) {
            const batch=list.slice(start,start+50);
            progress(`读取市值 ${Math.min(start+50,list.length)}/${list.length}`,.15);
            let lastError;
            for(const host of [preferredHost,...quoteHosts.filter(h=>h!==preferredHost)]) {
                const missing=batch.filter(a=>!anchors.has(a.secid));
                if(!missing.length) break;
                const target=`https://${host}/api/qt/ulist.np/get?secids=${missing.map(a=>a.secid).join(',')}&fields=f12,f13,f2,f18,f20&invt=2&fltt=2`;
                try {
                    const result=await json(PROXY+encodeURIComponent(target),{signal,ttl:3600000});
                    const quotes=Array.isArray(result?.data?.diff) ? result.data.diff : Object.values(result?.data?.diff || {});
                    if(quotes.length) preferredHost=host;
                    for(const quote of quotes) {
                        const cap=Number(quote.f20),close=Number(quote.f2)>0?Number(quote.f2):Number(quote.f18);
                        if(cap>0 && close>0) anchors.set(`${quote.f13}.${quote.f12}`,{cap,close});
                    }
                } catch(error) {if(signal?.aborted) throw error;lastError=error;}
            }
            if(batch.some(a=>!anchors.has(a.secid))) warnings.push('部分最新股本估算数据不可用'+(lastError?'：'+lastError.message:''));
        }
        done=0;
        const assets=(await parallel(list,4,async asset=>{
            try {
                const response=await chart(asset.symbol,options.start,options.end,signal), anchor=anchors.get(asset.secid);
                if(response.currency && response.currency!==asset.currency) throw Error('行情币种与市场不一致');
                if(!anchor || !(anchor.cap>0 && anchor.close>0)) throw Error('缺少当前市值或价格，无法估算历史股本');
                return {...asset,bars:response.bars,anchorCap:anchor.cap,anchorClose:anchor.close};
            } catch(error) {if(signal?.aborted) throw error;failures.push({code:asset.code,name:asset.name,reason:error.message});return null;}
            finally {progress(`读取历史行情 ${++done}/${list.length}`,.15+.75*done/list.length);}
        },signal)).filter(Boolean);
        if(!assets.length) throw Error('历史行情加载失败；请稍后重试或导入回测数据文件。'+(failures[0]?.reason || ''));
        const fx={};
        if(assets.some(a=>a.currency!=='CNY')) {
            progress('读取汇率',.93);
            const usd=await chart('CNY=X',options.start,options.end,signal);
            fx.USD=usd.bars.map(b=>({date:b.date,close:b.rawClose}));
            if(assets.some(a=>a.currency==='HKD')) {
                const hkd=await chart('HKD=X',options.start,options.end,signal);
                fx.HKD=[];
                for(const bar of hkd.bars) {
                    const i=ScoreBacktest.prior(fx.USD,bar.date,true);
                    if(i>=0 && Date.parse(bar.date)-Date.parse(fx.USD[i].date)<=7*DAY) fx.HKD.push({date:bar.date,close:fx.USD[i].close/bar.rawClose});
                }
            }
        }
        if(failures.length) warnings.push(`${failures.length} 个标的缺少数据，未能参与评分；可在数据覆盖中查看`);
        warnings.push('历史市值按当前股本固定估算，增发、回购、股本变动可能影响 Score 和排名');
        progress('数据就绪',1);
        return {version:1,start:options.start,end:options.end,market:options.market,loadedAt:new Date().toISOString(),source:{forecasts:'GitHub 历史 data.json',prices:'Yahoo Finance，经现有股票池代理',marketCap:'东方财富最新市值，固定股本近似',fx:'Yahoo Finance USD/CNY 与 USD/HKD',repository:config.username+'/'+config.repo},snapshots,assets,fx,warnings,failures,universeCount:list.length};
    }
    return {load,clearCache,identity,parseChart};
})();
if(typeof module!=='undefined' && module.exports) module.exports=BacktestData;
