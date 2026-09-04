const { test } = require('node:test');
const assert = require('node:assert/strict');
const score = require('../score.js');
const near = (a,b) => assert.ok(Math.abs(a-b) < 1e-9, `${a} != ${b}`);
const day = s => new Date(s + 'T12:00:00');
const stock = {profit:1, lowPE:80, highPE:160, revenue:1, lowPS:80, highPS:160, forecastUpdatedAt:'2026/09/04'};

test('4x odds, 100% upside, 60/40 weighting and capping', () => {
    const s = score.method(1, 80, 180, 100);
    near(s.ratio,4); near(s.odds,100); near(s.upside,80); near(s.total,88);
    near(score.method(1,80,160,100).total,66);
    near(score.method(1,80,200,100).total,100);
    near(score.method(1,80,300,100).total,100);
    near(score.method(1,98,110,100).total,46);
});

test('no upside, zero/positive lower space and invalid fundamentals', () => {
    near(score.method(1,80,100,100).total,0);
    near(score.method(1,70,90,100).total,0);
    near(score.method(1,100,160,100).total,76);
    near(score.method(1,120,160,100).total,76);
    for (const bad of [0,-1,'',null,undefined,NaN,Infinity,'missing']) assert.equal(score.method(bad,80,160,100),null);
    assert.equal(score.method(1,160,80,100),null);
    assert.equal(score.method(1,80,160,0),null);
});

test('total weighting, one-method penalty, no-method and no-trend gaps', () => {
    const options = {cap:100, trend:'up', now:day('2026-09-04')};
    near(score.calculate(stock, options).total,79.6);
    near(score.calculate({...stock,revenue:0},options).total,71.7);
    near(score.calculate({...stock,forecastUpdatedAt:'2026/01/01'},options).total,40);
    near(score.calculate({...stock,highPE:200,highPS:200},options).total,100);
    assert.equal(score.calculate({...stock,revenue:0,profit:-1},options).total,null);
    assert.equal(score.calculate(stock,{...options,trend:null}).total,null);
    near(score.calculate(stock,{...options,trend:'sideways'}).total,59.6);
    near(score.calculate(stock,{...options,trend:'down'}).total,39.6);
});

test('confidence uses inclusive natural-month boundaries and zero for unknown/future dates', () => {
    const date = '2026/05/04 15:32:00';
    assert.equal(score.confidence(date,day('2026-07-04')),1);
    assert.equal(score.confidence(date,day('2026-07-05')),.7);
    assert.equal(score.confidence(date,day('2026-09-04')),.7);
    assert.equal(score.confidence(date,day('2026-09-05')),.5);
    assert.equal(score.confidence(date,day('2026-11-04')),.5);
    assert.equal(score.confidence(date,day('2026-11-05')),0);
    assert.equal(score.confidence('2025/12/31',day('2026-02-28')),1);
    assert.equal(score.confidence('2025/12/31',day('2026-03-01')),.7);
    assert.equal(score.confidence('2023/12/31',day('2024-02-29')),1);
    assert.equal(score.confidence('2026/02/30',day('2026-03-01')),0);
    assert.equal(score.confidence('2026/09/05',day('2026-09-04')),0);
    assert.equal(score.confidence(null),0);
});

test('confidence scales only valuation and never adds an independent freshness bonus', () => {
    const options = {cap:100, trend:'up', now:day('2026-09-04')};
    near(score.calculate({...stock,forecastUpdatedAt:'2026/06/04'},options).total,67.7);
    near(score.calculate({...stock,forecastUpdatedAt:'2026/04/04'},options).total,59.8);
    near(score.calculate({...stock,forecastUpdatedAt:'2026/03/03'},options).total,40);
    near(score.calculate({...stock,forecastUpdatedAt:null},options).total,40);
    near(score.calculate({...stock,highPE:100,highPS:100},options).total,40);
    near(score.calculate({...stock,forecastUpdatedAt:'2026/01/01'}, {...options,trend:'down'}).total,0);
});

test('legacy date ignores tags, notes and multiple-only edits; explicit date remains authoritative', () => {
    const legacy = {logs:[
        {date:'2026/09/04',content:'属性:科技→消费'},
        {date:'2026/08/01',content:'PE上:10→20'},
        {date:'2026/07/01',content:'净利:10→20'},
        {date:'2026/01/01',content:'首次创建; 名称:示例'}
    ]};
    assert.equal(score.forecastDate(legacy),'2026/07/01');
    assert.equal(score.forecastDate({...legacy,forecastUpdatedAt:'2026/08/30'}),'2026/08/30');
    assert.equal(score.forecastDate({...legacy,forecastUpdatedAt:null}),null);
    assert.equal(score.forecastDate({logs:[{date:'2026/09/04',content:'无参数变更'}]}),null);
});

test('trend distinguishes missing data from sideways and supports snapshot closes', () => {
    const rising = Array.from({length:20},(_,i)=>i+1);
    assert.equal(score.trend(rising),'up');
    assert.equal(score.trend([...rising].reverse()),'down');
    assert.equal(score.trend(Array(20).fill(10)),'sideways');
    assert.equal(score.trend(rising.slice(0,19),20),'up');
    assert.equal(score.trend(rising.slice(0,18),20),null);
    assert.equal(score.trend(rising,0),null);
    assert.equal(score.trend([...rising.slice(0,19),NaN]),null);
});
