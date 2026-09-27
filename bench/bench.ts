
// @ts-nocheck
import { analyse, process as runPipeline, DEFAULT_PARAMS, autoParams } from '../src/pipeline.ts';
class NI { constructor(a,b,c){ if(typeof a==='number'){this.width=a;this.height=b;this.data=new Uint8ClampedArray(a*b*4);} else {this.data=a;this.width=b;this.height=c;} } }
globalThis.ImageData = NI;
const mk=(W,H,seed)=>{const s=new NI(W,H);const d=s.data;
 for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=(y*W+x)*4;const depth=y/H;
  const tex=40*Math.sin((x+seed)/3.1)*Math.cos(y/2.7)+30*Math.sin(x/11+y/9);
  const rs=x<W*0.35?170:20;
  let r=(rs+tex)*(1-depth*0.75),g=(100+tex)*(1-depth*0.4),b=(80+tex)*(1+depth*0.55);
  r+=18+depth*22;g+=55+depth*40;b+=85+depth*55;
  d[i]=Math.max(0,Math.min(255,r));d[i+1]=Math.max(0,Math.min(255,g));d[i+2]=Math.max(0,Math.min(255,b));d[i+3]=255;}
 return s;};

for (const [w,h] of [[1280,720],[960,540],[640,360]]) {
  const src=mk(w,h,0);
  const a=analyse(src);
  const p=autoParams({...DEFAULT_PARAMS},a);
  // warm up
  runPipeline(src,p,a);
  const t0=performance.now();
  const N=5;
  for(let i=0;i<N;i++) runPipeline(src,p,a);
  const t1=performance.now();
  const per=(t1-t0)/N;
  console.log(`${w}x${h}  ${per.toFixed(1)} ms/frame  -> ${(1000/per).toFixed(1)} fps ceiling`);
}
