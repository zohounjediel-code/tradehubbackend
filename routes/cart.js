// routes/cart.js
// -----------------------------------------------------------------------
// Panier lié à un compte client, stocké en base (table cart_items).
// Toutes les routes ici nécessitent un client connecté (voir
// `router.use(requireCustomerAuth)` ci-dessous) : ça correspond au panier
// "compte", qui persiste entre deux connexions -- à ne pas confondre avec
// le panier "invité" du navigateur, géré uniquement en localStorage côté
// frontend (voir js/cart.js) quand personne n'est connecté.
// -----------------------------------------------------------------------

const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requireCustomerAuth } = require('../middleware/auth');

router.use(requireCustomerAuth);

// Renvoie le panier avec les infos produit à jour (nom, prix, image...),
// dans le même format que le panier "invité" côté frontend, pour que le
// reste du code (cart.html, checkout.html) n'ait pas à distinguer les deux.
router.get('/', (req, res) => {
  const items = db.prepare(`
    SELECT ci.product_id AS productId, ci.quantity,
           p.slug, p.name, p.price, p.moq, p.image_url AS image
    FROM cart_items ci
    JOIN products p ON p.id = ci.product_id
    WHERE ci.customer_id = ?
    ORDER BY ci.id DESC
  `).all(req.customer.id);
  res.json(items);
});

// Ajoute un produit (ou incrémente la quantité s'il y est déjà)
router.post('/', (req, res) => {
  const { productId, quantity } = req.body;
  if (!productId || !quantity || Number(quantity) < 1) {
    return res.status(400).json({ error: 'Produit et quantité requis.' });
  }

  const product = db.prepare('SELECT id FROM products WHERE id = ?').get(productId);
  if (!product) return res.status(404).json({ error: 'Produit introuvable.' });

  const existing = db.prepare('SELECT * FROM cart_items WHERE customer_id = ? AND product_id = ?')
    .get(req.customer.id, productId);

  if (existing) {
    db.prepare('UPDATE cart_items SET quantity = ? WHERE id = ?')
      .run(existing.quantity + Number(quantity), existing.id);
  } else {
    db.prepare('INSERT INTO cart_items (customer_id, product_id, quantity) VALUES (?, ?, ?)')
      .run(req.customer.id, productId, Number(quantity));
  }

  res.status(201).json({ success: true });
});

// Modifie la quantité d'un article déjà dans le panier
router.put('/:productId', (req, res) => {
  const { quantity } = req.body;
  const product = db.prepare('SELECT moq FROM products WHERE id = ?').get(req.params.productId);
  if (!product) return res.status(404).json({ error: 'Produit introuvable.' });

  const qty = Math.max(product.moq, Number(quantity) || product.moq);
  const info = db.prepare('UPDATE cart_items SET quantity = ? WHERE customer_id = ? AND product_id = ?')
    .run(qty, req.customer.id, req.params.productId);

  if (info.changes === 0) {
    return res.status(404).json({ error: "Cet article n'est pas dans le panier." });
  }
  res.json({ success: true });
});

// Retire un article du panier
router.delete('/:productId', (req, res) => {
  db.prepare('DELETE FROM cart_items WHERE customer_id = ? AND product_id = ?')
    .run(req.customer.id, req.params.productId);
  res.json({ success: true });
});

// Vide entièrement le panier (utilisé après une commande validée)
router.delete('/', (req, res) => {
  db.prepare('DELETE FROM cart_items WHERE customer_id = ?').run(req.customer.id);
  res.json({ success: true });
});

module.exports = router;
