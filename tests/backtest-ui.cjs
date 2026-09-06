const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture}=require('./backtest.cjs');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 try {
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
  let gitReads=0,proxyReads=0,quoteAttempts=0,denyGithub=false;
  const d=fixture();
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.hostname==='backtest.test'){
    const file=path.join(__dirname,'..',url.pathname==='/'?'backtest.html':url.pathname);
    if(fs.existsSync(file))return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
   }
   if(url.hostname==='api.github.com'){
    gitReads++;assert.equal(route.request().method(),'GET');
    assert.equal(route.request().headers().authorization,'Bearer test-local-token');
    if(denyGithub)return route.fulfill({status:401,json:{message:'Bad credentials'}});
    if(url.pathname.includes('/commits'))return route.fulfill({json:url.searchParams.has('since')?[]:[{sha:'baseline',commit:{committer:{date:d.snapshots[0].at}}}]});
    return route.fulfill({json:{content:Buffer.from(JSON.stringify(d.snapshots[0].stocks)).toString('base64')}});
   }
   if(url.hostname==='stock-proxy.dlezywj.workers.dev'){
    proxyReads++;assert.ok(!route.request().headers().authorization);
    const target=decodeURIComponent(url.search.slice(1));
    if(target.includes('ulist.np')){
     quoteAttempts++;if(target.includes('://push2.eastmoney.com/'))return route.fulfill({status:502,json:{}});
     return route.fulfill({json:{data:{diff:d.assets.map(a=>({f12:a.code.split('.')[1],f13:Number(a.code.split('.')[0]),f20:a.anchorCap,f2:a.anchorClose}))}}});
    }
    const bars=d.assets[0].bars;
    return route.fulfill({json:{chart:{result:[{meta:{currency:'CNY',exchangeTimezoneName:'Asia/Shanghai'},timestamp:bars.map(b=>Date.parse(b.date+'T07:00:00Z')/1000),indicators:{quote:[{open:bars.map(b=>b.open),close:bars.map(b=>b.rawClose),volume:bars.map(b=>b.volume)}],adjclose:[{adjclose:bars.map(b=>b.close)}]}}]}}});
   }
   return route.abort();
  });
  await context.addInitScript(()=>localStorage.setItem('stock_sys_token','test-local-token'));
  await page.goto('http://backtest.test/');
  assert.equal(await page.locator('#capital').inputValue(),'1000');assert.equal(await page.locator('#top-n').inputValue(),'20');
  await page.locator('#start').fill('2026-01-22');await page.locator('#end').fill('2026-02-18');
  await page.locator('#run').click();await page.waitForFunction(()=>document.querySelector('#status').textContent==='回测完成');
  assert.ok(gitReads>=3);assert.ok(proxyReads>=4);assert.equal(quoteAttempts,4);
  assert.equal(await page.locator('#metrics .metric').count(),8);assert.equal(await page.locator('#chart path').count(),3);assert.equal(await page.locator('#ranked tr').count(),1);assert.equal(await page.locator('#comparison-rows tr').count(),7);assert.equal(await page.locator('#exposure-rows tr').count(),28);assert.equal(await page.locator('#threshold-rows tr').count(),5);assert.equal(await page.locator('#scarcity-rows tr').count(),9);
  for(const [selector,label] of [['#chart','机会仓位'],['#drawdown','回撤']]) {await page.locator(selector).scrollIntoViewIfNeeded();const box=await page.locator(selector).boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);assert.equal(await page.locator(selector+' .chart-hover').getAttribute('visibility'),'visible');const tip=await page.locator(selector+' .chart-tooltip').textContent();assert.match(tip,/2026-/);assert.ok(tip.includes(label));assert.equal(await page.locator(selector+' .chart-crosshair').count(),2);await page.mouse.move(1,1);assert.equal(await page.locator(selector+' .chart-hover').getAttribute('visibility'),'hidden');}
  assert.equal(await page.locator('#rebalance-date option').count(),5);
  assert.equal(await page.locator('#error').isVisible(),false);
  const exported=page.waitForEvent('download');await page.locator('#export-data').click();const download=await exported;
  const saved=JSON.parse(fs.readFileSync(await download.path(),'utf8'));assert.equal(saved.version,1);assert.ok(!JSON.stringify(saved).includes('test-local-token'));assert.equal(saved.assets.length,2);
  const savedResultEvent=page.waitForEvent('download');await page.locator('#export-result').click();const savedResultFile=await savedResultEvent;const savedResult=JSON.parse(fs.readFileSync(await savedResultFile.path(),'utf8'));
  const fields=['EntryScore','EntryRank','ExitScore','ExitRank','ExitReason','MAE','MFE','DrawdownFromPeak'];assert.ok(savedResult.trades.length>0);assert.ok(savedResult.baseline.metrics);assert.equal(savedResult.exposure.length,28);assert.equal(savedResult.eligibleThresholdStats.length,5);assert.equal(savedResult.baseline.scarcityForwardStats.length,9);for(const t of savedResult.trades)for(const key of fields)assert.ok(Object.hasOwn(t,key));assert.ok(!JSON.stringify(savedResult).includes('test-local-token'));
  const exposureEvent=page.waitForEvent('download');await page.locator('#export-exposure').click();const exposureDownload=await exposureEvent;const exposureCSV=fs.readFileSync(await exposureDownload.path(),'utf8');assert.match(exposureCSV.split('\r\n')[0],/"EligibleCount"/);assert.match(exposureCSV.split('\r\n')[0],/"CashRatio"/);assert.equal(exposureCSV.split('\r\n').length,29);
  const tradeExportEvent=page.waitForEvent('download');await page.locator('#export-trades').click();const tradeExport=await tradeExportEvent;const tradeCSV=fs.readFileSync(await tradeExport.path(),'utf8');for(const field of fields)assert.ok(tradeCSV.split('\r\n')[0].includes('"'+field+'"'));
  const reads=gitReads;await page.locator('#frequency').selectOption('monthly');await page.locator('#run').click();await page.waitForFunction(()=>document.querySelector('#status').textContent==='回测完成');assert.equal(gitReads,reads);assert.equal(await page.locator('#rebalance-date option').count(),2);
  await page.locator('#import-file').setInputFiles({name:'sample.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({...d,snapshots:[...d.snapshots,{at:'2026-01-31T12:00:00Z',sha:'missing',stocks:[]}]}))});
  await page.locator('#run').click();await page.waitForFunction(()=>document.querySelector('#status').textContent==='回测完成');assert.equal(gitReads,reads);
  await page.locator('#rebalance-date').selectOption({index:1});assert.match(await page.locator('#rebalance-summary').textContent(),/续持 1 只/);assert.match(await page.locator('#ranked').textContent(),/续持/);assert.ok((await page.locator('#ranked').textContent()).includes('—'));
  assert.equal(await page.locator('#ranked tr').first().locator('td').count(),9);await page.locator('#show-closed').click();await page.waitForFunction(()=>!document.querySelector('#closed-page').hidden);assert.equal(await page.locator('#closed-empty').isVisible(),true);assert.equal(await page.locator('#export-closed').isDisabled(),true);await page.locator('#show-rebalances').click();await page.waitForFunction(()=>!document.querySelector('#rebalance-page').hidden);
  await page.screenshot({path:'/tmp/stock-backtest-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/stock-backtest-mobile.png',fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('#start').fill('2026-02-18');await page.locator('#run').click();assert.match(await page.locator('#error').textContent(),/开始日期须早于/);
  await page.setViewportSize({width:1440,height:1000});await page.locator('.advanced summary').click();await page.locator('#clear-cache').click();
  denyGithub=true;await page.locator('#start').fill('2026-01-22');await page.locator('#run').click();await page.waitForFunction(()=>document.querySelector('#error').textContent.includes('401'));assert.equal(await page.locator('#run').isDisabled(),false);
  denyGithub=false;await page.evaluate(()=>{document.querySelector('#run').click();document.querySelector('#cancel').click();});await page.waitForFunction(()=>document.querySelector('#status').textContent==='已取消');assert.equal(await page.locator('#run').isDisabled(),false);
  assert.deepEqual(errors,[]);console.log('Backtest browser checks passed: live loader mocks/retry, worker, charts, schedules, imports/exports, private-token isolation, cancellation, errors and mobile layout.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
