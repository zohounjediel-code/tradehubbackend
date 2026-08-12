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
const { pool } = require('../database');
const { requireCustomerAuth } = require('../middleware/auth');

router.use(requireCustomerAuth);

// Renvoie le panier avec les infos produit à jour (nom, prix, image...),
// dans le même format que le panier "invité" côté frontend, pour que le
// reste du code (cart.html, checkout.html) n'ait pas à distinguer les deux.
router.get('/', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT ci.product_id AS "productId", ci.quantity,
           p.slug, p.name, p.price, p.moq, p.image_url AS image
    FROM cart_items ci
    JOIN products p ON p.id = ci.product_id
    WHERE ci.customer_id = $1
    ORDER BY ci.id DESC
  `, [req.customer.id]);
  res.json(rows);
});

// Ajoute un produit (ou incrémente la quantité s'il y est déjà)
router.post('/', async (req, res) => {
  const { productId, quantity } = req.body;
  if (!productId || !quantity || Number(quantity) < 1) {
    return res.status(400).json({ error: 'Produit et quantité requis.' });
  }

  const product = await pool.query('SELECT id FROM products WHERE id = $1', [productId]);
  if (!product.rows[0]) return res.status(404).json({ error: 'Produit introuvable.' });

  const existing = await pool.query(
    'SELECT * FROM cart_items WHERE customer_id = $1 AND product_id = $2',
    [req.customer.id, productId]
  );

  if (existing.rows[0]) {
    await pool.query(
      'UPDATE cart_items SET quantity = $1 WHERE id = $2',
      [existing.rows[0].quantity + Number(quantity), existing.rows[0].id]
    );
  } else {
    await pool.query(
      'INSERT INTO cart_items (customer_id, product_id, quantity) VALUES ($1, $2, $3)',
      [req.customer.id, productId, Number(quantity)]
    );
  }

  res.status(201).json({ success: true });
});

// Modifie la quantité d'un article déjà dans le panier
router.put('/:productId', async (req, res) => {
  const { quantity } = req.body;
  const product = await pool.query('SELECT moq FROM products WHERE id = $1', [req.params.productId]);
  if (!product.rows[0]) return res.status(404).json({ error: 'Produit introuvable.' });

  const qty = Math.max(product.rows[0].moq, Number(quantity) || product.rows[0].moq);
  const result = await pool.query(
    'UPDATE cart_items SET quantity = $1 WHERE customer_id = $2 AND product_id = $3',
    [qty, req.customer.id, req.params.productId]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ error: "Cet article n'est pas dans le panier." });
  }
  res.json({ success: true });
});

// Retire un article du panier
router.delete('/:productId', async (req, res) => {
  await pool.query(
    'DELETE FROM cart_items WHERE customer_id = $1 AND product_id = $2',
    [req.customer.id, req.params.productId]
  );
  res.json({ success: true });
});

// Vide entièrement le panier (utilisé après une commande validée)
router.delete('/', async (req, res) => {
  await pool.query('DELETE FROM cart_items WHERE customer_id = $1', [req.customer.id]);
  res.json({ success: true });
});

module.exports = router;
