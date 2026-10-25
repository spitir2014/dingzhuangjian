/* Dry-run by default. Explicit --execute submits only missing samples, one probe first.
   Stops on a real pixel mismatch; never changes the provider/model or retries a billable POST. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createAppSandbox} from './app-sandbox.mjs';
import {imageDimensions} from './image-dimensions.mjs';

const execute=process.argv.includes('--execute');
if(process.argv.some(x=>x.startsWith('--offset=')))throw Error('Offset runs are retired. Existing archives are used for safe resume.');
const base=process.env.P2_BASE_URL || 'http://127.0.0.1:8788';
const model='gpt-image-2.5-sunburst',size='2048x1152';
const {DATA,state,run}=await createAppSandbox();
const cases=[['qe_civil_1','sheet_2view'],['qe_civil_3','sheet_2view'],['qe_civil_5','sheet_2view'],['qe_civil_9','sheet_2view'],['qe_military_1','sheet_2view'],['qe_military_3','sheet_2view'],['qe_military_5','sheet_2view'],['qe_military_7','sheet_2view'],['qe_emperor_ceremony','sheet_2view'],['qe_empress_ceremony','sheet_2view'],['qe_qinwang_daily','sheet_2view'],['ql_noble_lady','sheet_2view'],['ql_xinjun','sheet_2view'],['ql_donated_merchant','sheet_2view'],['qe_civil_1','costume_breakdown']];
const plan=cases.flatMap(([lookId,layout],i)=>[1,2].map(variant=>({no:i*2+variant,lookId,layout,variant})));
const stored=new Map();
for(const sex of ['男','女','中性']) {
  const dir=path.join('output','人物',sex);
  for(const file of await fs.readdir(dir).catch(()=>[])){
    if(!file.endsWith('.json')||!file.includes('P2'))continue;
    const rec=JSON.parse(await fs.readFile(path.join(dir,file),'utf8'));
    const match=/_P2_(\d+)_/.exec(file),no=match?Number(match[1]):file.includes('P2探针')?1:0;
    if(!plan.some(x=>x.no===no))continue;
    const target=plan.find(x=>x.no===no);
    if(rec.promptMeta?.evidence?.lookId!==target.lookId||rec.promptMeta?.layout!==target.layout)throw Error('Archive identity mismatch: '+file);
    if(rec.meta?.model!==model||rec.promptMeta?.size!==size)throw Error('Archive model/size mismatch: '+file);
    if(stored.has(no))throw Error('Duplicate sample '+no+'; inspect archives before requesting more.');
    const image=path.join(dir,rec.file),actual=imageDimensions(await fs.readFile(image));
    stored.set(no,{no,image,actual,sizeMatches:actual?.width===2048&&actual?.height===1152});
  }
}
const missing=plan.filter(item=>!stored.has(item.no));
console.log(JSON.stringify({execute,base,model,size,total:30,archived:stored.size,missing:missing.map(x=>x.no),pixelMismatches:[...stored.values()].filter(x=>!x.sizeMatches)},null,2));
if(!execute)process.exit(0);
if(!missing.length){console.log('All 30 samples already exist. No billable requests sent.');process.exit(0);}
const invalid=[...stored.values()].find(x=>!x.sizeMatches);
if(invalid)throw Error('Existing probe/sample actual pixels differ from requested 2K. No further requests allowed: '+invalid.image);
const cfg=await fetch(base+'/api/config').then(r=>r.json());
const provider=cfg.providers.find(p=>p.name==='mlgb7');
if(!provider)throw Error('mlgb7 provider unavailable');
const journalPath='tmp/p2-live-journal.json';
await fs.mkdir('tmp',{recursive:true}); /* tmp/ 是可清空的临时区，起手先确保存在 */
const journal=JSON.parse(await fs.readFile(journalPath,'utf8').catch(()=>'[]'));
if(journal.some(x=>x.type==='submit-intent'&&missing.some(m=>x.samples.includes(m.no))))throw Error('A previous submission may still be active. Reconcile the journal and archives before retrying.');
async function record(event){journal.push({...event,time:new Date().toISOString()});await fs.writeFile(journalPath,JSON.stringify(journal,null,2)+'\n');}
function jobFor(item,idx){
  state.templateId=item.layout;state.ratio='16:9';state.res='2K';state.seed=2026102500+item.no;
  state.params.age=item.variant===1?32:46;state.params.height=item.variant===1?172:178;
  state.meta={name:'P2_'+item.no,identity:'',personality:'沉静',trait:'',styleKeywords:['档案摄影']};
  const look=DATA.eras.looks.find(l=>l.id===item.lookId);state.meta.identity=look.label;
  run('applyLookData('+JSON.stringify(look)+');clampToSex();applyTemplateStructure();loadBlocks();');
  state.providerId=provider.id;state.modelId=model;
  const job=run('snapshotJob('+idx+',1)');job.retries=1;
  job.filenameHint='P2_'+String(item.no).padStart(2,'0')+'_'+item.lookId+'_'+item.variant+'_'+DATA.layouts.find(l=>l.id===item.layout).label;
  job.promptMeta.validation={sample:item.no,variant:item.variant};
  return job;
}
async function submit(items){
  const jobs=items.map(jobFor);jobs.forEach(j=>j.total=jobs.length);
  await record({type:'submit-intent',samples:items.map(i=>i.no)});
  const response=await fetch(base+'/api/generate-batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({providerId:provider.id,jobs}),signal:AbortSignal.timeout(1200000)});
  if(!response.ok)throw Error('Local submission HTTP '+response.status);
  const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';const events=[];
  for(;;){const chunk=await reader.read();pending+=decoder.decode(chunk.value||new Uint8Array(),{stream:!chunk.done});let split;while((split=pending.indexOf('\n'))>=0){const line=pending.slice(0,split);pending=pending.slice(split+1);if(!line.trim())continue;const event=JSON.parse(line);events.push(event);if(event.type!=='heartbeat'){await record({...event,samples:items.map(i=>i.no)});console.log(JSON.stringify(event));}}if(chunk.done)break;}
  const done=events.find(e=>e.type==='batch-done');
  if(!done||done.fail||done.ok!==items.length)throw Error('Batch incomplete/failed; journal retained. Do not resubmit blindly.');
  for(const e of events.filter(e=>e.type==='job-done'&&e.ok)){
    const actual=imageDimensions(await fs.readFile(path.join('output',e.rel,e.file)));
    if(actual?.width!==2048||actual?.height!==1152)throw Error('Actual pixels are not 2048x1152; stop further requests.');
  }
}
if(!stored.has(1)){await submit([plan[0]]);missing.splice(missing.findIndex(i=>i.no===1),1);}
for(let offset=0;offset<missing.length;offset+=10)await submit(missing.slice(offset,offset+10));
