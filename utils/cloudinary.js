// utils/cloudinary.js
// -----------------------------------------------------------------------
// Stockage des fichiers uploadés (images produit, preuves de paiement) sur
// Cloudinary plutôt que sur le disque local : le disque d'un service
// Railway est éphémère (perdu à chaque redéploiement/redémarrage), et une
// fois le frontend séparé sur Vercel, le backend n'a de toute façon plus
// accès au dossier frontend/images/products.
// -----------------------------------------------------------------------

const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Upload un buffer (issu de multer memoryStorage) via une data URI --
// simple et évite une dépendance supplémentaire pour gérer des streams.
async function uploadBuffer(buffer, mimetype, folder) {
  const dataUri = `data:${mimetype};base64,${buffer.toString('base64')}`;
  const result = await cloudinary.uploader.upload(dataUri, {
    folder,
    resource_type: 'auto', // gère aussi bien les images que les PDF (preuves de paiement)
  });
  return { url: result.secure_url, publicId: result.public_id };
}

async function deleteImage(publicId) {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: 'auto' });
  } catch (err) {
    console.warn('Impossible de supprimer le fichier sur Cloudinary :', err.message);
  }
}

module.exports = { uploadBuffer, deleteImage };
