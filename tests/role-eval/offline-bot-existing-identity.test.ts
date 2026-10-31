import {afterEach,expect,it,vi} from 'vitest';
import {offlineBotSdk} from '../fixtures/offline-bot-sdk.js';

afterEach(()=>vi.restoreAllMocks());
it('uses the selected bot identity while keeping SDK input and offline ACK transport',async()=>{
 const sdk=offlineBotSdk('existing-bot');
 const received:unknown[]=[];sdk.client.on('message.text',message=>{received.push(message);});
 sdk.frame({cmd:'aibot_msg_callback',headers:{req_id:'existing-frame'},body:{msgid:'existing-synthetic',aibotid:'existing-bot',msgtype:'text',chattype:'single',create_time:1792458000,from:{userid:'existing-member',corpid:'existing-corp'},text:{content:'[synthetic]'} }});
 expect(received).toHaveLength(1);expect(received[0]).toMatchObject({body:{aibotid:'existing-bot',from:{userid:'existing-member'}}});
 const ack=await sdk.client.sendMessage('existing-member',{msgtype:'markdown',markdown:{content:'[synthetic]'}});
 expect(ack.errcode).toBe(0);expect(sdk.sent).toMatchObject([{cmd:'aibot_send_msg',body:{chatid:'existing-member'}}]);
 expect(sdk.connect).not.toHaveBeenCalled();expect(sdk.disconnect).not.toHaveBeenCalled();
});
