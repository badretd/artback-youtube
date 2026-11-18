const IDENTITY_PREFIX = 'artback.identity.';
const GROUP_KEY_PREFIX = 'artback.groupkey.';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bytesToBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < arr.length; index += chunk) {
    binary += String.fromCharCode(...arr.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

function publicJwk(jwk) {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

export function samePublicKey(a, b) {
  return Boolean(a && b && a.kty === b.kty && a.crv === b.crv && a.x === b.x && a.y === b.y);
}

export function getStoredIdentity(userId) {
  try {
    const raw = localStorage.getItem(`${IDENTITY_PREFIX}${userId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.privateKey?.d || !parsed?.publicKey?.x) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function storeIdentity(userId, identity) {
  localStorage.setItem(`${IDENTITY_PREFIX}${userId}`, JSON.stringify(identity));
}

export function clearIdentity(userId) {
  localStorage.removeItem(`${IDENTITY_PREFIX}${userId}`);
}

export function getStoredGroupKey(userId) {
  try {
    const raw = localStorage.getItem(`${GROUP_KEY_PREFIX}${userId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.key) return null;
    return { key: base64ToBytes(parsed.key), epoch: parsed.epoch || 1 };
  } catch {
    return null;
  }
}

export function storeGroupKey(userId, keyBytes, epoch = 1) {
  localStorage.setItem(
    `${GROUP_KEY_PREFIX}${userId}`,
    JSON.stringify({ key: bytesToBase64(keyBytes), epoch }),
  );
}

export function clearGroupKey(userId) {
  localStorage.removeItem(`${GROUP_KEY_PREFIX}${userId}`);
}

export async function generateIdentity() {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const publicKey = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const privateKey = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  return {
    publicKey: publicJwk(publicKey),
    privateKey,
    createdAt: new Date().toISOString(),
  };
}

async function deriveWrapKey(privateKeyJwk, publicKeyJwk) {
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    privateKeyJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    publicKeyJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: publicKey },
    privateKey,
    256,
  );
  const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('artback-keywrap-salt-v1'),
      info: encoder.encode('artback-group-key-v1'),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function wrapGroupKey(groupKeyBytes, recipientPublicKeyJwk) {
  const ephemeral = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const ephemeralPublicKey = publicJwk(
    await crypto.subtle.exportKey('jwk', ephemeral.publicKey),
  );
  const ephemeralPrivateKey = await crypto.subtle.exportKey('jwk', ephemeral.privateKey);
  const wrapKey = await deriveWrapKey(ephemeralPrivateKey, recipientPublicKeyJwk);
  const iv = randomBytes(12);
  const wrapped = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    wrapKey,
    groupKeyBytes,
  );
  return {
    ephemeralPublicKey,
    iv: bytesToBase64(iv),
    wrappedKey: bytesToBase64(wrapped),
  };
}

export async function unwrapGroupKey(wrapped, privateKeyJwk) {
  const wrapKey = await deriveWrapKey(privateKeyJwk, wrapped.ephemeralPublicKey);
  const iv = base64ToBytes(wrapped.iv);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    wrapKey,
    base64ToBytes(wrapped.wrappedKey),
  );
  return new Uint8Array(plaintext);
}

export function generateGroupKey() {
  return randomBytes(32);
}

async function importGroupKey(rawKey, usage) {
  return crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

export async function encryptMessage(payload, rawKey) {
  const key = await importGroupKey(rawKey, 'encrypt');
  const iv = randomBytes(12);
  const plaintext = encoder.encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return {
    ciphertext: bytesToBase64(ciphertext),
    iv: bytesToBase64(iv),
  };
}

export async function decryptMessage(ciphertext, iv, rawKey) {
  const key = await importGroupKey(rawKey, 'decrypt');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(iv) },
    key,
    base64ToBytes(ciphertext),
  );
  return JSON.parse(decoder.decode(plaintext));
}

export async function encryptFile(bytes) {
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    bytes,
  );
  const rawKey = await crypto.subtle.exportKey('raw', key);
  return {
    ciphertext: new Uint8Array(ciphertext),
    key: bytesToBase64(rawKey),
    iv: bytesToBase64(iv),
  };
}

export async function decryptFile(ciphertext, keyB64, ivB64) {
  const key = await crypto.subtle.importKey(
    'raw',
    base64ToBytes(keyB64),
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(ivB64) },
    key,
    ciphertext,
  );
}

export function buildKeyBackup(userId, identity, groupKey) {
  return {
    app: 'artback',
    version: 1,
    userId,
    exportedAt: new Date().toISOString(),
    identity,
    groupKey: groupKey
      ? { key: bytesToBase64(groupKey.key), epoch: groupKey.epoch || 1 }
      : null,
  };
}

export function parseKeyBackup(text, expectedUserId) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Файл не является корректным JSON');
  }
  if (data?.app !== 'artback' || !data?.identity?.privateKey?.d || !data?.identity?.publicKey?.x) {
    throw new Error('Это не файл резервной копии ARTBACK');
  }
  if (expectedUserId && data.userId !== expectedUserId) {
    throw new Error('Резервная копия принадлежит другому аккаунту');
  }
  return {
    identity: {
      publicKey: publicJwk(data.identity.publicKey),
      privateKey: data.identity.privateKey,
      createdAt: data.identity.createdAt || null,
    },
    groupKey: data.groupKey?.key
      ? { key: base64ToBytes(data.groupKey.key), epoch: data.groupKey.epoch || 1 }
      : null,
  };
}
