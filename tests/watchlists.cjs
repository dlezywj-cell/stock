// Run: npm install --no-save playwright && node tests/watchlists.cjs
// Uses an installed Chrome, mock stocks and mock APIs; never touches real GitHub data.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const fixture = ['0.000001', '116.00700', '105.TEST'].map((code, i) => ({code, name:['示例A','示例港股','示例美股'][i], tags:'科技', profit:10, lowPE:10, highPE:20, revenue:20, lowPS:2, highPS:3, logs:[]}));
const encode = data => Buffer.from(JSON.stringify(data)).toString('base64');

(async () => {
    const browser = await chromium.launch({headless:true, channel:'chrome'});
    try {
        let cloud = structuredClone(fixture), uploadCount = 0, githubReads = 0, beforeRead = null, beforeUploadResponse = null;
        const context = await browser.newContext({viewport:{width:1440,height:900}});
        const errors = [];
        const page = await context.newPage();
        page.on('pageerror', e => errors.push(e.message));
        page.on('dialog', dialog => dialog.accept());
        await context.route('**/*', async route => {
            if (route.request().url() === 'http://watchlists.test/') return route.fulfill({contentType:'text/html',body:html});
            if (new URL(route.request().url()).pathname === '/score.js') return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(path.join(__dirname,'../score.js'),'utf8')});
            if (route.request().url().includes('api.github.com')) {
                if (route.request().method() === 'PUT') {
                    const body = route.request().postDataJSON();
                    cloud = JSON.parse(Buffer.from(body.content, 'base64').toString());
                    uploadCount++;
                    if (beforeUploadResponse) { const hook = beforeUploadResponse; beforeUploadResponse = null; await hook(); }
                    return route.fulfill({json:{}});
                }
                githubReads++;
                if (beforeRead) { const hook = beforeRead; beforeRead = null; await hook(); }
                return route.fulfill({json:{sha:'mock-sha',content:encode(cloud)}});
            }
            return route.fulfill({json:{}});
        });
        await context.addInitScript(data => {
            if (!localStorage.getItem('test_initialized')) {
                localStorage.setItem('stock_sys_data', JSON.stringify(data));
                localStorage.setItem('test_initialized', 'true');
            }
        }, fixture);
        const state = () => page.evaluate(() => ({stocks, activeWatchlist, visible:currentVisibleStocks.map(s=>s.code), dirty:localStorage.getItem('stock_sys_unsaved')}));
        const create = async name => {
            await page.locator('#btn-save-watchlist').click();
            await page.locator('#watchlist-name').fill(name);
            await page.getByRole('button', {name:'保存组合',exact:true}).click();
        };
        await page.goto('http://watchlists.test/');
        await page.waitForSelector('.row-checkbox');
        assert.equal(await page.locator('#btn-save-watchlist').isDisabled(), true);
        // Select through the real row controls, including two markets.
        await page.locator('.row-checkbox').nth(0).click();
        await page.locator('.row-checkbox').nth(1).click();
        await create('自选股1');
        assert.equal((await state()).visible.length, 2);
        assert.deepEqual((await state()).stocks.map(s=>s.tags), fixture.map(s=>s.tags));
        await create('长期关注');
        assert.deepEqual((await state()).stocks[0].watchlists, ['自选股1','长期关注']);
        // Duplicate and blank names must not create or overwrite a group.
        await create('自选股1');
        assert.equal(await page.locator('#watchlist-modal').isVisible(), true);
        await page.locator('#watchlist-name').fill('  ');
        await page.getByRole('button', {name:'保存组合',exact:true}).click();
        assert.equal(await page.locator('#watchlist-modal').isVisible(), true);
        await page.locator('#watchlist-modal [aria-label="关闭"]').click();
        // Refresh with a configured token must retain unuploaded local groups.
        await page.evaluate(() => localStorage.setItem('stock_sys_token','mock-token'));
        await page.reload();
        await page.waitForSelector('.row-checkbox');
        assert.equal(githubReads, 0);
        assert.equal((await state()).activeWatchlist, '长期关注');
        assert.equal((await state()).visible.length, 2);
        // Switching groups clears restrictive filters, without discarding checked additions.
        await page.locator('#watchlist-select').selectOption('');
        await page.locator('.row-checkbox').nth(2).click();
        await page.evaluate(() => { marketFilters = {A:false,HK:false,US:false}; document.getElementById('findInput').value = '不存在'; });
        await page.locator('#watchlist-select').selectOption('自选股1');
        assert.equal((await state()).visible.length, 2);
        await page.locator('#btn-manage-watchlist').click();
        await page.locator('#btn-watchlist-append').click();
        assert.equal((await state()).visible.length, 3);
        // Rename safely accepts punctuation/HTML as plain text.
        const specialName = '关注 "芯片" <b>组合</b>';
        await page.locator('#btn-manage-watchlist').click();
        await page.locator('#watchlist-name').fill(specialName);
        await page.getByRole('button',{name:'保存名称',exact:true}).click();
        assert.equal((await state()).activeWatchlist, specialName);
        assert.equal(await page.locator('#watchlist-select b').count(), 0);
        // Editing ordinary stock fields must preserve all group memberships.
        await page.evaluate(() => { editStock(stocks[0].code); document.getElementById('inProfit').value='12'; saveStock(); });
        assert.deepEqual((await state()).stocks[0].watchlists, [specialName,'长期关注']);
        // Removing a member leaves both the stock and other groups intact.
        await page.locator('#btn-manage-watchlist').click();
        await page.locator('#btn-watchlist-remove').click();
        assert.equal((await state()).visible.length, 2);
        assert.equal((await state()).stocks.length, 3);
        await page.locator('.btn-cloud-push').click();
        await page.waitForFunction(() => localStorage.getItem('stock_sys_unsaved') === 'false');
        assert.equal(uploadCount, 1);
        assert.deepEqual(cloud[0].watchlists, [specialName,'长期关注']);
        // Fresh device auto-sync restores the group; no conversion of legacy array data.
        await page.evaluate(() => { localStorage.removeItem('stock_sys_data'); localStorage.removeItem('stock_sys_active_watchlist'); });
        await page.reload();
        await page.waitForFunction(() => stocks.length === 3);
        await page.locator('#watchlist-select').selectOption(specialName);
        assert.equal((await state()).visible.length, 2);
        await page.screenshot({animations:'disabled',path:'/tmp/stock-watchlists-desktop.png'});
        await page.setViewportSize({width:390,height:844});
        await page.reload();
        await page.waitForFunction(() => stocks.length === 3);
        assert.equal(await page.locator('#top-area').isVisible(), false);
        await page.locator('#mobile-menu-btn').click();
        assert.equal(await page.locator('.cloud-tools .watchlist-bar').isVisible(), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({animations:'disabled',path:'/tmp/stock-watchlists-mobile.png'});
        // Removing every member deletes only the empty group.
        await page.evaluate(() => toggleSelectAll());
        await page.locator('#btn-manage-watchlist').click();
        await page.locator('#btn-watchlist-remove').click();
        assert.equal((await state()).activeWatchlist, '');
        assert.equal((await state()).stocks.length, 3);
        await page.locator('#watchlist-select').selectOption('长期关注');
        await page.locator('#btn-manage-watchlist').click();
        await page.getByRole('button',{name:'删除组合',exact:true}).click();
        assert.equal((await state()).stocks.length, 3);
        assert.equal(await page.locator('#watchlist-select option').count(), 1);
        // An initial auto-sync response must not overwrite a group created in flight.
        let releaseRead;
        const readGate = new Promise(resolve => { releaseRead = resolve; });
        beforeRead = () => readGate;
        await page.evaluate(() => setLocalChanges(false));
        await page.reload();
        await page.waitForSelector('.row-checkbox');
        await page.evaluate(() => toggleSelectAll());
        await page.locator('#mobile-menu-btn').click();
        await create('加载期间新建');
        releaseRead();
        await page.waitForFunction(() => document.getElementById('statusTxt').textContent === '本机修改待同步');
        assert.equal((await state()).activeWatchlist, '加载期间新建');
        // New edits during upload must stay dirty after that snapshot succeeds.
        beforeUploadResponse = () => page.evaluate(() => {
            stocks[0].watchlists.push('上传期间新增'); saveStorage(); setLocalChanges(true);
        });
        await page.evaluate(() => uploadToGithub());
        assert.equal((await state()).dirty, 'true');
        assert.equal(cloud[0].watchlists.includes('上传期间新增'), false);
        assert.equal((await state()).stocks[0].watchlists.includes('上传期间新增'), true);
        // Score integration: column position, sorting (unknowns last), details and forecast dates.
        await page.setViewportSize({width:1440,height:900});
        await page.evaluate(() => {
            document.getElementById('top-area').style.display = 'block';
            stocks = ['0.000001','116.00700','105.TEST'].map((code,i) => ({
                code, name:['示例A','示例港股','示例美股'][i], tags:'科技',
                profit:1,lowPE:80,highPE:160,revenue:1,lowPS:80,highPS:160,
                logs:[{date:i === 0 ? getNowStr() : '2000/01/01',content:'首次创建'}]
            }));
            stocks.forEach((s,i) => {
                cachedMarketData[s.code.split('.')[1]] = {f12:s.code.split('.')[1],f2:21,f20:1e10,f3:1};
                historyCache[s.code] = i === 2 ? null : Array.from({length:20},(_,j)=>j+1);
            });
            selectWatchlist(''); clearStockSelection();
        });
        const scores = () => page.evaluate(() => currentVisibleStocks.map(s=>s.score.total));
        assert.deepEqual(await scores(),[79.6,40,null]);
        const headings = await page.locator('#result thead tr').nth(1).locator('th').allTextContents();
        assert.equal(headings.findIndex(h=>h.startsWith('Score')),headings.findIndex(h=>h.startsWith('涨跌'))+1);
        await page.getByRole('columnheader',{name:/^Score/}).click();
        assert.deepEqual(await scores(),[79.6,40,null]);
        await page.getByRole('columnheader',{name:/^Score/}).click();
        assert.deepEqual(await scores(),[40,79.6,null]);
        await page.locator('.score-button').first().click();
        assert.match(await page.locator('#score-details').textContent(),/置信系数 0×60%/);
        await page.getByRole('button',{name:'关闭评分明细'}).click();
        const oldest = () => page.evaluate(() => stocks[1].forecastUpdatedAt);
        await page.evaluate(() => { editStock(stocks[1].code); document.getElementById('inNote').value='普通备注'; saveStock(); });
        assert.equal(await oldest(),'2000/01/01');
        await page.evaluate(() => { editStock(stocks[1].code); document.getElementById('inHighPE').value='170'; saveStock(); });
        assert.equal(await oldest(),'2000/01/01');
        await page.evaluate(() => { editStock(stocks[1].code); document.getElementById('inConfirmForecast').checked=true; saveStock(); });
        assert.notEqual(await oldest(),'2000/01/01');
        assert.equal(await page.locator('#inConfirmForecast').isChecked(),false);
        await page.evaluate(() => { editStock(stocks[0].code); document.getElementById('inProfit').value='2'; saveStock(); });
        assert.equal(await page.evaluate(() => Boolean(stocks[0].forecastUpdatedAt)),true);
        await page.evaluate(() => { document.getElementById('input-container').style.display='none'; setSort('score'); });
        await page.screenshot({animations:'disabled',path:'/tmp/stock-score-desktop.png'});
        await page.setViewportSize({width:390,height:844});
        await page.evaluate(() => toggleMobileMenu(false));
        await page.locator('.score-button').first().click();
        assert.equal(await page.locator('#score-modal').isVisible(),true);
        await page.screenshot({animations:'disabled',path:'/tmp/stock-score-mobile.png'});
        assert.deepEqual(errors, []);
        console.log('PASS: create, overlapping groups, invalid names, reload protection, filter reset, append, rename, stock edits, removal, mocked GitHub round trip, mobile layout, empty-group cleanup, deletion, sync/upload race protection.');
    } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
