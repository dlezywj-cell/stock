importScripts('score.js?v=2','backtest-engine.js?v=16');
self.onmessage=event=>{
    const {data,options,stress}=event.data;
    try {
        const result=ScoreBacktest.run(data,{...options,exposureControl:true},value=>self.postMessage({type:'progress',value:value*.45}));
        const baseline=ScoreBacktest.run(data,{...options,exposureControl:false},value=>self.postMessage({type:'progress',value:.45+value*.45}));
        const stressed=stress ? ScoreBacktest.run(data,{...options,exposureControl:true,costBps:options.costBps*2},value=>self.postMessage({type:'progress',value:.9+value*.1})) : null;
        self.postMessage({type:'result',result,baseline,stressed});
    } catch(error) {self.postMessage({type:'error',message:error.message});}
};
