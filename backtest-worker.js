importScripts('score.js?v=2','backtest-engine.js?v=7');
self.onmessage=event=>{
    const {data,options,stress}=event.data;
    try {
        const result=ScoreBacktest.run(data,options,value=>self.postMessage({type:'progress',value:stress?value/2:value}));
        const stressed=stress ? ScoreBacktest.run(data,{...options,costBps:options.costBps*2},value=>self.postMessage({type:'progress',value:.5+value/2})) : null;
        self.postMessage({type:'result',result,stressed});
    } catch(error) {self.postMessage({type:'error',message:error.message});}
};
