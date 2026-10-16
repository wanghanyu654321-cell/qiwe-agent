import type {BotReadScope} from './wecom-bot-context.js';
export interface WecomBotSubject {botId:string;memberId:string;}
export interface WecomBotBinding extends WecomBotSubject {corpId:string;accountId:string;version:number;active:boolean;}
const id=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=120&&!/[\s\u0000]/.test(v);
export function snapshotBinding(value:unknown):WecomBotBinding {
 const b=structuredClone(value) as WecomBotBinding;
 if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!['botId','corpId','memberId','accountId','version','active'].includes(k))||![b.botId,b.corpId,b.memberId,b.accountId].every(id)||!Number.isSafeInteger(b.version)||b.version<1||typeof b.active!=='boolean')throw Error('access_denied');return b;
}
export function createWecomBotBindingReader(readCatalog:(scope:BotReadScope)=>Promise<unknown>){
 return async(subject:Readonly<WecomBotSubject>,scope:BotReadScope):Promise<WecomBotBinding>=>{
 const rows=structuredClone(await readCatalog(scope));if(!Array.isArray(rows))throw Error('access_denied');
 const bindings=rows.map(snapshotBinding),matches=bindings.filter(b=>b.botId===subject.botId&&b.memberId===subject.memberId);
 const binding=matches[0];if(matches.length!==1||!binding?.active)throw Error('access_denied');return binding;
 };
}
