
// micro-profile of the dehaze internals at 1280x720
const w=1280,h=720,n=w*h;
const r=new Float32Array(n), g=new Float32Array(n), b=new Float32Array(n);
for(let i=0;i<n;i++){r[i]=Math.random()*0.5;g[i]=Math.random()*0.5;b[i]=Math.random()*0.5;}
function minFilter(src: Float32Array, w: number, h: number, rad: number){
  const tmp=new Float32Array(src.length), out=new Float32Array(src.length);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){let m=1;const x0=Math.max(0,x-rad),x1=Math.min(w-1,x+rad);
    for(let k=x0;k<=x1;k++){const v=src[y*w+k];if(v<m)m=v;} tmp[y*w+x]=m;}
  for(let x=0;x<w;x++)for(let y=0;y<h;y++){let m=1;const y0=Math.max(0,y-rad),y1=Math.min(h-1,y+rad);
    for(let k=y0;k<=y1;k++){const v=tmp[k*w+x];if(v<m)m=v;} out[y*w+x]=m;}
  return out;
}
const T=(l: string, f: () => void)=>{f();const t0=performance.now();for(let i=0;i<3;i++)f();console.log(l.padEnd(26),((performance.now()-t0)/3).toFixed(1),'ms');};
T('minFilter r=3 x3',()=>{minFilter(r,w,h,3);minFilter(g,w,h,3);minFilter(b,w,h,3);});
const dark=new Float32Array(n);
for(let i=0;i<n;i++)dark[i]=Math.min(r[i],g[i],b[i]);
T('minFilter r=5',()=>minFilter(dark,w,h,5));
const t=new Float32Array(n); for(let i=0;i<n;i++)t[i]=1-0.75*dark[i];
T('minFilter r=5 again',()=>minFilter(t,w,h,5));
