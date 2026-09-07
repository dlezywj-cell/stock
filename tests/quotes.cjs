// PLAYWRIGHT_MODULE=/path/to/playwright node tests/quotes.cjs [--live]
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const live = process.argv.includes('--live');
const appUrl = process.env.STOCK_TEST_URL || 'http://quotes.test/';
const stocks = ['1.600519','116.00700','105.AAPL'].map(code => ({code,name:code,profit:10,lowPE:10,highPE:20}));
const quote = (price, total, float = 12) => {
  const f = Array(80).fill('');
  f[3] = price; f[32] = '-1.5'; f[44] = float; f[45] = total; f[30] = '20260907160000';
  return f.join('~');
};
(async () => {
 const browser = await chromium.launch({headless:true,channel:'chrome'});
 try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let mode = 'ok', requests = 0, release;
  await page.route('**/*', async route => {
   const url = route.request().url();
   if (process.env.STOCK_TEST_URL && (url === appUrl || new URL(url).pathname.endsWith('/score.js'))) return route.continue();
   if (url === appUrl) return route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(__dirname,'../index.html'),'utf8')});
   if (new URL(url).pathname === '/score.js') return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(path.join(__dirname,'../score.js'),'utf8')});
   if (url.includes('qt.gtimg.cn')) {
    requests++;
    if (live) return route.continue();
    if (mode === 'held') await new Promise(r => { release = r; });
    if (mode === 'fail') return route.abort();
    const body = `v_sh600519=${JSON.stringify(quote(requests===1?100:110,200))};v_hk00700=${JSON.stringify(quote(400,300))};` + (mode === 'partial' ? '' : `v_usAAPL=${JSON.stringify(quote(300,400))};`);
    return route.fulfill({contentType:'application/javascript',body});
   }
   if (url.includes('ulist.np') && mode === 'partial') {
    const data = {data:{diff:[{f12:'AAPL',f13:105,f2:310,f3:1,f20:500e8}]}};
    const cb = new URL(url).searchParams.get('cb');
    return route.fulfill({contentType:cb?'application/javascript':'application/json',body:cb?`${cb}(${JSON.stringify(data)})`:JSON.stringify(data)});
   }
   return route.abort();
  });
  await page.addInitScript(stocks => {localStorage.setItem('stock_sys_data',JSON.stringify(stocks));localStorage.setItem('stock_sys_view',JSON.stringify({showCap:true}));},stocks);
  await page.goto(appUrl);
  await page.waitForFunction(() => !document.querySelector('#btn-refresh-quotes').disabled && document.querySelector('#quote-status').textContent === '',null,{timeout:30000});
  const get = () => page.evaluate(() => stocks.map(s => cachedMarketData[getSecid(s.code)]));
  let result = await get();
  assert.ok(result.every(q => q.f2>0 && q.f20>0));
  if (live) {
   console.log('LIVE A/HK/US:',JSON.stringify(result));
   await page.locator('#btn-refresh-quotes').click();
   await page.waitForFunction(() => !document.querySelector('#btn-refresh-quotes').disabled);
   assert.ok((await get()).every((q,i) => q.fetchedAt>result[i].fetchedAt));
   await page.screenshot({path:'/tmp/stock-quotes-live.png',fullPage:true});
  } else {
   assert.equal(result[0].f20,200e8); // total, never float cap
   await page.locator('#btn-refresh-quotes').click();
   await page.waitForFunction(() => !document.querySelector('#btn-refresh-quotes').disabled);
   assert.equal((await get())[0].f2,110); // cached price must not skip refresh
   mode = 'partial';
   await page.evaluate(() => updateTable());
   assert.equal((await get())[2].f2,310); // missing symbol must not reuse Tencent global
   assert.equal((await get())[2].f20,500e8);
   mode = 'fail'; result = await get();
   await page.evaluate(() => updateTable());
   assert.deepEqual(await get(),result);
   assert.match(await page.locator('#quote-status').textContent(),/3 只失败/);
   mode = 'held'; const before = requests;
   await page.evaluate(() => { updateTable(); updateTable(); updateTable(); });
   await page.waitForTimeout(100);
   assert.equal(requests,before+1); release();
   await page.waitForFunction(() => !document.querySelector('#btn-refresh-quotes').disabled);
   await page.evaluate(() => startRealtime());
   await page.waitForTimeout(100); release();
   await page.waitForFunction(() => !document.querySelector('#btn-refresh-quotes').disabled);
   await page.evaluate(() => stopRealtime());
   assert.equal(await page.evaluate(() => intervalId),null);
   const parsed = await page.evaluate(() => [getTencentSymbol({code:'106.BRK.B'}),parseTencentQuote('',{code:'105.AAPL'}),parseTencentQuote('~'.repeat(60),{code:'105.AAPL'})]);
   assert.deepEqual(parsed,['usBRK.B',null,null]);
  }
  assert.deepEqual(errors,[]);
  console.log(live?'Live quote refresh passed':'Quote regression tests passed');
 } finally { await browser.close(); }
})().catch(e => {console.error(e);process.exitCode=1;});
