// routes/catalog.js
// -----------------------------------------------------------------------
// Routes liées au catalogue : catégories et produits (lecture publique).
// Les infos "fournisseur" (nom, pays, vérifié) viennent maintenant de la
// table `shops` via une jointure, au lieu d'être stockées en dur sur
// chaque produit.
// -----------------------------------------------------------------------

const express = require('express');
const router = express.Router();
const { pool } = require('../database');

const PRODUCT_SELECT = `
  SELECT
    p.*,
    c.name AS category_name, c.slug AS category_slug,
    s.shop_name AS supplier_name, s.country AS supplier_country, s.verified AS supplier_verified
  FROM products p
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN shops s ON s.id = p.shop_id
`;

// GET /api/categories -> liste toutes les catégories
router.get('/categories', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM categories ORDER BY name');
  res.json(rows);
});

// GET /api/products -> liste les produits
// Paramètres optionnels : ?category=slug  &  ?search=terme
router.get('/products', async (req, res) => {
  const { category, search } = req.query;

  let query = `${PRODUCT_SELECT} WHERE 1=1`;
  const params = [];

  if (category) {
    params.push(category);
    query += ` AND c.slug = $${params.length}`;
  }
  if (search) {
    params.push(`%${search}%`);
    query += ` AND (p.name ILIKE $${params.length} OR p.description ILIKE $${params.length})`;
  }

  query += ' ORDER BY p.id DESC';

  const { rows } = await pool.query(query, params);
  res.json(rows);
});

// GET /api/products/:slug -> détail d'un produit
router.get('/products/:slug', async (req, res) => {
  const { rows } = await pool.query(`${PRODUCT_SELECT} WHERE p.slug = $1`, [req.params.slug]);
  const product = rows[0];

  if (!product) {
    return res.status(404).json({ error: 'Produit introuvable' });
  }

  // Produits similaires (même catégorie, hors produit courant)
  const related = await pool.query(
    'SELECT * FROM products WHERE category_id = $1 AND id != $2 LIMIT 4',
    [product.category_id, product.id]
  );

  res.json({ ...product, related: related.rows });
});

module.exports = router;
