import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function parseKey(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  const decoded = /^[0-9a-f]{64}$/i.test(trimmed) ? Buffer.from(trimmed, 'hex') : Buffer.from(trimmed, 'base64');
  return decoded.length === 32 ? decoded : null;
}

function associatedData(metadata) {
  const bounded = {
    workspaceId: metadata.workspaceId,
    personId: metadata.personId,
    voiceProfileId: metadata.voiceProfileId,
    provider: metadata.provider,
    model: metadata.model,
    modelVersion: metadata.modelVersion,
    templateVersion: metadata.templateVersion,
  };
  return Buffer.from(JSON.stringify(bounded), 'utf8');
}

export function encodeTemplate(template) {
  const vector = Float32Array.from(template ?? []);
  if (!vector.length || vector.length > 4096) throw new Error('Voice template dimensions are invalid.');
  const bytes = Buffer.allocUnsafe(4 + vector.length * 4);
  bytes.writeUInt32LE(vector.length, 0);
  for (let i = 0; i < vector.length; i += 1) bytes.writeFloatLE(vector[i], 4 + i * 4);
  return bytes;
}

export function decodeTemplate(bytes) {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 8) throw new Error('Encrypted voice template payload is truncated.');
  const dimensions = buffer.readUInt32LE(0);
  if (!dimensions || dimensions > 4096 || buffer.length !== 4 + dimensions * 4) throw new Error('Encrypted voice template payload has invalid dimensions.');
  const vector = new Float32Array(dimensions);
  for (let i = 0; i < dimensions; i += 1) vector[i] = buffer.readFloatLE(4 + i * 4);
  return vector;
}

export function createTemplateCipher({ key = process.env.BIOMETRIC_ENCRYPTION_KEY, keyVersion = Number(process.env.BIOMETRIC_ENCRYPTION_KEY_VERSION ?? 1), keyring = {} } = {}) {
  const activeKey = parseKey(key);
  const parsedKeyring = new Map(Object.entries(keyring).map(([version, entry]) => [Number(version), parseKey(entry)]).filter(([, entry]) => entry));
  if (activeKey) parsedKeyring.set(Number(keyVersion), activeKey);

  function assertConfigured() {
    if (!activeKey) throw new Error('BIOMETRIC_ENCRYPTION_KEY must be a server-only 32-byte base64 or 64-character hex key.');
  }

  function encrypt(template, metadata) {
    assertConfigured();
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', activeKey, nonce);
    const aad = associatedData(metadata);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(encodeTemplate(template)), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      algorithm: 'aes-256-gcm',
      keyVersion: Number(keyVersion),
      nonce: nonce.toString('base64'),
      authTag: authTag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  function decrypt(record, metadata) {
    const selectedKey = parsedKeyring.get(Number(record.keyVersion));
    if (!selectedKey) throw new Error(`No biometric encryption key is available for key version ${record.keyVersion}.`);
    if (record.algorithm !== 'aes-256-gcm') throw new Error('Unsupported biometric template encryption algorithm.');
    const decipher = createDecipheriv('aes-256-gcm', selectedKey, Buffer.from(record.nonce, 'base64'));
    decipher.setAAD(associatedData(metadata));
    decipher.setAuthTag(Buffer.from(record.authTag, 'base64'));
    return decodeTemplate(Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]));
  }

  function rotate(record, metadata) {
    assertConfigured();
    const plaintext = decrypt(record, metadata);
    try { return encrypt(plaintext, metadata); }
    finally { plaintext.fill(0); }
  }

  return {
    configured: Boolean(activeKey),
    keyVersion: Number(keyVersion),
    encrypt,
    decrypt,
    rotate,
    status: () => ({ configured: Boolean(activeKey), algorithm: 'aes-256-gcm', keyVersion: Number(keyVersion), knownKeyVersions: [...parsedKeyring.keys()].sort((a, b) => a - b) }),
  };
}

export { associatedData, parseKey };
