// routes/shops.js
// -----------------------------------------------------------------------
// Tout ce qui concerne les comptes boutique :
//   - Connexion (PAS d'inscription libre : voir routes/admin.js)
//   - Consultation du profil ("qui suis-je ?")
//   - Gestion (CRUD) des produits de SA propre boutique
// -----------------------------------------------------------------------

const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { pool } = require('../database');
const { requireShopAuth, signShopToken } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const { uploadBuffer, deleteImage } = require('../utils/cloudinary');
const { encrypt, decrypt } = require('../utils/crypto');
const { isValidIBAN, isValidBIC } = require('../utils/validators');
const { fetchUnsplashImage } = require('../utils/unsplashImage');

// Transforme "Mon Super Produit !" en "mon-super-produit-k3f9a2"
// (le suffixe aléatoire évite les collisions entre boutiques)
function slugify(text) {
  const base = text
    .toString()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // enlève les accents
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${base}-${suffix}`;
}

// -----------------------------------------------------------------------
// PAS DE ROUTE D'INSCRIPTION ICI.
// Les comptes boutique ne peuvent être créés que par un administrateur,
// depuis /api/admin/shops (voir routes/admin.js et admin-shop-form.html).
// Ce choix évite que n'importe qui puisse s'auto-déclarer "fournisseur"
// sans vérification.
// -----------------------------------------------------------------------

// -----------------------------------------------------------------------
// CONNEXION
// -----------------------------------------------------------------------
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis.' });
  }

  const { rows } = await pool.query('SELECT * FROM shops WHERE email = $1', [email.toLowerCase()]);
  const shop = rows[0];
  if (!shop || !bcrypt.compareSync(password, shop.password_hash)) {
    return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
  }

  const token = signShopToken(shop);
  res.json({
    token,
    shop: { id: shop.id, shopName: shop.shop_name, email: shop.email, verified: !!shop.verified },
  });
});

// -----------------------------------------------------------------------
// PROFIL DE LA BOUTIQUE CONNECTÉE
// -----------------------------------------------------------------------
router.get('/me', requireShopAuth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT id, shop_name, email, country, verified, bank_account_holder,
           iban_encrypted, bic_encrypted, created_at
    FROM shops WHERE id = $1
  `, [req.shop.id]);
  const shop = rows[0];

  if (!shop) return res.status(404).json({ error: 'Boutique introuvable.' });

  res.json({
    id: shop.id,
    shopName: shop.shop_name,
    email: shop.email,
    country: shop.country || '',
    verified: !!shop.verified,
    createdAt: shop.created_at,
    bankAccountHolder: shop.bank_account_holder || '',
    // Déchiffrés uniquement ici, pour la boutique propriétaire elle-même
    iban: decrypt(shop.iban_encrypted) || '',
    bic: decrypt(shop.bic_encrypted) || '',
  });
});

// Modifier le profil de la boutique connectée (infos générales + RIB)
router.put('/me', requireShopAuth, async (req, res) => {
  const { shopName, country, bankAccountHolder, iban, bic } = req.body;

  if (!shopName || !shopName.trim()) {
    return res.status(400).json({ error: 'Le nom de la boutique est requis.' });
  }

  const cleanedIban = (iban || '').replace(/\s+/g, '').toUpperCase();
  const cleanedBic = (bic || '').replace(/\s+/g, '').toUpperCase();

  // On ne valide/chiffre que si un champ a été renseigné. Un champ laissé
  // vide efface la valeur existante (comportement standard d'un formulaire
  // d'édition de profil).
  let ibanEncrypted = null;
  let bicEncrypted = null;

  if (cleanedIban) {
    if (!isValidIBAN(cleanedIban)) {
      return res.status(400).json({ error: "L'IBAN saisi n'est pas valide." });
    }
    ibanEncrypted = encrypt(cleanedIban);
  }
  if (cleanedBic) {
    if (!isValidBIC(cleanedBic)) {
      return res.status(400).json({ error: "Le BIC/SWIFT saisi n'est pas valide." });
    }
    bicEncrypted = encrypt(cleanedBic);
  }
  // Un RIB sans titulaire n'a pas beaucoup de sens niveau usage réel
  if (cleanedIban && !(bankAccountHolder || '').trim()) {
    return res.status(400).json({ error: 'Indique le titulaire du compte bancaire.' });
  }

  await pool.query(
    `UPDATE shops SET
      shop_name = $1,
      country = $2,
      bank_account_holder = $3,
      iban_encrypted = $4,
      bic_encrypted = $5
    WHERE id = $6`,
    [
      shopName.trim(), country ? country.trim() : null,
      bankAccountHolder ? bankAccountHolder.trim() : null,
      ibanEncrypted, bicEncrypted, req.shop.id,
    ]
  );

  const { rows } = await pool.query('SELECT * FROM shops WHERE id = $1', [req.shop.id]);
  const updatedShop = rows[0];

  // Le token contient le nom de la boutique : s'il vient de changer, on en
  // renvoie un nouveau pour que le frontend garde une session à jour.
  const token = signShopToken(updatedShop);

  res.json({
    token,
    shop: {
      id: updatedShop.id,
      shopName: updatedShop.shop_name,
      email: updatedShop.email,
      verified: !!updatedShop.verified,
    },
  });
});

// Modifier le mot de passe (demande l'ancien, par sécurité)
router.put('/me/password', requireShopAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Mot de passe actuel et nouveau mot de passe requis.' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 6 caractères.' });
  }

  const { rows } = await pool.query('SELECT * FROM shops WHERE id = $1', [req.shop.id]);
  const shop = rows[0];
  if (!shop || !bcrypt.compareSync(currentPassword, shop.password_hash)) {
    return res.status(400).json({ error: 'Ancien mot de passe incorrect !' });
  }
  if (bcrypt.compareSync(newPassword, shop.password_hash)) {
    return res.status(400).json({ error: "Le nouveau mot de passe doit être différent de l'ancien." });
  }

  const newHash = bcrypt.hashSync(newPassword, 10);
  await pool.query('UPDATE shops SET password_hash = $1 WHERE id = $2', [newHash, shop.id]);

  res.json({ success: true });
});

// -----------------------------------------------------------------------
// PRODUITS DE LA BOUTIQUE CONNECTÉE
// -----------------------------------------------------------------------

// Liste des produits de MA boutique
router.get('/me/products', requireShopAuth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT p.*, c.name AS category_name
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.shop_id = $1
    ORDER BY p.id DESC
  `, [req.shop.id]);
  res.json(rows);
});

// Ajouter un nouveau produit (avec upload d'image optionnel, champ "image")
router.post('/me/products', requireShopAuth, upload.single('image'), async (req, res) => {
  const { name, description, price, moq, categoryId } = req.body;

  if (!name || !price || !categoryId) {
    return res.status(400).json({ error: 'Nom, prix et catégorie sont requis.' });
  }
  if (Number(price) <= 0) {
    return res.status(400).json({ error: 'Le prix doit être supérieur à 0.' });
  }

  const slug = slugify(name);

  // Ordre de priorité pour l'image : fichier uploadé (-> Cloudinary) > photo
  // Unsplash trouvée avec le nom du produit comme mot-clé > rien du tout
  // (mieux vaut aucune image qu'un mockup qui ne ressemble pas à une vraie photo).
  let imageUrl = null;
  let imagePublicId = null;
  if (req.file) {
    const uploaded = await uploadBuffer(req.file.buffer, req.file.mimetype, 'tradehub/products');
    imageUrl = uploaded.url;
    imagePublicId = uploaded.publicId;
  } else {
    imageUrl = await fetchUnsplashImage(name);
  }

  const { rows } = await pool.query(
    `INSERT INTO products
       (name, slug, description, price, moq, image_url, image_public_id, category_id, shop_id, rating, orders_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 5, 0)
     RETURNING *`,
    [
      name, slug, description || '', Number(price), Number(moq) > 0 ? Number(moq) : 1,
      imageUrl, imagePublicId, Number(categoryId), req.shop.id,
    ]
  );

  res.status(201).json(rows[0]);
});

// Modifier un produit qui M'APPARTIENT (nouvelle image optionnelle)
router.put('/me/products/:id', requireShopAuth, upload.single('image'), async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
  const product = rows[0];
  if (!product) return res.status(404).json({ error: 'Produit introuvable.' });
  if (product.shop_id !== req.shop.id) {
    return res.status(403).json({ error: "Ce produit n'appartient pas à ta boutique." });
  }

  const { name, description, price, moq, categoryId } = req.body;

  // Si une nouvelle image est envoyée, elle remplace l'ancienne
  // (et l'ancien fichier est supprimé de Cloudinary pour ne pas s'accumuler).
  let imageUrl = product.image_url;
  let imagePublicId = product.image_public_id;
  if (req.file) {
    const uploaded = await uploadBuffer(req.file.buffer, req.file.mimetype, 'tradehub/products');
    await deleteImage(product.image_public_id);
    imageUrl = uploaded.url;
    imagePublicId = uploaded.publicId;
  }

  const { rows: updatedRows } = await pool.query(
    `UPDATE products SET
      name = $1,
      description = $2,
      price = $3,
      moq = $4,
      image_url = $5,
      image_public_id = $6,
      category_id = $7
    WHERE id = $8
    RETURNING *`,
    [
      name || product.name,
      description ?? product.description,
      Number(price) > 0 ? Number(price) : product.price,
      Number(moq) > 0 ? Number(moq) : product.moq,
      imageUrl,
      imagePublicId,
      Number(categoryId) || product.category_id,
      product.id,
    ]
  );

  res.json(updatedRows[0]);
});

// Supprimer un produit qui M'APPARTIENT
router.delete('/me/products/:id', requireShopAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
  const product = rows[0];
  if (!product) return res.status(404).json({ error: 'Produit introuvable.' });
  if (product.shop_id !== req.shop.id) {
    return res.status(403).json({ error: "Ce produit n'appartient pas à ta boutique." });
  }

  await pool.query('DELETE FROM products WHERE id = $1', [product.id]);
  await deleteImage(product.image_public_id);
  res.json({ success: true });
});

// -----------------------------------------------------------------------
// COMMANDES CONCERNANT MA BOUTIQUE
// -----------------------------------------------------------------------

// Liste des commandes contenant au moins un produit de MA boutique, avec
// le sous-total qui me revient sur chacune -- pour suivre les paiements
// signalés par les clients (virement bancaire).
router.get('/me/orders', requireShopAuth, async (req, res) => {
  const { rows: orders } = await pool.query(`
    SELECT DISTINCT o.*
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    JOIN products p ON p.id = oi.product_id
    WHERE p.shop_id = $1
    ORDER BY o.created_at DESC
  `, [req.shop.id]);

  const { rows: allItems } = await pool.query(`
    SELECT oi.* FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    WHERE p.shop_id = $1
  `, [req.shop.id]);

  const ordersWithItems = orders.map((order) => {
    const items = allItems.filter((it) => it.order_id === order.id);
    return {
      ...order,
      items,
      // Sous-total qui revient à MA boutique sur cette commande (elle
      // peut contenir des produits d'autres boutiques aussi)
      mySubtotal: items.reduce((sum, it) => sum + it.unit_price * it.quantity, 0),
    };
  });

  res.json(ordersWithItems);
});

module.exports = router;
