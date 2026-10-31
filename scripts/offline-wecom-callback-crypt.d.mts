export interface FakeCallbackKeys {
  label: 'offline-simulation-fake-keys';
  token: string;
  encodingAESKey: string;
  receiveId: string;
}
export interface CallbackEnvelope {
  msg_signature: string;
  timestamp: string;
  nonce: string;
  encrypt: string;
}
export function createFakeCallbackKeys(): FakeCallbackKeys;
export function signCallback(keys: FakeCallbackKeys, envelope: Pick<CallbackEnvelope, 'timestamp' | 'nonce' | 'encrypt'>): string;
export function verifySignature(keys: FakeCallbackKeys, envelope: CallbackEnvelope): boolean;
export function sealCallback(keys: FakeCallbackKeys, plaintext: string): CallbackEnvelope;
export function openCallback(keys: FakeCallbackKeys, envelope: CallbackEnvelope): string;
