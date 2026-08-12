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
const router = express.Router();
const { pool, withTransaction } = require('../database');
const { requireCustomerAuth, verifyAnyToken } = require('../middleware/auth');
const { uploadPaymentProof } = require('../middleware/upload');
const { uploadBuffer } = require('../utils/cloudinary');
const { decrypt } = require('../utils/crypto');

// POST /api/orders -> crée une nouvelle commande (client connecté requis)
// Corps attendu : { phone, address, items: [ { productId, name, price, quantity }, ... ] }
router.post('/orders', requireCustomerAuth, async (req, res) => {
  const { phone, address, items } = req.body;

  // --- Validation simple ---
  if (!address || !address.trim()) {
    return res.status(400).json({ error: "L'adresse de livraison est requise." });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Le panier est vide.' });
  }

  const total = items.reduce((sum, it) => sum + it.price * it.quantity, 0);

  try {
    const orderId = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO orders (customer_id, customer_name, customer_email, customer_phone, shipping_address, total)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [req.customer.id, req.customer.name, req.customer.email, phone || '', address.trim(), total]
      );
      const orderId = rows[0].id;

      for (const item of items) {
        await client.query(
          `INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price)
           VALUES ($1, $2, $3, $4, $5)`,
          [orderId, item.productId, item.name, item.quantity, item.price]
        );
      }
      return orderId;
    });

    res.status(201).json({ orderId, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur lors de l'enregistrement de la commande." });
  }
});

// GET /api/orders/mine -> historique des commandes du client connecté
router.get('/orders/mine', requireCustomerAuth, async (req, res) => {
  const { rows: orders } = await pool.query(
    'SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC',
    [req.customer.id]
  );

  const { rows: allItems } = await pool.query(
    'SELECT * FROM order_items WHERE order_id = ANY($1)',
    [orders.map((o) => o.id)]
  );

  const ordersWithItems = orders.map((order) => ({
    ...order,
    items: allItems.filter((it) => it.order_id === order.id),
  }));

  res.json(ordersWithItems);
});

// Récupère, pour une commande donnée, les boutiques concernées avec leur
// RIB déchiffré et le sous-total qui leur revient (une commande peut en
// théorie contenir des produits de plusieurs boutiques différentes).
async function getShopsForOrder(orderId) {
  const { rows } = await pool.query(`
    SELECT s.id AS "shopId", s.shop_name AS "shopName", s.bank_account_holder AS "bankAccountHolder",
           s.iban_encrypted, s.bic_encrypted,
           SUM(oi.unit_price * oi.quantity) AS subtotal
    FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    JOIN shops s ON s.id = p.shop_id
    WHERE oi.order_id = $1
    GROUP BY s.id
  `, [orderId]);

  return rows.map((s) => ({
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
router.get('/orders/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  const order = rows[0];
  if (!order) return res.status(404).json({ error: 'Commande introuvable' });

  const payload = verifyAnyToken(req);
  const isOwner = payload?.role === 'customer' && order.customer_id === payload.id;
  const isAdmin = payload?.role === 'admin';
  if (!isOwner && !isAdmin) {
    return res.status(403).json({ error: 'Connecte-toi avec le compte qui a passé cette commande pour la consulter.' });
  }

  const items = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
  const shops = await getShopsForOrder(order.id);

  res.json({ ...order, items: items.rows, shops });
});

// POST /api/orders/:id/payment-proof -> le client signale "j'ai payé" et
// joint une preuve (capture d'écran, reçu PDF...). Ne confirme PAS que
// l'argent est bien arrivé -- juste un signalement, à vérifier ensuite
// manuellement par la boutique/l'admin depuis leur tableau de bord.
router.post('/orders/:id/payment-proof', requireCustomerAuth, uploadPaymentProof.single('proof'), async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  const order = rows[0];
  if (!order) return res.status(404).json({ error: 'Commande introuvable.' });
  if (order.customer_id !== req.customer.id) {
    return res.status(403).json({ error: "Cette commande ne t'appartient pas." });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Merci de joindre une preuve de paiement (capture ou reçu).' });
  }

  const { url } = await uploadBuffer(req.file.buffer, req.file.mimetype, 'tradehub/payment-proofs');

  await pool.query(
    `UPDATE orders SET
      payment_status = 'reported',
      payment_proof_url = $1,
      payment_reported_at = CURRENT_TIMESTAMP
    WHERE id = $2`,
    [url, order.id]
  );

  res.json({ success: true });
});

// GET /api/orders/:id/payment-proof -> redirige vers le fichier de preuve
// (hébergé sur Cloudinary). Accès réservé à un admin, ou à une boutique
// ayant au moins un produit dans cette commande -- jamais public.
router.get('/orders/:id/payment-proof', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  const order = rows[0];
  if (!order || !order.payment_proof_url) {
    return res.status(404).json({ error: 'Aucune preuve de paiement pour cette commande.' });
  }

  const payload = verifyAnyToken(req);
  const isAdmin = payload?.role === 'admin';

  let isConcernedShop = false;
  if (payload?.role === 'shop') {
    const match = await pool.query(`
      SELECT 1 FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1 AND p.shop_id = $2
      LIMIT 1
    `, [order.id, payload.id]);
    isConcernedShop = !!match.rows[0];
  }

  if (!isAdmin && !isConcernedShop) {
    return res.status(403).json({ error: 'Accès non autorisé.' });
  }

  res.redirect(order.payment_proof_url);
});

module.exports = router;
