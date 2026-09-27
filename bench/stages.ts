
import { analyse, process as runPipeline, DEFAULT_PARAMS } from '../src/pipeline.ts';
import { NodeImageData as NI, installImageDataShim, asImg } from '../test/shim.ts';
installImageDataShim();
const w=1280,h=720;
const src=new NI(w,h); const d=src.data;
for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4;const depth=y/h;
 const tex=40*Math.sin(x/3.1)*Math.cos(y/2.7)+30*Math.sin(x/11+y/9);
 const rs=x<w*0.35?170:20;
 let r=(rs+tex)*(1-depth*0.75),g=(100+tex)*(1-depth*0.4),b=(80+tex)*(1+depth*0.55);
 r+=18+depth*22;g+=55+depth*40;b+=85+depth*55;
 d[i]=Math.max(0,Math.min(255,r));d[i+1]=Math.max(0,Math.min(255,g));d[i+2]=Math.max(0,Math.min(255,b));d[i+3]=255;}

const base={...DEFAULT_PARAMS,auto:false};
const t=(label: string, cfg: Record<string, number>)=>{
  // warm
  runPipeline(asImg(src),{...base,...cfg},analyse(asImg(src)));
  const t0=performance.now(); const N=3;
  for(let i=0;i<N;i++) runPipeline(asImg(src),{...base,...cfg},analyse(asImg(src)));
  console.log(label.padEnd(22), ((performance.now()-t0)/N).toFixed(1),'ms');
};
const off={wbStrength:0,redStrength:0,dehazeStrength:0,claheClip:0,sharpenAmount:0,gamma:1,blackPoint:0,whitePoint:1,saturation:1};
t('analyse only', {...off});
t('+ wb', {...off, wbStrength:1});
t('+ red', {...off, redStrength:0.5});
t('+ dehaze', {...off, dehazeStrength:1});
t('+ clahe', {...off, claheClip:2});
t('+ sharpen', {...off, sharpenAmount:0.6});
t('EVERYTHING', {});
