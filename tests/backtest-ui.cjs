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
  assert.equal(await page.locator('#metrics .metric').count(),8);assert.equal(await page.locator('#chart path').count(),2);assert.equal(await page.locator('#ranked tr').count(),2);
  assert.equal(await page.locator('#rebalance-date option').count(),5);
  assert.equal(await page.locator('#error').isVisible(),false);
  const exported=page.waitForEvent('download');await page.locator('#export-data').click();const download=await exported;
  const saved=JSON.parse(fs.readFileSync(await download.path(),'utf8'));assert.equal(saved.version,1);assert.ok(!JSON.stringify(saved).includes('test-local-token'));assert.equal(saved.assets.length,2);
  const reads=gitReads;await page.locator('#frequency').selectOption('monthly');await page.locator('#run').click();await page.waitForFunction(()=>document.querySelector('#status').textContent==='回测完成');assert.equal(gitReads,reads);assert.equal(await page.locator('#rebalance-date option').count(),2);
  await page.locator('#import-file').setInputFiles({name:'sample.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(d))});
  await page.locator('#run').click();await page.waitForFunction(()=>document.querySelector('#status').textContent==='回测完成');assert.equal(gitReads,reads);
  await page.screenshot({path:'/tmp/stock-backtest-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/stock-backtest-mobile.png',fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('#start').fill('2026-02-18');await page.locator('#run').click();assert.match(await page.locator('#error').textContent(),/开始日期须早于/);
  await page.setViewportSize({width:1440,height:1000});await page.locator('.advanced summary').click();await page.locator('#clear-cache').click();
  denyGithub=true;await page.locator('#start').fill('2026-01-22');await page.locator('#run').click();await page.waitForFunction(()=>document.querySelector('#error').textContent.includes('401'));assert.equal(await page.locator('#run').isDisabled(),false);
  denyGithub=false;await page.evaluate(()=>{document.querySelector('#run').click();document.querySelector('#cancel').click();});await page.waitForFunction(()=>document.querySelector('#status').textContent==='已取消');assert.equal(await page.locator('#run').isDisabled(),false);
  assert.deepEqual(errors,[]);console.log('Backtest browser checks passed: live loader mocks/retry, worker, charts, schedules, imports/exports, private-token isolation, cancellation, errors and mobile layout.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
