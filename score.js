// Shared by the browser and the score regression checks. Percentages use ratios (1 = 100%).
const StockScore = (() => {
    const number = value => (typeof value === 'number' || (typeof value === 'string' && value.trim())) && Number.isFinite(Number(value)) ? Number(value) : null;
    const positive = value => { const n = number(value); return n !== null && n > 0 ? n : null; };

    function method(forecast, low, high, cap) {
        [forecast, low, high, cap] = [forecast, low, high, cap].map(positive);
        if ([forecast, low, high, cap].includes(null) || low > high) return null;
        const up = forecast * high / cap - 1, down = forecast * low / cap - 1;
        if (!Number.isFinite(up) || !Number.isFinite(down)) return null;
        const upside = 100 * Math.min(Math.max(up, 0), 1);
        const ratio = up <= 0 ? 0 : down >= 0 ? Infinity : up / Math.abs(down);
        const odds = 100 * Math.min(ratio / 4, 1);
        return { up, down, ratio, upside, odds, total: .6 * upside + .4 * odds };
    }

    function trend(history, currentPrice) {
        if (!Array.isArray(history)) return null;
        const prices = currentPrice === undefined ? history.slice(-20) : [...history.slice(-19), currentPrice];
        if (prices.length !== 20 || prices.some(p => positive(p) === null)) return null;
        const mean = n => prices.slice(-n).reduce((sum, p) => sum + Number(p), 0) / n;
        const [ma5, ma10, ma20] = [5, 10, 20].map(mean);
        return ma5 > ma10 && ma10 > ma20 ? 'up' : ma5 < ma10 && ma10 < ma20 ? 'down' : 'sideways';
    }

    function dateOnly(value) {
        if (typeof value !== 'string') return null;
        const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T]|$)/.exec(value);
        if (!match) return null;
        const [y, m, d] = match.slice(1).map(Number), date = new Date(y, m - 1, d);
        return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? date : null;
    }

    function addMonths(date, months) {
        const lastDay = new Date(date.getFullYear(), date.getMonth() + months + 1, 0).getDate();
        return new Date(date.getFullYear(), date.getMonth() + months, Math.min(date.getDate(), lastDay));
    }

    function forecastDate(stock) {
        // Explicit null freezes unknown legacy dates when only names/tags/notes are edited.
        if (Object.prototype.hasOwnProperty.call(stock, 'forecastUpdatedAt')) return stock.forecastUpdatedAt;
        const logs = Array.isArray(stock.logs) ? stock.logs : [];
        return logs.filter(log => /首次创建|净利[:：]|营收[:：]|确认预测/.test(log.content || '') && dateOnly(log.date))
            .sort((a,b) => dateOnly(b.date) - dateOnly(a.date))[0]?.date || null;
    }

    function freshness(value, now = new Date()) {
        const date = dateOnly(value), today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        if (!date || date > today) return 0;
        return today <= addMonths(date, 2) ? 100 : today <= addMonths(date, 4) ? 60 : 0;
    }

    function calculate(stock, { cap, trend: state, now = new Date() }) {
        const pe = method(stock.profit, stock.lowPE, stock.highPE, cap);
        const ps = method(stock.revenue, stock.lowPS, stock.highPS, cap);
        const methods = [pe, ps].filter(Boolean);
        const valuation = methods.length === 2 ? (pe.total + ps.total) / 2 : methods.length === 1 ? methods[0].total * .8 : null;
        const trendScore = ({ up:100, sideways:50, down:0 })[state] ?? null;
        const updatedAt = forecastDate(stock), update = freshness(updatedAt, now);
        const reasons = [];
        if (positive(cap) === null) reasons.push('缺少有效市值');
        else if (!methods.length) reasons.push('缺少有效 PE / PS 估值');
        if (trendScore === null) reasons.push('趋势数据不足');
        const total = reasons.length ? null : Math.round((.4 * valuation + .3 * trendScore + .3 * update) * 10) / 10;
        return { total, pe, ps, valuation, trend:state, trendScore, updatedAt, update, methodCount:methods.length, reasons };
    }

    return { method, trend, forecastDate, freshness, calculate };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = StockScore;
