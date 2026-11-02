import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import {applyConversationExecution} from './conversation-execution-overlay.mjs';
import {createFullHostCandidate} from './full-host-candidate.mjs';

describe('D3 opt-in source admission',()=>{
 it('fails closed when the supplied original execution closure has changed',()=>{
  expect(()=>applyConversationExecution(new Map(),new Map())).toThrow('D3_SOURCE_MISSING');
 });
 it('rejects incompatible complete-host scope before reading any original tree',async()=>{
  for(const options of [{fullHostConversationExecution:'yes'},{fullHostConversationExecution:true},{conversationIntake:true,conversationExecution:true,fullHostConversationExecution:true}])
   await expect(createFullHostCandidate('unused','unused',options as any)).rejects.toThrow(/FULL_HOST_(INVALID_EXECUTION_SCOPE|CONVERSATION_SCOPE_CONFLICT)/);
 });
});
