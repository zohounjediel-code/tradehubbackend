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
const { db } = require('../database');
const { requireAdminAuth } = require('../middleware/auth');

// POST /api/contact -> envoyer un message (public, pas besoin de compte)
router.post('/', (req, res) => {
  const { name, email, message } = req.body;

  if (!name || !name.trim() || !email || !email.trim() || !message || !message.trim()) {
    return res.status(400).json({ error: 'Nom, email et message sont requis.' });
  }

  db.prepare(`
    INSERT INTO contact_messages (name, email, message)
    VALUES (?, ?, ?)
  `).run(name.trim(), email.trim(), message.trim());

  res.status(201).json({ success: true });
});

// GET /api/contact -> liste des messages reçus (admin uniquement)
router.get('/', requireAdminAuth, (req, res) => {
  const messages = db.prepare('SELECT * FROM contact_messages ORDER BY created_at DESC').all();
  res.json(messages);
});

// PUT /api/contact/:id/read -> marquer un message comme lu (admin uniquement)
router.put('/:id/read', requireAdminAuth, (req, res) => {
  db.prepare('UPDATE contact_messages SET is_read = 1 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
