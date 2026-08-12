// routes/orders.js
// -----------------------------------------------------------------------
// Routes liées aux commandes (checkout) ET au paiement par virement :
//   - Créer une commande (client connecté requis)
//   - Consulter le détail d'une commande (client propriétaire OU admin),
//     avec le RIB de la/des boutique(s) concernée(s) pour pouvoir payer
//   - Envoyer une preuve de paiement (le client signale "j'ai payé")
//   - Télécharger cette preuve (boutique concernée OU admin uniquement --
//     jamais public, c'est une pièce jointe potentiellement sensible)
// -----------------------------------------------------------------------

const express = require('express');
const path = require('path');
const router = express.Router();
const { db } = require('../database');
const { requireCustomerAuth, verifyAnyToken } = require('../middleware/auth');
const { uploadPaymentProof, paymentProofDir } = require('../middleware/upload');
const { decrypt } = require('../utils/crypto');

// POST /api/orders -> crée une nouvelle commande (client connecté requis)
// Corps attendu : { phone, address, items: [ { productId, name, price, quantity }, ... ] }
router.post('/orders', requireCustomerAuth, (req, res) => {
  const { phone, address, items } = req.body;

  // --- Validation simple ---
  if (!address || !address.trim()) {
    return res.status(400).json({ error: "L'adresse de livraison est requise." });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Le panier est vide.' });
  }

  const total = items.reduce((sum, it) => sum + it.price * it.quantity, 0);

  // --- Insertion dans la base, en une seule transaction ---
  const insertOrder = db.prepare(`
    INSERT INTO orders (customer_id, customer_name, customer_email, customer_phone, shipping_address, total)
    VALUES (@customer_id, @name, @email, @phone, @address, @total)
  `);
  const insertItem = db.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price)
    VALUES (@order_id, @product_id, @product_name, @quantity, @unit_price)
  `);

  const createOrder = db.transaction(() => {
    const info = insertOrder.run({
      customer_id: req.customer.id,
      name: req.customer.name,
      email: req.customer.email,
      phone: phone || '',
      address: address.trim(),
      total,
    });
    const orderId = info.lastInsertRowid;

    for (const item of items) {
      insertItem.run({
        order_id: orderId,
        product_id: item.productId,
        product_name: item.name,
        quantity: item.quantity,
        unit_price: item.price,
      });
    }
    return orderId;
  });

  try {
    const orderId = createOrder();
    res.status(201).json({ orderId, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur lors de l'enregistrement de la commande." });
  }
});

// GET /api/orders/mine -> historique des commandes du client connecté
router.get('/orders/mine', requireCustomerAuth, (req, res) => {
  const orders = db.prepare(`
    SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC
  `).all(req.customer.id);

  const itemsByOrder = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
  const ordersWithItems = orders.map((order) => ({
    ...order,
    items: itemsByOrder.all(order.id),
  }));

  res.json(ordersWithItems);
});

// Récupère, pour une commande donnée, les boutiques concernées avec leur
// RIB déchiffré et le sous-total qui leur revient (une commande peut en
// théorie contenir des produits de plusieurs boutiques différentes).
function getShopsForOrder(orderId) {
  return db.prepare(`
    SELECT s.id AS shopId, s.shop_name AS shopName, s.bank_account_holder AS bankAccountHolder,
           s.iban_encrypted, s.bic_encrypted,
           SUM(oi.unit_price * oi.quantity) AS subtotal
    FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    JOIN shops s ON s.id = p.shop_id
    WHERE oi.order_id = ?
    GROUP BY s.id
  `).all(orderId).map((s) => ({
    shopId: s.shopId,
    shopName: s.shopName,
    bankAccountHolder: s.bankAccountHolder || '',
    iban: decrypt(s.iban_encrypted) || '',
    bic: decrypt(s.bic_encrypted) || '',
    subtotal: s.subtotal,
  }));
}

// GET /api/orders/:id -> détail d'une commande (page de paiement/confirmation)
// Accessible uniquement au client propriétaire de la commande, ou à un
// admin -- pas public, car ça expose le RIB de la boutique.
// Placée APRÈS /orders/mine : sinon Express prendrait "mine" pour un :id.
router.get('/orders/:id', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Commande introuvable' });

  const payload = verifyAnyToken(req);
  const isOwner = payload?.role === 'customer' && order.customer_id === payload.id;
  const isAdmin = payload?.role === 'admin';
  if (!isOwner && !isAdmin) {
    return res.status(403).json({ error: 'Connecte-toi avec le compte qui a passé cette commande pour la consulter.' });
  }

  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
  const shops = getShopsForOrder(order.id);

  res.json({ ...order, items, shops });
});

// POST /api/orders/:id/payment-proof -> le client signale "j'ai payé" et
// joint une preuve (capture d'écran, reçu PDF...). Ne confirme PAS que
// l'argent est bien arrivé -- juste un signalement, à vérifier ensuite
// manuellement par la boutique/l'admin depuis leur tableau de bord.
router.post('/orders/:id/payment-proof', requireCustomerAuth, uploadPaymentProof.single('proof'), (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Commande introuvable.' });
  if (order.customer_id !== req.customer.id) {
    return res.status(403).json({ error: "Cette commande ne t'appartient pas." });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Merci de joindre une preuve de paiement (capture ou reçu).' });
  }

  db.prepare(`
    UPDATE orders SET
      payment_status = 'reported',
      payment_proof_filename = ?,
      payment_reported_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(req.file.filename, order.id);

  res.json({ success: true });
});

// GET /api/orders/:id/payment-proof -> télécharge le fichier de preuve.
// Accès réservé à un admin, ou à une boutique ayant au moins un produit
// dans cette commande -- jamais public.
router.get('/orders/:id/payment-proof', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order || !order.payment_proof_filename) {
    return res.status(404).json({ error: 'Aucune preuve de paiement pour cette commande.' });
  }

  const payload = verifyAnyToken(req);
  const isAdmin = payload?.role === 'admin';

  let isConcernedShop = false;
  if (payload?.role === 'shop') {
    const match = db.prepare(`
      SELECT 1 FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ? AND p.shop_id = ?
      LIMIT 1
    `).get(order.id, payload.id);
    isConcernedShop = !!match;
  }

  if (!isAdmin && !isConcernedShop) {
    return res.status(403).json({ error: 'Accès non autorisé.' });
  }

  const filePath = path.join(paymentProofDir, order.payment_proof_filename);
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: 'Fichier introuvable.' });
    }
  });
});

module.exports = router;
