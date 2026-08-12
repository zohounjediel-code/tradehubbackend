// routes/contact.js
// -----------------------------------------------------------------------
// Formulaire de contact. Comme ce projet n'a pas de service d'envoi
// d'email configuré (ça demanderait un compte chez un prestataire comme
// Resend/SendGrid), les messages sont stockés en base pour de vrai --
// ce n'est pas un formulaire qui fait semblant d'envoyer quelque chose.
// Un admin peut les consulter depuis admin-messages.html.
// -----------------------------------------------------------------------

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { requireAdminAuth } = require('../middleware/auth');

// POST /api/contact -> envoyer un message (public, pas besoin de compte)
router.post('/', async (req, res) => {
  const { name, email, message } = req.body;

  if (!name || !name.trim() || !email || !email.trim() || !message || !message.trim()) {
    return res.status(400).json({ error: 'Nom, email et message sont requis.' });
  }

  await pool.query(
    'INSERT INTO contact_messages (name, email, message) VALUES ($1, $2, $3)',
    [name.trim(), email.trim(), message.trim()]
  );

  res.status(201).json({ success: true });
});

// GET /api/contact -> liste des messages reçus (admin uniquement)
router.get('/', requireAdminAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM contact_messages ORDER BY created_at DESC');
  res.json(rows);
});

// PUT /api/contact/:id/read -> marquer un message comme lu (admin uniquement)
router.put('/:id/read', requireAdminAuth, async (req, res) => {
  await pool.query('UPDATE contact_messages SET is_read = TRUE WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

module.exports = router;
