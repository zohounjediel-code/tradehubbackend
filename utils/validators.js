// utils/validators.js
// -----------------------------------------------------------------------
// Validation du format des coordonnées bancaires (IBAN / BIC).
// -----------------------------------------------------------------------

// Vérifie la structure ET la clé de contrôle d'un IBAN (algorithme mod 97,
// la norme officielle ISO 13616).
function isValidIBAN(rawIban) {
  const iban = rawIban.replace(/\s+/g, '').toUpperCase();

  // Structure générale : 2 lettres (pays) + 2 chiffres (clé) + 11 à 30 caractères
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;

  // Algorithme officiel :
  //  1. déplace les 4 premiers caractères à la fin
  //  2. convertit chaque lettre en nombre (A=10, B=11, ..., Z=35)
  //  3. le nombre obtenu doit être congru à 1 modulo 97
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (ch) => (ch.charCodeAt(0) - 55).toString());

  let remainder = numeric;
  while (remainder.length > 2) {
    const block = remainder.slice(0, 9);
    remainder = (parseInt(block, 10) % 97).toString() + remainder.slice(block.length);
  }
  return parseInt(remainder, 10) % 97 === 1;
}

// Vérifie le format d'un BIC/SWIFT (il n'y a pas de clé de contrôle pour le BIC,
// contrairement à l'IBAN, donc on ne peut vérifier que la structure).
function isValidBIC(rawBic) {
  const bic = rawBic.replace(/\s+/g, '').toUpperCase();
  return /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic);
}

module.exports = { isValidIBAN, isValidBIC };
