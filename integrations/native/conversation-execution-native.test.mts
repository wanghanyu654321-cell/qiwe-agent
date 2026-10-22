import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import {applyConversationExecution} from './conversation-execution-overlay.mjs';

describe('D3 opt-in source admission',()=>{
 it('fails closed when the supplied original execution closure has changed',()=>{
  expect(()=>applyConversationExecution(new Map(),new Map())).toThrow('D3_SOURCE_MISSING');
 });
});
