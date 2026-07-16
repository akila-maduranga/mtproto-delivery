const crypto = require("crypto");

/**
 * Unwrap the per-image AES-256 data key using the server's RSA private key.
 * RSA-4096 + OAEP + SHA-256 — the server private key only ever lives in
 * this process's environment, never on disk.
 */
function unwrapKey(wrappedKeyBuffer) {
  const privateKeyPem = process.env.RSA_PRIVATE_KEY;
  if (!privateKeyPem) throw new Error("RSA_PRIVATE_KEY is not set");

  return crypto.privateDecrypt(
    {
      key: privateKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    wrappedKeyBuffer
  );
}

/**
 * Decrypt AES-256-GCM ciphertext.  SubtleCrypto appends the 16-byte auth
 * tag to the end of the ciphertext — we split it back off here.
 */
function decryptAesGcm(ciphertextWithTag, ivBuffer, keyBuffer) {
  const TAG_LENGTH = 16;
  const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - TAG_LENGTH);
  const authTag = ciphertextWithTag.subarray(ciphertextWithTag.length - TAG_LENGTH);

  const decipher = crypto.createDecipheriv("aes-256-gcm", keyBuffer, ivBuffer);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Unwrap the per-image key, decrypt, then zero the key from memory.
 */
function unwrapAndDecrypt({ ciphertext, iv, wrappedKey }) {
  const dek = unwrapKey(wrappedKey);
  try {
    return decryptAesGcm(ciphertext, iv, dek);
  } finally {
    dek.fill(0);
  }
}

module.exports = { unwrapKey, decryptAesGcm, unwrapAndDecrypt };