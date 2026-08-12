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
const { db } = require('../database');
const { requireAdminAuth, signAdminToken } = require('../middleware/auth');
const { deleteUploadedImage } = require('../middleware/upload');
const { encrypt, decrypt } = require('../utils/crypto');
const { isValidIBAN, isValidBIC } = require('../utils/validators');

// -----------------------------------------------------------------------
// CONNEXION ADMIN
// -----------------------------------------------------------------------
router.post('/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis.' });
  }

  const admin = db.prepare('SELECT * FROM admins WHERE email = ?').get(email.toLowerCase());
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
router.get('/me', requireAdminAuth, (req, res) => {
  const admin = db.prepare('SELECT id, name, email, created_at FROM admins WHERE id = ?').get(req.admin.id);
  if (!admin) return res.status(404).json({ error: 'Administrateur introuvable.' });
  res.json(admin);
});

// -----------------------------------------------------------------------
// GESTION DES COMPTES BOUTIQUE
// -----------------------------------------------------------------------

// Liste de toutes les boutiques, avec leur nombre de produits
router.get('/shops', requireAdminAuth, (req, res) => {
  const shops = db.prepare(`
    SELECT s.id, s.shop_name, s.email, s.country, s.verified, s.created_at,
           COUNT(p.id) AS product_count
    FROM shops s
    LEFT JOIN products p ON p.shop_id = s.id
    GROUP BY s.id
    ORDER BY s.created_at DESC
  `).all();
  res.json(shops);
});

// Détail complet d'une boutique (toutes ses infos + ses produits) --
// c'est la route utilisée par le bouton "Voir" et par le formulaire "Modifier".
router.get('/shops/:id', requireAdminAuth, (req, res) => {
  const shop = db.prepare(`
    SELECT id, shop_name, email, country, verified, bank_account_holder,
           iban_encrypted, bic_encrypted, created_at
    FROM shops WHERE id = ?
  `).get(req.params.id);

  if (!shop) return res.status(404).json({ error: 'Boutique introuvable.' });

  const products = db.prepare('SELECT id, name, price, image_url FROM products WHERE shop_id = ?').all(shop.id);

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
    products,
  });
});

// Créer un nouveau compte boutique (l'admin onboarde un fournisseur)
router.post('/shops', requireAdminAuth, (req, res) => {
  const { shopName, email, password, country, verified } = req.body;

  if (!shopName || !email || !password) {
    return res.status(400).json({ error: 'Nom de boutique, email et mot de passe sont requis.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });
  }

  const existing = db.prepare('SELECT id FROM shops WHERE email = ?').get(email.toLowerCase());
  if (existing) {
    return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const info = db.prepare(`
    INSERT INTO shops (shop_name, email, password_hash, country, verified)
    VALUES (?, ?, ?, ?, ?)
  `).run(shopName, email.toLowerCase(), passwordHash, country || null, verified ? 1 : 0);

  const shop = db.prepare('SELECT id, shop_name, email, country, verified, created_at FROM shops WHERE id = ?')
    .get(info.lastInsertRowid);
  res.status(201).json(shop);
});

// Modifier une boutique : TOUTES ses informations (identité, statut,
// coordonnées bancaires, mot de passe optionnel)
router.put('/shops/:id', requireAdminAuth, (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(req.params.id);
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
      const emailTaken = db.prepare('SELECT id FROM shops WHERE email = ? AND id != ?').get(normalizedEmail, shop.id);
      if (emailTaken) {
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

  db.prepare(`
    UPDATE shops SET
      shop_name = @shop_name,
      email = @email,
      country = @country,
      verified = @verified,
      password_hash = @password_hash,
      bank_account_holder = @bank_account_holder,
      iban_encrypted = @iban_encrypted,
      bic_encrypted = @bic_encrypted
    WHERE id = @id
  `).run({
    id: shop.id,
    shop_name: shopName.trim(),
    email: normalizedEmail,
    country: country ? country.trim() : null,
    verified: verified ? 1 : 0,
    password_hash: passwordHash,
    bank_account_holder: bankHolder,
    iban_encrypted: ibanEncrypted,
    bic_encrypted: bicEncrypted,
  });

  const updated = db.prepare('SELECT id, shop_name, email, country, verified, created_at FROM shops WHERE id = ?')
    .get(shop.id);
  res.json(updated);
});

// Supprimer une boutique ET tous ses produits (+ leurs images uploadées)
router.delete('/shops/:id', requireAdminAuth, (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(req.params.id);
  if (!shop) return res.status(404).json({ error: 'Boutique introuvable.' });

  const deleteShopAndProducts = db.transaction(() => {
    const products = db.prepare('SELECT id, image_url FROM products WHERE shop_id = ?').all(shop.id);

    for (const product of products) {
      deleteUploadedImage(product.image_url);
    }
    db.prepare('DELETE FROM products WHERE shop_id = ?').run(shop.id);
    db.prepare('DELETE FROM shops WHERE id = ?').run(shop.id);
  });

  deleteShopAndProducts();
  res.json({ success: true });
});

// -----------------------------------------------------------------------
// COMMANDES (toutes boutiques confondues)
// -----------------------------------------------------------------------

// Liste de TOUTES les commandes, avec leurs articles -- vue d'ensemble
// admin, notamment pour suivre les paiements signalés par les clients.
router.get('/orders', requireAdminAuth, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  const itemsStmt = db.prepare('SELECT * FROM order_items WHERE order_id = ?');

  const ordersWithItems = orders.map((order) => ({
    ...order,
    items: itemsStmt.all(order.id),
  }));

  res.json(ordersWithItems);
});

module.exports = router;
