import {createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual} from 'node:crypto';

/** Offline envelope for fake callback fixtures. Not smart-bot websocket authentication. */
const BLOCK = 32;
const FAKE_RECEIVE_ID = 'fake-corp-offline-sim';

export function createFakeCallbackKeys() {
  const aes = randomBytes(32);
  return {
    label: 'offline-simulation-fake-keys',
    token: 'fake-token-' + randomBytes(8).toString('hex'),
    encodingAESKey: aes.toString('base64').replace(/=+$/, ''),
    receiveId: FAKE_RECEIVE_ID
  };
}

function assertFakeKeys(keys) {
  if (!keys || keys.label !== 'offline-simulation-fake-keys' || keys.receiveId !== FAKE_RECEIVE_ID) throw Error('fake_key_rejected');
  if (typeof keys.token !== 'string' || !/^fake-token-[0-9a-f]{16}$/.test(keys.token)) throw Error('fake_key_rejected');
  if (typeof keys.encodingAESKey !== 'string' || !/^[A-Za-z0-9+/]{43}$/.test(keys.encodingAESKey)) throw Error('fake_key_rejected');
  const key = Buffer.from(keys.encodingAESKey + '=', 'base64');
  if (key.length !== 32) throw Error('fake_key_rejected');
  return key;
}

function pkcs7Pad(input) {
  const mod = input.length % BLOCK;
  const amount = mod === 0 ? BLOCK : BLOCK - mod;
  return Buffer.concat([input, Buffer.alloc(amount, amount)]);
}

function pkcs7Unpad(input) {
  if (input.length === 0 || input.length % BLOCK !== 0) throw Error('decrypt_failed');
  const amount = input[input.length - 1];
  if (amount < 1 || amount > BLOCK) throw Error('decrypt_failed');
  for (let index = 0; index < amount; index += 1) {
    if (input[input.length - 1 - index] !== amount) throw Error('decrypt_failed');
  }
  return input.subarray(0, input.length - amount);
}

function encryptRaw(key, padded) {
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
}

function decryptRaw(key, encrypt) {
  let data;
  try { data = Buffer.from(encrypt, 'base64'); } catch { throw Error('decrypt_failed'); }
  if (data.length === 0 || data.length % 16 !== 0) throw Error('decrypt_failed');
  try {
    const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
    decipher.setAutoPadding(false);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    throw Error('decrypt_failed');
  }
}

export function signCallback(keys, envelope) {
  assertFakeKeys(keys);
  if (!envelope || typeof envelope.timestamp !== 'string' || typeof envelope.nonce !== 'string' || typeof envelope.encrypt !== 'string') throw Error('bad_signature');
  if (!/^[0-9]{10}$/.test(envelope.timestamp) || !/^[0-9a-f]{16}$/.test(envelope.nonce) || envelope.encrypt.length < 16 || envelope.encrypt.length > 400000) throw Error('bad_signature');
  return createHash('sha1').update([keys.token, envelope.timestamp, envelope.nonce, envelope.encrypt].sort().join('')).digest('hex');
}

export function verifySignature(keys, envelope) {
  try {
    if (!envelope || typeof envelope.msg_signature !== 'string' || !/^[0-9a-f]{40}$/.test(envelope.msg_signature)) return false;
    const expected = Buffer.from(signCallback(keys, envelope));
    const actual = Buffer.from(envelope.msg_signature);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function sealCallback(keys, plaintext) {
  const key = assertFakeKeys(keys);
  if (typeof plaintext !== 'string' || plaintext.length < 1 || Buffer.byteLength(plaintext) > 65536) throw Error('plaintext_rejected');
  const message = Buffer.from(plaintext, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(message.length, 0);
  const packed = pkcs7Pad(Buffer.concat([randomBytes(16), length, message, Buffer.from(keys.receiveId, 'utf8')]));
  const encrypt = encryptRaw(key, packed);
  const envelope = {timestamp: String(Math.floor(Date.now() / 1000)), nonce: randomBytes(8).toString('hex'), encrypt};
  return {...envelope, msg_signature: signCallback(keys, envelope)};
}

export function openCallback(keys, envelope) {
  if (!verifySignature(keys, envelope)) throw Error('bad_signature');
  const key = assertFakeKeys(keys);
  const packed = pkcs7Unpad(decryptRaw(key, envelope.encrypt));
  if (packed.length < 20) throw Error('decrypt_failed');
  const length = packed.readUInt32BE(16);
  const start = 20;
  const end = start + length;
  if (!Number.isSafeInteger(length) || length < 1 || end > packed.length) throw Error('decrypt_failed');
  const receiveId = packed.subarray(end).toString('utf8');
  if (receiveId !== keys.receiveId) throw Error('decrypt_failed');
  return packed.subarray(start, end).toString('utf8');
}
