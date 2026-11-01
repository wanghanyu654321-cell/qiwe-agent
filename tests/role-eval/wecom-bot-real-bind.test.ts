import {expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
function load(){
 const bind=vi.fn(),ready={value:true},queue={enqueueMessageCheck:vi.fn(),interruptQuery:vi.fn()},receipt={receiptId:'r',workspaceJid:'web:role'},queued=vi.fn(),cancelled=vi.fn();
 const gate={isPaused:()=>!ready.value,noteArrival:vi.fn(),beginWrite:vi.fn(()=>ready.value?{id:'original-ticket'}:null),finishWrite:vi.fn()};
 const source=readFileSync(new URL('../../integrations/native/full-host-conversation-index.fragment',import.meta.url),'utf8');
 const compiled=ts.transpileModule('let d5OnCompleted;\n'+source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const exports:any={};
 const entry=new Function('exports','bindConversationAuthority','appointmentBootGate','queue','readBotConversationReceipt','queueConversationReceipt','cancelConversationReceipt',compiled+';return exports;')(exports,bind,gate,queue,()=>receipt,queued,cancelled);
 return {entry,bind,gate,queue,queued,cancelled,ready};
}
it('binds real callbacks once to the same original queue and write gate',()=>{
 const s=load(),authorize=()=>true,onCompleted=async()=>{};
 const e=s.entry.initializeControlledRealFullHostConversationExecution({mode:'controlled-real-pilot',authorize,onCompleted});
 expect(s.bind).toHaveBeenCalledWith(authorize);expect(e.queue).toBe(s.queue);expect(e.gate).toBe(s.gate);
 e.enqueue('r');expect(s.queued).toHaveBeenCalledWith('r');expect(s.queue.enqueueMessageCheck).toHaveBeenCalledWith('web:role');expect(s.gate.finishWrite).toHaveBeenCalledWith({id:'original-ticket'});
 s.ready.value=false;expect(()=>e.enqueue('r')).toThrow('CONVERSATION_MAINTENANCE');expect(s.queued).toHaveBeenCalledTimes(1);
 expect(()=>s.entry.initializeFullHostConversationExecution({mode:'isolated-synthetic',authorize})).toThrow('FULL_HOST_CONVERSATION_BINDING_INVALID');
});
it('keeps the synthetic and real binds strict and rejects runner replacement before binding',()=>{
 const s=load(),authorize=()=>true;
 expect(()=>s.entry.initializeFullHostConversationExecution({mode:'controlled-real-pilot',authorize})).toThrow('FULL_HOST_CONVERSATION_BINDING_INVALID');
 expect(()=>s.entry.initializeControlledRealFullHostConversationExecution({mode:'isolated-synthetic',authorize})).toThrow('FULL_HOST_CONVERSATION_BINDING_INVALID');
 expect(()=>s.entry.initializeControlledRealFullHostConversationExecution({mode:'controlled-real-pilot',authorize,runner:()=>{}})).toThrow('FULL_HOST_CONVERSATION_BINDING_INVALID');expect(s.bind).not.toHaveBeenCalled();
 s.entry.initializeFullHostConversationExecution({mode:'isolated-synthetic',authorize});expect(()=>s.entry.initializeControlledRealFullHostConversationExecution({mode:'controlled-real-pilot',authorize})).toThrow('FULL_HOST_CONVERSATION_BINDING_INVALID');
});
