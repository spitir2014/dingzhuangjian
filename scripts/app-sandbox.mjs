/* No network/DOM side effects: run the production compiler and context rules in Node. */
import fs from 'node:fs/promises';
import vm from 'node:vm';
export async function createAppSandbox() {
  const src = await fs.readFile('web/app.js', 'utf8');
  function balanced(start) {
    let depth = 0, quote = null, escaped = false;
    for (let i=start;i<src.length;i++) {
      const c=src[i];
      if(quote){if(escaped){escaped=false;continue;}if(c==='\\'){escaped=true;continue;}if(c===quote)quote=null;continue;}
      if(['"',"'",'`'].includes(c)){quote=c;continue;}
      if(c==='/'&&src[i+1]==='/'){while(i<src.length&&src[i]!=='\n')i++;continue;}
      if(c==='/'&&src[i+1]==='*'){i+=2;while(i<src.length&&!(src[i]==='*'&&src[i+1]==='/'))i++;i++;continue;}
      if(c==='{')depth++;if(c==='}'&&--depth===0)return src.slice(start,i+1);
    }
    throw Error('Unbalanced source');
  }
  function fn(name){const m=new RegExp('function\\s+'+name+'\\s*\\(').exec(src);if(!m)throw Error('Missing '+name);const b=src.indexOf('{',m.index);return src.slice(m.index,b)+balanced(b);}
  function con(name){const m=new RegExp('const\\s+'+name+'\\s*=\\s*\\{').exec(src);if(!m)throw Error('Missing '+name);return 'const '+name+' = '+balanced(src.indexOf('{',m.index))+';';}
  const read=async n=>JSON.parse(await fs.readFile('data/'+n+'.json','utf8'));
  const [params,templates,layouts,names,eras]=await Promise.all(['params','templates','layouts','names','eras'].map(read));
  const DATA={params,order:templates.order,content:templates.content,layouts:layouts.layouts,eras,names};
  const state={blocks:[],templateText:{},templateId:'sheet_2view',params:{},meta:{name:'测试人物',identity:'验收',personality:'平静',styleKeywords:[]},highlights:[],ratio:'16:9',res:'2K',quality:'high',detailPreset:'detailed',locks:new Set(),seed:12345,lookId:'',lookCustomized:{},manualOverrides:{},derivedConflicts:[],rollTick:0,paramRevision:0};
  params.groups.forEach(g=>g.params.forEach(p=>state.params[p.id]=p.default));
  const paramIndex=Object.fromEntries(params.groups.flatMap(g=>g.params.map(p=>[p.id,p])));
  const RATIOS=new Function('return '+/const RATIOS = (\[[\s\S]*?\n\]);/.exec(src)[1])();
  const RES_LIST=new Function('return '+/const RES_LIST = (\[[^\]]*\]);/.exec(src)[1])();
  const functions=['bandFor','isContentBlock','currentTemplate','templateSuppressedIds','isBlockSuppressed','ratioOrient','templateOrient','ratioAllowed','ensureRatioForTemplate','defaultBlocks','ensureBlockSkeleton','applyTemplateStructure','applyDetailPresetFlags','migrateLegacyContent','migrateLegacyStructure','loadBlocks','compileBlockText','buildPromptSnapshot','expandCovers','compilePrompt','buildVars','currentSex','sexMeta','currentRatio','sizeString','aspectText','costumeText','applyLookData','budgetFor','eraOn','eraDef','optionLabel','costumeRolePhrase','currentRankInfo','eraNegative','gateOk','weightOf','allowedOptions','pickWeighted','mulberry32','pick','randInt','hashId','sexRange','clampToSex','normalizeCostumeContext','normalizeContext','matchingLook','clearCostumeSlots','currentLook','cardOverrides','cardOwned','identityPhrase','applyIdentityCard','applyDerived','applyCorrelations','sanitizeParams','commitParams','currentLookEvidence','snapshotJob','genderDir','genMeta','effectiveUsage','usedVarKeys'];
  const context=vm.createContext({DATA,state,paramIndex,RATIOS,RES_LIST,console,saveState(){},renderSizeControls(){},toast(){},$(){return null;},syncAll(){},updatePromptPreview(){},renderParams(){},scheduleBlockMetaRefresh(){}});
  vm.runInContext(['DETAIL_PRESETS','LEGACY_CONTENT','LEGACY_STRUCT'].map(con).join('\n')+'\n'+functions.map(fn).join('\n'),context);
  const run=expression=>vm.runInContext(expression,context);
  return {DATA,state,paramIndex,run};
}
