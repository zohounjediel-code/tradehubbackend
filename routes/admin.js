// routes/admin.js
// -----------------------------------------------------------------------
// Tout ce qui concerne l'espace administrateur :
//   - Connexion (PAS d'inscription : les admins sont créés manuellement,
//     voir le seed dans database.js)
//   - Création, consultation, modification et suppression des comptes
//     boutique
//
// Il n'y a volontairement AUCUNE route d'inscription admin ici : un compte
// admin ne doit jamais pouvoir être créé depuis le site public.
// -----------------------------------------------------------------------

const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { pool, withTransaction, backfillProductImages } = require('../database');
const { requireAdminAuth, signAdminToken } = require('../middleware/auth');
const { deleteImage } = require('../utils/cloudinary');
const { encrypt, decrypt } = require('../utils/crypto');
const { isValidIBAN, isValidBIC } = require('../utils/validators');

// -----------------------------------------------------------------------
// CONNEXION ADMIN
// -----------------------------------------------------------------------
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis.' });
  }

  const { rows } = await pool.query('SELECT * FROM admins WHERE email = $1', [email.toLowerCase()]);
  const admin = rows[0];
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
  }

  const token = signAdminToken(admin);
  res.json({
    token,
    admin: { id: admin.id, name: admin.name, email: admin.email },
  });
});

// Profil de l'admin connecté
router.get('/me', requireAdminAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name, email, created_at FROM admins WHERE id = $1',
    [req.admin.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Administrateur introuvable.' });
  res.json(rows[0]);
});

// -----------------------------------------------------------------------
// CATÉGORIES
// -----------------------------------------------------------------------

// Crée une nouvelle catégorie de produits (admin uniquement -- les
// catégories initiales viennent du seed, celle-ci permet d'en ajouter
// d'autres ensuite sans toucher à la base directement).
router.post('/categories', requireAdminAuth, async (req, res) => {
  const { name, slug, icon } = req.body;

  if (!name || !name.trim() || !slug || !slug.trim()) {
    return res.status(400).json({ error: 'Nom et slug sont requis.' });
  }

  const normalizedSlug = slug.trim().toLowerCase();
  const existing = await pool.query('SELECT id FROM categories WHERE slug = $1', [normalizedSlug]);
  if (existing.rows[0]) {
    return res.status(409).json({ error: 'Une catégorie avec ce slug existe déjà.' });
  }

  const { rows } = await pool.query(
    'INSERT INTO categories (name, slug, icon) VALUES ($1, $2, $3) RETURNING *',
    [name.trim(), normalizedSlug, icon || null]
  );
  res.status(201).json(rows[0]);
});

// -----------------------------------------------------------------------
// GESTION DES COMPTES BOUTIQUE
// -----------------------------------------------------------------------

// Liste de toutes les boutiques, avec leur nombre de produits
router.get('/shops', requireAdminAuth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT s.id, s.shop_name, s.email, s.country, s.verified, s.created_at,
           COUNT(p.id) AS product_count
    FROM shops s
    LEFT JOIN products p ON p.shop_id = s.id
    GROUP BY s.id
    ORDER BY s.created_at DESC
  `);
  res.json(rows);
});

// Détail complet d'une boutique (toutes ses infos + ses produits) --
// c'est la route utilisée par le bouton "Voir" et par le formulaire "Modifier".
router.get('/shops/:id', requireAdminAuth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT id, shop_name, email, country, verified, bank_account_holder,
           iban_encrypted, bic_encrypted, created_at
    FROM shops WHERE id = $1
  `, [req.params.id]);
  const shop = rows[0];

  if (!shop) return res.status(404).json({ error: 'Boutique introuvable.' });

  const products = await pool.query(
    'SELECT id, name, price, image_url FROM products WHERE shop_id = $1',
    [shop.id]
  );

  res.json({
    id: shop.id,
    shopName: shop.shop_name,
    email: shop.email,
    country: shop.country || '',
    verified: !!shop.verified,
    createdAt: shop.created_at,
    bankAccountHolder: shop.bank_account_holder || '',
    // Déchiffrés uniquement ici, pour un admin authentifié
    iban: decrypt(shop.iban_encrypted) || '',
    bic: decrypt(shop.bic_encrypted) || '',
    products: products.rows,
  });
});

// Créer un nouveau compte boutique (l'admin onboarde un fournisseur)
router.post('/shops', requireAdminAuth, async (req, res) => {
  const { shopName, email, password, country, verified } = req.body;

  if (!shopName || !email || !password) {
    return res.status(400).json({ error: 'Nom de boutique, email et mot de passe sont requis.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });
  }

  const existing = await pool.query('SELECT id FROM shops WHERE email = $1', [email.toLowerCase()]);
  if (existing.rows[0]) {
    return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const { rows } = await pool.query(
    `INSERT INTO shops (shop_name, email, password_hash, country, verified)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, shop_name, email, country, verified, created_at`,
    [shopName, email.toLowerCase(), passwordHash, country || null, !!verified]
  );

  res.status(201).json(rows[0]);
});

// Modifier une boutique : TOUTES ses informations (identité, statut,
// coordonnées bancaires, mot de passe optionnel)
router.put('/shops/:id', requireAdminAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM shops WHERE id = $1', [req.params.id]);
  const shop = rows[0];
  if (!shop) return res.status(404).json({ error: 'Boutique introuvable.' });

  const { shopName, email, country, verified, newPassword, bankAccountHolder, iban, bic } = req.body;

  if (!shopName || !shopName.trim()) {
    return res.status(400).json({ error: 'Le nom de la boutique est requis.' });
  }

  // --- Email : optionnel à modifier, mais doit rester unique si changé ---
  let normalizedEmail = shop.email;
  if (email && email.trim()) {
    normalizedEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ error: "L'email n'est pas valide." });
    }
    if (normalizedEmail !== shop.email) {
      const emailTaken = await pool.query(
        'SELECT id FROM shops WHERE email = $1 AND id != $2',
        [normalizedEmail, shop.id]
      );
      if (emailTaken.rows[0]) {
        return res.status(409).json({ error: 'Un autre compte utilise déjà cet email.' });
      }
    }
  }

  // --- Mot de passe : optionnel (= réinitialisation) ---
  let passwordHash = shop.password_hash;
  if (newPassword) {
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 6 caractères.' });
    }
    passwordHash = bcrypt.hashSync(newPassword, 10);
  }

  // --- Coordonnées bancaires : on ne touche à ces champs QUE s'ils sont
  // explicitement présents dans la requête (ex. la bascule rapide "vérifiée"
  // depuis la liste n'envoie pas ces champs du tout -> on ne veut surtout
  // pas effacer un RIB déjà enregistré dans ce cas). Même règle de
  // validation/chiffrement que sur la page "Mes informations" de la boutique.
  let ibanEncrypted = shop.iban_encrypted;
  let bicEncrypted = shop.bic_encrypted;
  let bankHolder = shop.bank_account_holder;

  if (iban !== undefined) {
    const cleanedIban = iban.replace(/\s+/g, '').toUpperCase();
    if (cleanedIban) {
      if (!isValidIBAN(cleanedIban)) {
        return res.status(400).json({ error: "L'IBAN saisi n'est pas valide." });
      }
      ibanEncrypted = encrypt(cleanedIban);
    } else {
      ibanEncrypted = null; // champ explicitement vidé dans le formulaire
    }
  }
  if (bic !== undefined) {
    const cleanedBic = bic.replace(/\s+/g, '').toUpperCase();
    if (cleanedBic) {
      if (!isValidBIC(cleanedBic)) {
        return res.status(400).json({ error: "Le BIC/SWIFT saisi n'est pas valide." });
      }
      bicEncrypted = encrypt(cleanedBic);
    } else {
      bicEncrypted = null;
    }
  }
  if (bankAccountHolder !== undefined) {
    bankHolder = bankAccountHolder ? bankAccountHolder.trim() : null;
  }

  await pool.query(
    `UPDATE shops SET
      shop_name = $1,
      email = $2,
      country = $3,
      verified = $4,
      password_hash = $5,
      bank_account_holder = $6,
      iban_encrypted = $7,
      bic_encrypted = $8
    WHERE id = $9`,
    [
      shopName.trim(), normalizedEmail, country ? country.trim() : null, !!verified,
      passwordHash, bankHolder, ibanEncrypted, bicEncrypted, shop.id,
    ]
  );

  const updated = await pool.query(
    'SELECT id, shop_name, email, country, verified, created_at FROM shops WHERE id = $1',
    [shop.id]
  );
  res.json(updated.rows[0]);
});

// Supprimer une boutique ET tous ses produits (+ leurs images Cloudinary)
router.delete('/shops/:id', requireAdminAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM shops WHERE id = $1', [req.params.id]);
  const shop = rows[0];
  if (!shop) return res.status(404).json({ error: 'Boutique introuvable.' });

  const products = await withTransaction(async (client) => {
    const { rows: products } = await client.query(
      'SELECT id, image_public_id FROM products WHERE shop_id = $1',
      [shop.id]
    );
    await client.query('DELETE FROM products WHERE shop_id = $1', [shop.id]);
    await client.query('DELETE FROM shops WHERE id = $1', [shop.id]);
    return products;
  });

  for (const product of products) {
    await deleteImage(product.image_public_id);
  }

  res.json({ success: true });
});

// -----------------------------------------------------------------------
// COMMANDES (toutes boutiques confondues)
// -----------------------------------------------------------------------

// Liste de TOUTES les commandes, avec leurs articles -- vue d'ensemble
// admin, notamment pour suivre les paiements signalés par les clients.
router.get('/orders', requireAdminAuth, async (req, res) => {
  const { rows: orders } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
  const { rows: items } = await pool.query('SELECT * FROM order_items');

  const ordersWithItems = orders.map((order) => ({
    ...order,
    items: items.filter((it) => it.order_id === order.id),
  }));

  res.json(ordersWithItems);
});

// POST /api/admin/backfill-product-images -> va chercher une photo Unsplash
// pour tous les produits de démo qui n'en ont pas encore (ex. seed lancé
// avant qu'UNSPLASH_ACCESS_KEY ne soit configurée). Sans effet sur les
// produits déjà pourvus d'une image (upload manuel ou déjà backfillés).
router.post('/backfill-product-images', requireAdminAuth, async (req, res) => {
  const result = await backfillProductImages();
  res.json(result);
});

// POST /api/admin/backfill-orders-count -> donne un compteur "commandes"
// de départ (nombre aléatoire entre 50 et 200) aux produits qui affichent
// encore 0 -- purement cosmétique, pour ne pas afficher un produit tout
// neuf comme n'ayant jamais été commandé. Les vraies commandes, elles,
// font déjà progresser ce compteur normalement (voir routes/orders.js).
router.post('/backfill-orders-count', requireAdminAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT id FROM products WHERE orders_count = 0');
  for (const row of rows) {
    const randomCount = Math.floor(Math.random() * 151) + 50; // 50-200 inclus
    await pool.query('UPDATE products SET orders_count = $1 WHERE id = $2', [randomCount, row.id]);
  }
  res.json({ updated: rows.length });
});

module.exports = router;
