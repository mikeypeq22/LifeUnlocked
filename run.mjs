import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
const bot = fs.readFileSync(new URL('./bot.js', import.meta.url),'utf8');
// usage: node run.mjs <game.html> <hours> <decide-every-seconds> <seeds> <label>
// optional: BAL='{"xpQuad":0.3}' to try balance tweaks without editing the game
const [,, game='index.html', hours='2', every='30', seeds='1', label='active'] = process.argv;
const bal = process.env.BAL ? JSON.parse(process.env.BAL) : null;
const b = await chromium.launch(process.env.CHROME ? {executablePath: process.env.CHROME} : {});
const out=[];
await Promise.all(Array.from({length:+seeds},(_, k)=>k+1).map(async seed=>{
  const ctx = await b.newContext();
  await ctx.route('**/fonts.g*/**', r=>r.abort());
  await ctx.addInitScript(({seed})=>{ let a=seed*2654435761>>>0; Math.random=()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}; window.setInterval=()=>0; }, {seed});
  const p = await ctx.newPage(); p.on('pageerror',e=>console.error('ERR',e.message));
  await p.goto('file://'+path.resolve(game));
  if (bal) await p.evaluate(b=>{ for (const k in b) { if (k==='tiers') b.tiers.forEach((t,i)=>t&&Object.assign(BAL.tiers[i],t)); else BAL[k]=b[k]; } setTrack(s.track); resetBattle(); }, bal);
  await p.addScriptTag({content: bot});
  const r = await p.evaluate(a=>runBot(a), {hours:+hours, every:+every, label});
  r.seed=seed; out.push(r); await ctx.close();
}));
fs.writeFileSync(`res-${label}.json`, JSON.stringify(out,null,1));
const fmtT=t=>t===undefined?'—':t<3600?(t/60).toFixed(1)+'m':(t/3600).toFixed(2)+'h';
const keys=[...new Set(out.flatMap(r=>Object.keys(r.M)))].sort((a,b)=>(out[0].M[a]??1e9)-(out[0].M[b]??1e9));
console.log(label,'deaths',out.map(r=>r.deaths),'final',JSON.stringify(out[0].final));
for(const k of keys) console.log(k.padEnd(28), out.map(r=>fmtT(r.M[k])).join('  '));
const tl=out[0].timeline; for (const x of tl.filter((x,i)=>i%Math.max(1,Math.floor(tl.length/10))===0)) console.log(JSON.stringify(x));
await b.close();
