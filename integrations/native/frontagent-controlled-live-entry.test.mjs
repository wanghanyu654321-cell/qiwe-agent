import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validatePilotPrivateInput} from './frontagent-controlled-live-entry.mjs';

test('accepts the explicitly configured single local test bot and DeepSeek provider',()=>{
 const input={bot:{botId:'bot',corpId:'corp',secret:'private'},model:{apiKey:'private',baseUrl:'https://api.deepseek.com/anthropic',model:'deepseek-flash'}};
 const accepted=validatePilotPrivateInput(input);
 assert.deepEqual(accepted,input);input.bot.botId='other';assert.equal(accepted.bot.botId,'bot');
});
test('rejects missing or substituted model and bot credentials without displaying secrets',()=>{
 for(const input of [{},{bot:{botId:'bot',corpId:'corp',secret:'s'}},{bot:{botId:'bot',corpId:'corp',secret:'secret-value'},model:{apiKey:'k',baseUrl:'https://wrong.example',model:'deepseek-flash'}}]){
  assert.throws(()=>validatePilotPrivateInput(input),error=>error.message==='CONTROLLED_REAL_PRIVATE_INPUT_INVALID'&&!error.message.includes('secret-value'));
 }
});
