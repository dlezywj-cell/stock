(() => {
    const $=id=>document.getElementById(id);
    let dataset=null, result=null, stressed=null, controller=null, worker=null, busy=false;
    const dateString=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const yesterday=new Date();yesterday.setDate(yesterday.getDate()-1);
    $('end').value=dateString(yesterday);$('end').max=dateString(yesterday);$('start').max=dateString(yesterday);
    const start=new Date(yesterday);start.setMonth(start.getMonth()-3);$('start').value=dateString(start);
    for(const key of ['username','repo','branch','token']) $(''+key).value=localStorage.getItem('stock_sys_'+key)||({username:'dlezywj-cell',repo:'stockdata',branch:'main',token:''})[key];
    const pct=value=>Number.isFinite(value) ? (value*100).toFixed(2)+'%' : '—';
    const money=value=>Number.isFinite(value) ? (value/10000).toLocaleString('zh-CN',{maximumFractionDigits:2})+'万' : '—';
    const config=()=>Object.fromEntries(['username','repo','branch','token'].map(key=>[key,$(key).value.trim()]));
    const options=()=>({start:$('start').value,end:$('end').value,capital:Number($('capital').value)*10000,topN:Number($('top-n').value),frequency:$('frequency').value,market:$('market').value,costBps:Number($('cost').value)});
    function progress(text,value) {$('progress-area').hidden=false;$('status').textContent=text;$('progress').value=Math.max(0,Math.min(1,value));}
    function error(message) {$('error').hidden=!message;$('error').textContent=message || '';}
    function setBusy(value) {
        busy=value;
        document.querySelectorAll('#backtest-form input,#backtest-form select,#backtest-form button').forEach(el=>el.disabled=value);
        $('cancel').disabled=false;$('cancel').hidden=!value;
        $('run').textContent=value?'回测中…':'开始回测';
    }
    function execute(data,opts,stress,signal) {
        return new Promise((resolve,reject)=>{
            if(signal.aborted) return reject(new DOMException('已取消','AbortError'));
            worker=new Worker('backtest-worker.js?v=11');
            const cancel=()=>{worker?.terminate();worker=null;reject(new DOMException('已取消','AbortError'));};
            signal.addEventListener('abort',cancel,{once:true});
            const finish=()=>{signal.removeEventListener('abort',cancel);worker?.terminate();worker=null;};
            worker.onmessage=event=>{
                if(event.data.type==='progress') return progress('计算组合净值',.85+.15*event.data.value);
                finish();if(event.data.type==='error') reject(Error(event.data.message));else resolve(event.data);
            };
            worker.onerror=()=>{finish();reject(Error('回测计算失败，请刷新后重试'));};
            worker.postMessage({data,options:opts,stress});
        });
    }
    $('backtest-form').addEventListener('submit',async event=>{
        event.preventDefault();if(busy) return;
        const opts=options(), cfg=config();
        if(opts.start>=opts.end || opts.end>$('end').max) return error('开始日期须早于结束日期，结束日期最多为昨日');
        const testStress=$('stress').checked;
        controller=new AbortController();error('');$('results').hidden=true;setBusy(true);
        const signal=controller.signal;
        try {
            const sameSource=dataset?.imported || dataset?.source?.repository===cfg.username+'/'+cfg.repo && dataset?.source?.branch===cfg.branch;
            if(!dataset || !sameSource || dataset.start>opts.start || dataset.end<opts.end || dataset.market!=='ALL' && dataset.market!==opts.market) {
                dataset=await BacktestData.load(opts,cfg,(message,value)=>{if(!signal.aborted) progress(message,value*.85);},signal);
                dataset.source.branch=cfg.branch;
            }
            progress('计算组合净值',.85);
            const output=await execute(dataset,opts,testStress,controller.signal);
            result=output.result;stressed=output.stressed;
            render();progress('回测完成',1);
        } catch(e) {
            controller.abort();
            if(e.name==='AbortError') progress('已取消',0);else {error(e.message);progress('未完成',0);}
        } finally {setBusy(false);controller=null;}
    });
    $('cancel').onclick=()=>controller?.abort();
    $('save-settings').onclick=()=>{for(const [key,value] of Object.entries(config())) localStorage.setItem('stock_sys_'+key,value);$('dataset-label').textContent='设置已保存';};
    $('clear-cache').onclick=async()=>{try {await BacktestData.clearCache();dataset=null;$('dataset-label').textContent='回测缓存已清除';} catch(e){error(e.message);}};
    $('import').onclick=()=>$('import-file').click();
    $('import-file').onchange=async()=>{
        const file=$('import-file').files[0];if(!file) return;
        try {
            if(file.size>120*1024*1024) throw Error('数据文件超过120MB');
            const imported=JSON.parse(await file.text());
            if(imported.version!==1 || !Array.isArray(imported.assets) || !Array.isArray(imported.snapshots) || !imported.start || !imported.end) throw Error('回测数据格式不兼容，请导入本页面导出的数据');
            dataset={...imported,imported:true};$('start').value=dataset.start;$('end').value=dataset.end;$('market').value=dataset.market || 'ALL';
            $('dataset-label').textContent=`已导入 ${dataset.assets.length} 只股票数据`;error('');
        }catch(e){error(e.message);}finally{$('import-file').value='';}
    };
    function render() {
        $('results').hidden=false;
        const o=result.options, m=result.metrics;
        $('result-caption').textContent=`${o.start} → ${o.end} · 目标${o.topN}只 · 条件退出、等权调仓 · ${({daily:'每日',weekly:'每周',monthly:'每月'})[o.frequency]}调仓 · 单边${o.costBps}基点`;
        const metrics=[['期末资产',money(m.final)],['累计收益',pct(m.totalReturn)],['年化收益',pct(m.cagr)],['最大回撤',pct(m.maxDrawdown)],['年化波动',pct(m.volatility)],['夏普（无风险利率0）',m.sharpe===null?'—':m.sharpe.toFixed(2)],['综合成本',money(m.fees)],['调仓 / 成交',`${m.rebalanceCount} / ${m.tradeCount}`]];
        $('metrics').replaceChildren(...metrics.map(([label,value])=>{const el=document.createElement('div');el.className='metric';const title=document.createElement('span'),number=document.createElement('strong');title.textContent=label;number.textContent=value;el.append(title,number);return el;}));
        renderCharts();
        $('stress-legend').hidden=!stressed;
        $('stress-result').textContent=stressed ? `成本翻倍：累计收益 ${pct(stressed.metrics.totalReturn)}，最大回撤 ${pct(stressed.metrics.maxDrawdown)}。` : '';
        $('warnings').replaceChildren(...result.warnings.map(w=>{const p=document.createElement('p');p.textContent=w;return p;}));
        $('warnings').hidden=!result.warnings.length;
        $('rebalance-date').replaceChildren(...result.rebalances.map((r,i)=>new Option(r.date,String(i))));renderRebalance();renderClosed();showRecordPage();
        const failures=dataset.failures || [];
        $('coverage-title').textContent=`数据覆盖 · ${dataset.assets.length}/${dataset.universeCount || dataset.assets.length}只`;
        $('coverage-summary').textContent=`${dataset.snapshots.length} 份历史股票池记录；${failures.length} 只数据缺失；${result.diagnostics.staleHeldDays} 次持仓估值使用超过10天未更新的价格。`;
        $('failures').replaceChildren(...failures.map(f=>{const li=document.createElement('li');li.textContent=`${f.code} ${f.name || ''}：${f.reason}`;return li;}));
        $('sources').textContent=Object.entries(dataset.source || {}).map(([k,v])=>`${({forecasts:'预测',prices:'价格',marketCap:'市值',fx:'汇率',repository:'仓库',branch:'分支'})[k] || k}：${v}`).join('；');
        $('dataset-label').textContent=`已加载 ${dataset.assets.length} 只股票`;
    }
    function renderRebalance() {
        if(!result) return;
        const row=result.rebalances[Number($('rebalance-date').value) || 0];
        $('rebalance-summary').textContent=`可评分 ${row.eligible} 只 · 续持 ${row.retainedCount} 只 · 新增 ${row.addedCount} 只 · 清仓 ${row.exits.length} 只 · 调仓前资产 ${money(row.equity)} · 预测保存于 ${row.snapshotAt}。排除：`+Object.entries(row.exclusions).map(([k,v])=>`${k}${v}`).join('，');
        $('ranked').replaceChildren(...[...row.selected,...row.exits].map((s,i)=>{const tr=document.createElement('tr');tr.title=s.reason;[i<row.selected.length?i+1:'—',s.name,s.code,s.decision,({up:'上涨',sideways:'震荡',down:'下跌'})[s.trend] || '—',Number.isFinite(s.score)?s.score.toFixed(1):'—',pct(s.performance?.returnRate),s.confidence ?? '—',s.signalDate].forEach(v=>{const td=document.createElement('td');td.textContent=String(v);if(tr.children.length===6 && s.performance) {td.className=s.performance.pnl>0?'positive':s.performance.pnl<0?'negative':'';td.title=`本轮始于 ${s.performance.openedAt}；净盈亏 ${money(s.performance.pnl)}；累计投入 ${money(s.performance.invested)}；估值行情日 ${s.performance.priceDate}`;}tr.append(td);});return tr;}));
    }
    function showRecordPage() {
        const closed=location.hash==='#closed';
        $('rebalance-page').hidden=closed;$('closed-page').hidden=!closed;
        $('show-rebalances').setAttribute('aria-pressed',String(!closed));$('show-closed').setAttribute('aria-pressed',String(closed));
    }
    $('show-rebalances').onclick=()=>{location.hash='rebalances';};
    $('show-closed').onclick=()=>{location.hash='closed';};
    window.addEventListener('hashchange',showRecordPage);
    function closedRows() {return [...result.closedPositions].sort((a,b)=>b.closedAt.localeCompare(a.closedAt)||b.id-a.id);}
    function renderClosed() {
        const rows=closedRows(), pnl=rows.reduce((s,r)=>s+r.pnl,0);
        $('show-closed').textContent=`已清仓（${rows.length}）`;
        $('closed-summary').textContent=`${rows.length} 段已结束持仓 · 净盈亏 ${money(pnl)}`;
        $('closed-empty').hidden=rows.length>0;$('export-closed').disabled=!rows.length;
        $('closed-rows').replaceChildren(...rows.map(r=>{const tr=document.createElement('tr');[r.name,r.code,r.openedAt,r.closedAt,r.holdingDays,money(r.invested),money(r.pnl),pct(r.returnRate),r.EntryScore ?? '—',r.EntryRank ?? '—',r.ExitScore ?? '—',r.ExitRank ?? '—',r.ExitReason || '—',pct(r.MAE),pct(r.MFE)].forEach((v,i)=>{const td=document.createElement('td');td.textContent=String(v);if(i===6 || i===7)td.className=r.pnl>0?'positive':r.pnl<0?'negative':'';tr.append(td);});return tr;}));
    }
    $('rebalance-date').onchange=renderRebalance;
    const ns='http://www.w3.org/2000/svg';
    function svgNode(tag,attrs,text) {const node=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs)) node.setAttribute(k,String(v));if(text!==undefined) node.textContent=text;return node;}
    function plot(id,series,dates,format,height) {
        const svg=$(id), width=Math.max(320,svg.clientWidth || 1000), left=58,right=20,top=18,bottom=30;
        svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.replaceChildren();
        let low=Math.min(...series.flatMap(s=>s.values)), high=Math.max(...series.flatMap(s=>s.values));
        if(high-low<1e-8) {low-=.01;high+=.01;}
        const padding=(high-low)*.08;low-=padding;high+=padding;
        const x=i=>left+i*(width-left-right)/Math.max(1,dates.length-1), y=v=>top+(high-v)*(height-top-bottom)/(high-low);
        for(let i=0;i<=4;i++) {const v=low+(high-low)*i/4,yy=y(v);svg.append(svgNode('line',{x1:left,y1:yy,x2:width-right,y2:yy,class:'chart-grid'}),svgNode('text',{x:left-8,y:yy+4,'text-anchor':'end',class:'chart-axis'},format(v)));}
        series.forEach(s=>svg.append(svgNode('path',{d:s.values.map((v,i)=>`${i?'L':'M'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' '),fill:'none',stroke:s.color,'stroke-width':2,'stroke-linejoin':'round'})));
        svg.append(svgNode('text',{x:left,y:height-5,class:'chart-axis'},dates[0]),svgNode('text',{x:width-right,y:height-5,'text-anchor':'end',class:'chart-axis'},dates.at(-1)));
        const hit=svgNode('rect',{x:left,y:top,width:width-left-right,height:height-top-bottom,class:'chart-hit'});
        const vertical=svgNode('line',{class:'chart-crosshair'}), horizontal=svgNode('line',{class:'chart-crosshair'});
        const tooltip=svgNode('g',{class:'chart-tooltip'}), hover=svgNode('g',{class:'chart-hover',visibility:'hidden'});
        hover.append(vertical,horizontal,tooltip);svg.append(hit,hover);
        svg.onpointermove=event=>{
            const rect=svg.getBoundingClientRect();if(!rect.width || !rect.height) return;
            const px=(event.clientX-rect.left)*width/rect.width, py=(event.clientY-rect.top)*height/rect.height;
            if(px<left || px>width-right || py<top || py>height-bottom) {hover.setAttribute('visibility','hidden');return;}
            const index=Math.max(0,Math.min(dates.length-1,Math.round((px-left)/(width-left-right)*Math.max(1,dates.length-1))));
            const xx=x(index), value=series[0].values[index], yy=y(value);
            vertical.setAttribute('x1',xx);vertical.setAttribute('x2',xx);vertical.setAttribute('y1',top);vertical.setAttribute('y2',height-bottom);
            horizontal.setAttribute('x1',left);horizontal.setAttribute('x2',width-right);horizontal.setAttribute('y1',yy);horizontal.setAttribute('y2',yy);
            const lines=[dates[index],...series.map(s=>`${s.label}：${format(s.values[index])}`)], boxWidth=176, boxHeight=12+lines.length*18;
            const tx=xx+12+boxWidth>width-right ? xx-boxWidth-12 : xx+12, ty=Math.max(top,Math.min(yy+12,height-bottom-boxHeight));
            tooltip.replaceChildren(svgNode('rect',{x:tx,y:ty,width:boxWidth,height:boxHeight,rx:6,class:'chart-tooltip-bg'}),...lines.map((line,i)=>svgNode('text',{x:tx+10,y:ty+18+i*18,class:i?'chart-tooltip-value':'chart-tooltip-date'},line)));
            hover.setAttribute('visibility','visible');
        };
        svg.onpointerleave=()=>hover.setAttribute('visibility','hidden');
    }
    function renderCharts() {
        if(!result) return;
        const dates=[result.options.start,...result.curve.map(p=>p.date)];
        const series=[{label:'基准成本',values:[1,...result.curve.map(p=>p.equity/result.options.capital)],color:'#2563b0'}];
        if(stressed) series.push({label:'成本翻倍',values:[1,...stressed.curve.map(p=>p.equity/result.options.capital)],color:'#ba8b36'});
        const values=series.flatMap(s=>s.values), digits=Math.max(...values)-Math.min(...values)<.02?4:2;
        plot('chart',series,dates,v=>v.toFixed(digits),280);
        plot('drawdown',[{label:'回撤',values:[0,...result.curve.map(p=>p.drawdown)],color:'#b85955'}],dates,pct,185);
    }
    let resizeFrame;window.addEventListener('resize',()=>{cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(renderCharts);});
    function download(name,content,type) {const url=URL.createObjectURL(new Blob([content],{type})),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
    const csv=rows=>'\uFEFF'+rows.map(row=>row.map(value=>{let s=value==null?'':String(value);if(typeof value==='string' && /^[=+\-@\t\r]/.test(s)) s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}).join(',')).join('\r\n');
    $('export-nav').onclick=()=>{if(result) download('Score净值.csv',csv([['日期','资产人民币','现金人民币','回撤','持仓数'],...result.curve.map(p=>[p.date,p.equity,p.cash,p.drawdown,p.holdings])]),'text/csv;charset=utf-8');};
    const tradeFields=['EntryScore','EntryRank','ExitScore','ExitRank','ExitReason','MAE','MFE','DrawdownFromPeak'];
    $('export-result').onclick=()=>{if(result) download('Score回测结果.json',JSON.stringify(result),'application/json');};
    $('export-trades').onclick=()=>{if(result) download('Score成交.csv',csv([['日期','代码','名称','方向','模拟份额','复权成交价','折人民币汇率','成交额人民币','成本人民币','Score','SignalRank','CycleID','DecisionDate','EntrySignalDate',...tradeFields],...result.trades.map(t=>[t.date,t.code,t.name,t.side==='buy'?'买入':'卖出',t.quantity,t.price,t.fx,t.notional,t.fee,t.score,t.rank,t.cycleId,t.decisionDate,t.EntrySignalDate,...tradeFields.map(k=>t[k])])]),'text/csv;charset=utf-8');};
    $('export-closed').onclick=()=>{if(result) download('Score已清仓.csv',csv([['股票','代码','首次买入','实际清仓','持有天数','累计投入人民币含费用','累计卖出人民币扣费用','净盈亏人民币','收益率','CycleID',...tradeFields],...closedRows().map(r=>[r.name,r.code,r.openedAt,r.closedAt,r.holdingDays,r.invested,r.sellAmount-r.sellFees,r.pnl,r.returnRate,r.id,...tradeFields.map(k=>r[k])])]),'text/csv;charset=utf-8');};
    $('export-data').onclick=()=>{if(dataset) {const {imported,...data}=dataset;download('Score回测数据.json',JSON.stringify(data),'application/json');}};
})();
