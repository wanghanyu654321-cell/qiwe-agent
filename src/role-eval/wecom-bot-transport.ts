export interface BotEvent {
  reqId:string;botId:string;memberId:string;corpId?:string;messageId:string;createTime?:number;
  action:{kind:'text';text:string}|{kind:'confirm';reportId:string;hash:string};
}
export interface BotCard {card_type:'button_interaction';main_title:{title:string};task_id:string;button_list:{text:string;key:string;style:1}[];}
export interface BotReplyPlan {reqId:string;body:{msgtype:'stream'|'stream_with_template_card';stream:{id:string;finish:true;content:string};template_card?:BotCard};}
/** Trusted SDK event port only; this parser is not platform authentication. */
export function normalizeBotFrame(input:unknown):BotEvent {
 const record=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
 const str=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f]/.test(v);
 const frame=record(input),body=record(frame.body),from=record(body.from),reqId=record(frame.headers).req_id;
 if(!str(reqId,200)||!str(body.aibotid,120)||!str(body.msgid,512)||!str(from.userid,120)||body.chattype!=='single'||from.corpid!==undefined&&!str(from.corpid,120))throw Error('unsupported_event');
 const time=body.create_time;
 if(time!==undefined&&(!Number.isSafeInteger(time)||(time as number)<0||!Number.isFinite(new Date((time as number)*1000).getTime())))throw Error('unsupported_event');
 const base={reqId,botId:body.aibotid,memberId:from.userid,messageId:body.msgid,...(from.corpid!==undefined?{corpId:from.corpid as string}:{}),...(time!==undefined?{createTime:time as number}:{})};
 const content=record(body.text).content;
 if(frame.cmd==='aibot_msg_callback'&&body.msgtype==='text'&&typeof content==='string'&&content.trim()&&content.length<=4000)return {...base,action:{kind:'text',text:content}};
 const event=record(body.event);
 const task=typeof event.task_id==='string'?/^report-([a-f0-9]{64})-[a-f0-9]{32}$/.exec(event.task_id):null;
 if(frame.cmd==='aibot_event_callback'&&body.msgtype==='event'&&event.eventtype==='template_card_event'&&task&&typeof event.event_key==='string'&&/^confirm:[a-f0-9]{64}$/.test(event.event_key))return {...base,action:{kind:'confirm',reportId:task[1]!,hash:event.event_key.slice(8)}};
 throw Error('unsupported_event');
}
