// middleware/upload.js
// -----------------------------------------------------------------------
// Gère l'upload de fichiers avec Multer, en mémoire (pas sur disque) :
// les buffers sont ensuite envoyés vers Cloudinary depuis les routes
// (voir utils/cloudinary.js). Le disque d'un service Railway est
// éphémère, donc écrire sur disque ne survivrait pas à un redéploiement.
// -----------------------------------------------------------------------

const multer = require('multer');

function imageFileFilter(req, file, cb) {
  if (file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error('Seules les images sont acceptées (jpg, png, webp, gif...).'));
  }
}

// Images de produit (upload par une boutique)
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: imageFileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 Mo max
});

// -----------------------------------------------------------------------
// Preuves de paiement (captures d'écran de virement, reçus PDF...)
// -----------------------------------------------------------------------
function paymentProofFileFilter(req, file, cb) {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Seuls les images (jpg, png, webp) et les PDF sont acceptés.'));
  }
}

const uploadPaymentProof = multer({
  storage: multer.memoryStorage(),
  fileFilter: paymentProofFileFilter,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 Mo max (un reçu PDF peut être plus lourd qu'une photo)
});

module.exports = { upload, uploadPaymentProof };
