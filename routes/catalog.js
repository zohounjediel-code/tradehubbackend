// routes/catalog.js
// -----------------------------------------------------------------------
// Routes liées au catalogue : catégories et produits (lecture publique).
// Les infos "fournisseur" (nom, pays, vérifié) viennent maintenant de la
// table `shops` via une jointure, au lieu d'être stockées en dur sur
// chaque produit.
// -----------------------------------------------------------------------

const express = require('express');
const router = express.Router();
const { db } = require('../database');

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
router.get('/categories', (req, res) => {
  const categories = db.prepare('SELECT * FROM categories ORDER BY name').all();
  res.json(categories);
});

// GET /api/products -> liste les produits
// Paramètres optionnels : ?category=slug  &  ?search=terme
router.get('/products', (req, res) => {
  const { category, search } = req.query;

  let query = `${PRODUCT_SELECT} WHERE 1=1`;
  const params = {};

  if (category) {
    query += ' AND c.slug = @category';
    params.category = category;
  }
  if (search) {
    query += ' AND (p.name LIKE @search OR p.description LIKE @search)';
    params.search = `%${search}%`;
  }

  query += ' ORDER BY p.id DESC';

  const products = db.prepare(query).all(params);
  res.json(products);
});

// GET /api/products/:slug -> détail d'un produit
router.get('/products/:slug', (req, res) => {
  const product = db.prepare(`${PRODUCT_SELECT} WHERE p.slug = ?`).get(req.params.slug);

  if (!product) {
    return res.status(404).json({ error: 'Produit introuvable' });
  }

  // Produits similaires (même catégorie, hors produit courant)
  const related = db.prepare(`
    SELECT * FROM products
    WHERE category_id = ? AND id != ?
    LIMIT 4
  `).all(product.category_id, product.id);

  res.json({ ...product, related });
});

module.exports = router;
