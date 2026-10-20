import {WSClient, type WsFrame} from '@wecom/aibot-node-sdk';
import {vi} from 'vitest';
import type {BotSdkPort, BotFileSdkPort} from '../../src/role-eval/wecom-bot-sender.js';

/** Network replacement exists only here. Inputs still run the installed MessageHandler. */
export function offlineBotSdk() {
  const client = new WSClient({botId: 'bot', secret: 'synthetic-placeholder', logger: {debug() {}, info() {}, warn() {}, error() {}}});
  const connect = vi.spyOn(client, 'connect').mockImplementation(() => {throw Error('network_forbidden');});
  const disconnect = vi.spyOn(client, 'disconnect').mockImplementation(() => {throw Error('shared_sdk_must_not_close');});
  const manager = Reflect.get(client, 'wsManager') as {
    onMessage(frame: WsFrame): void; onAuthenticated(): void; onConnected(): void;
    onDisconnected(reason: string): void; onReconnecting(attempt: number): void; onError(error: Error): void;
    sendReply(reqId: string, body: unknown, cmd?: string): Promise<WsFrame>;
  };
  let connected = true;
  Object.defineProperty(manager, 'isConnected', {get: () => connected});
  const sent: {cmd: string; headers: {req_id: string}; body: Record<string, unknown>}[] = [];
  let acknowledge: ((frame: (typeof sent)[number]) => Promise<WsFrame>) | undefined;
  manager.sendReply = async (reqId, body, cmd = 'aibot_respond_msg') => {
    const frame = structuredClone({cmd, headers: {req_id: reqId}, body: body as Record<string, unknown>});
    sent.push(frame);
    if (acknowledge) return acknowledge(frame);
    return {headers: {req_id: reqId}, errcode: 0, body: cmd === 'aibot_upload_media_init' ? {upload_id: 'synthetic-upload'} : cmd === 'aibot_upload_media_finish' ? {type: 'file', media_id: 'synthetic-media'} : {}};
  };
  const sdk: BotSdkPort = {mode: 'isolated-synthetic', ready: () => true,
    reply: (frame, body) => client.reply(frame, body), sendMessage: (member, body) => client.sendMessage(member, body)};
  const fileSdk: BotFileSdkPort = {mode: 'isolated-synthetic', uploadMedia: (bytes, options) => client.uploadMedia(bytes, options),
    sendMessage: (member, body) => client.sendMessage(member, body)};
  return {client, sdk, fileSdk, sent, connect, disconnect,
    setAcknowledge: (read: typeof acknowledge) => {acknowledge = read;},
    frame: (frame: unknown) => manager.onMessage(frame as WsFrame),
    authenticate: () => {connected = true; manager.onAuthenticated();},
    lifecycle: (kind: 'connected' | 'disconnected' | 'reconnecting' | 'error') => {
      if (kind === 'connected') {connected = true; manager.onConnected();}
      else if (kind === 'disconnected') {connected = false; manager.onDisconnected('synthetic');}
      else if (kind === 'reconnecting') manager.onReconnecting(1);
      else manager.onError(Error('sensitive_raw_error'));
    },
  };
}
