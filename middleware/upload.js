// middleware/upload.js
// -----------------------------------------------------------------------
// Gère l'upload des images de produits avec Multer.
//
// Les fichiers sont enregistrés directement dans frontend/images/products/
// -- un dossier déjà servi tel quel par Express (voir express.static dans
// server.js) -- donc l'image devient accessible immédiatement via son URL,
// sans route ni configuration supplémentaire.
// -----------------------------------------------------------------------

const multer = require('multer');
const path = require('path');
const fs = require('fs');

const uploadDir = path.join(__dirname, '..', '..', 'frontend', 'images', 'products');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    // Nom de fichier unique pour éviter tout écrasement entre boutiques
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, uniqueName);
  },
});

function fileFilter(req, file, cb) {
  if (file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error('Seules les images sont acceptées (jpg, png, webp, gif...).'));
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 Mo max
});

// Supprime un fichier précédemment uploadé (remplacement ou suppression d'un produit).
// Ne touche jamais aux images de démonstration (picsum.photos), seulement
// aux fichiers réellement uploadés par une boutique.
function deleteUploadedImage(imageUrl) {
  if (!imageUrl || !imageUrl.startsWith('/images/products/')) return;
  const filePath = path.join(uploadDir, path.basename(imageUrl));
  fs.unlink(filePath, (err) => {
    if (err && err.code !== 'ENOENT') {
      console.warn("Impossible de supprimer l'ancienne image :", err.message);
    }
  });
}

module.exports = { upload, deleteUploadedImage };

// -----------------------------------------------------------------------
// Preuves de paiement (captures d'écran de virement, reçus PDF...)
// -----------------------------------------------------------------------
// Contrairement aux images produit, ces fichiers sont PRIVÉS : stockés
// HORS de frontend/ (donc jamais servis publiquement par express.static),
// et accessibles uniquement via une route protégée (voir routes/orders.js)
// qui vérifie que la personne qui les demande est bien la boutique
// concernée ou un admin.
const paymentProofDir = path.join(__dirname, '..', 'uploads', 'payment-proofs');
fs.mkdirSync(paymentProofDir, { recursive: true });

const paymentProofStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, paymentProofDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, uniqueName);
  },
});

function paymentProofFileFilter(req, file, cb) {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Seuls les images (jpg, png, webp) et les PDF sont acceptés.'));
  }
}

const uploadPaymentProof = multer({
  storage: paymentProofStorage,
  fileFilter: paymentProofFileFilter,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 Mo max (un reçu PDF peut être plus lourd qu'une photo)
});

module.exports.uploadPaymentProof = uploadPaymentProof;
module.exports.paymentProofDir = paymentProofDir;
