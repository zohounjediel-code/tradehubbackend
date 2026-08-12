// utils/crypto.js
// -----------------------------------------------------------------------
// Chiffrement symétrique (AES-256-GCM) pour les données sensibles comme
// l'IBAN/BIC d'une boutique.
//
// Pourquoi chiffrer et pas hasher (comme les mots de passe) ?
// Un mot de passe n'a jamais besoin d'être relu en clair (on compare juste
// des hashs) -> hash à sens unique. Un IBAN, lui, doit pouvoir être
// réaffiché à la boutique dans son espace "Mes informations" -> il faut
// un chiffrement RÉVERSIBLE (avec la bonne clé), pas un hash.
// -----------------------------------------------------------------------

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';

// ⚠️ En production, cette clé DOIT venir d'une variable d'environnement
// (process.env.ENCRYPTION_KEY) et ne jamais être écrite en dur dans le
// code ni commitée sur git. Si tu changes cette clé, les données déjà
// chiffrées avec l'ancienne deviennent illisibles.
const SECRET = process.env.ENCRYPTION_KEY || 'tradehub_dev_encryption_key_change_in_production';
const KEY = crypto.createHash('sha256').update(SECRET).digest(); // toujours 32 octets, requis par AES-256

function encrypt(plainText) {
  if (!plainText) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // On stocke iv + authTag + données chiffrées ensemble, encodés en base64
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function decrypt(payload) {
  if (!payload) return null;
  try {
    const data = Buffer.from(payload, 'base64');
    const iv = data.subarray(0, 12);
    const authTag = data.subarray(12, 28);
    const encrypted = data.subarray(28);
    const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    return null; // donnée corrompue ou clé de chiffrement différente
  }
}

module.exports = { encrypt, decrypt };
