import assert from 'node:assert/strict';
import { createAppSandbox } from './app-sandbox.mjs';
const {DATA,state,run}=await createAppSandbox();
for(const look of DATA.eras.looks){
  run('applyLookData('+JSON.stringify(look)+'); clampToSex(); loadBlocks();');
  for(const [slot,value] of Object.entries(look.slots))assert.equal(state.params[slot],value,look.id+'/'+slot+' survives real UI clamp');
  assert.equal(run('currentLookEvidence().modified'),false,look.id+' evidence preserved');
  const job=run('snapshotJob(0,1)');
  assert.equal(job.character.lookId,look.id);assert.equal(job.promptMeta.evidence.lookId,look.id);
}
run("applyLookData(DATA.eras.looks.find(l=>l.id==='ql_noble_lady')); state.params.era='qing_early'; normalizeCostumeContext('era');");
assert.equal(state.params.era,'qing_early');
assert.notEqual(state.params.headwear,'dalachi');assert.notEqual(state.params.shoes,'huapendi');
run("applyLookData(DATA.eras.looks.find(l=>l.id==='qe_civil_1')); state.params.rank='9'; normalizeCostumeContext('rank');");
assert.equal(state.params.accessory,'none');assert.match(run('costumeText()'),/练雀/);assert.equal(run('currentLookEvidence().modified'),true);
run("state.params.rank='3'; normalizeCostumeContext('rank');");assert.equal(state.params.accessory,'chaozhu');assert.match(run('costumeText()'),/孔雀/);
run("applyLookData(DATA.eras.looks.find(l=>l.id==='qe_empress_ceremony')); state.templateId='portrait';");
assert.doesNotMatch(run('costumeText()'),/鞋|朝裙|朝裳/);
run("state.templateId='costume_breakdown'; loadBlocks();");assert.doesNotMatch(run('compilePrompt()'),/人物信息写|画面高度的 8%/);
run("state.params.era='none'; state.lookId='qe_empress_ceremony';");assert.equal(run('currentLookEvidence()'),null);
console.log('P2: '+DATA.eras.looks.length+' cards survive UI clamp; snapshots, era switching, ranks, evidence and crop passed.');
