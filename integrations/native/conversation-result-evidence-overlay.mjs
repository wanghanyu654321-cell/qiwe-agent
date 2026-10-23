import fs from 'node:fs';

function once(source,before,after){
 if(typeof source!=='string'||source.split(before).length!==2)throw Error('CONVERSATION_RESULT_EVIDENCE_ANCHOR_CHANGED');
 return source.replace(before,after);
}
/** The existing complete O+D1–D5 scanner consumes a bounded same-snapshot D5
 * relationship witness. It grants no record disposition or restore permit. */
export function applyConversationResultEvidence(files){
 const result=new Map(files);
 let inventory=files.get('appointment-boot-inventory.ts').replaceAll('\r\n','\n');
 const fragment=fs.readFileSync(new URL('./conversation-result-evidence.fragment',import.meta.url),'utf8');
 inventory=once(inventory,'  let initialBasis: string | undefined;',fragment+'\n  let initialBasis: string | undefined;');
 inventory=once(inventory,'              records.push({\n                kind: family',`              const resultWitness=table==='wecom_conversation_results'?conversationResultEvidence(row):undefined;
              if(resultWitness)evidence.push(...resultWitness.evidence);
              records.push({
                kind: family`);
 inventory=once(inventory,'                version: digest(JSON.stringify(row)),','                version: resultWitness?.version ?? digest(JSON.stringify(row)),');
 result.set('appointment-boot-inventory.ts',inventory);
 return result;
}
