// routes/customers.js
// -----------------------------------------------------------------------
// Comptes client (acheteurs). Contrairement aux comptes boutique,
// l'inscription est libre et publique : n'importe qui peut créer un
// compte client pour acheter sur TradeHub.
// -----------------------------------------------------------------------

const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { db } = require('../database');
const { requireCustomerAuth, signCustomerToken } = require('../middleware/auth');

function toCustomerPayload(customer) {
  return {
    id: customer.id,
    firstName: customer.first_name,
    lastName: customer.last_name,
    name: `${customer.first_name} ${customer.last_name}`.trim(),
    phone: customer.phone || '',
    email: customer.email,
  };
}

// -----------------------------------------------------------------------
// INSCRIPTION
// -----------------------------------------------------------------------
router.post('/register', (req, res) => {
  const { firstName, lastName, phone, email, password } = req.body;

  if (!firstName || !lastName || !email || !password) {
    return res.status(400).json({ error: 'Prénom, nom, email et mot de passe sont requis.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });
  }

  const existing = db.prepare('SELECT id FROM customers WHERE email = ?').get(email.toLowerCase());
  if (existing) {
    return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const info = db.prepare(`
    INSERT INTO customers (first_name, last_name, phone, email, password_hash)
    VALUES (?, ?, ?, ?, ?)
  `).run(firstName.trim(), lastName.trim(), (phone || '').trim() || null, email.toLowerCase(), passwordHash);

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid);
  const token = signCustomerToken(customer);

  res.status(201).json({ token, customer: toCustomerPayload(customer) });
});

// -----------------------------------------------------------------------
// CONNEXION
// -----------------------------------------------------------------------
router.post('/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis.' });
  }

  const customer = db.prepare('SELECT * FROM customers WHERE email = ?').get(email.toLowerCase());
  if (!customer || !bcrypt.compareSync(password, customer.password_hash)) {
    return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
  }

  const token = signCustomerToken(customer);
  res.json({ token, customer: toCustomerPayload(customer) });
});

// -----------------------------------------------------------------------
// PROFIL DU CLIENT CONNECTÉ
// -----------------------------------------------------------------------
router.get('/me', requireCustomerAuth, (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.customer.id);
  if (!customer) return res.status(404).json({ error: 'Compte introuvable.' });
  res.json(toCustomerPayload(customer));
});

// Modifier prénom / nom / téléphone (l'email n'est pas modifiable ici,
// c'est l'identifiant de connexion)
router.put('/me', requireCustomerAuth, (req, res) => {
  const { firstName, lastName, phone } = req.body;
  if (!firstName || !firstName.trim() || !lastName || !lastName.trim()) {
    return res.status(400).json({ error: 'Prénom et nom sont requis.' });
  }

  db.prepare('UPDATE customers SET first_name = ?, last_name = ?, phone = ? WHERE id = ?')
    .run(firstName.trim(), lastName.trim(), (phone || '').trim() || null, req.customer.id);

  const updated = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.customer.id);
  const token = signCustomerToken(updated);

  res.json({ token, customer: toCustomerPayload(updated) });
});

// Modifier le mot de passe (demande l'ancien, par sécurité)
router.put('/me/password', requireCustomerAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Mot de passe actuel et nouveau mot de passe requis.' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 6 caractères.' });
  }

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.customer.id);
  if (!customer || !bcrypt.compareSync(currentPassword, customer.password_hash)) {
    return res.status(400).json({ error: 'Ancien mot de passe incorrect !' });
  }
  if (bcrypt.compareSync(newPassword, customer.password_hash)) {
    return res.status(400).json({ error: "Le nouveau mot de passe doit être différent de l'ancien." });
  }

  const newHash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE customers SET password_hash = ? WHERE id = ?').run(newHash, customer.id);

  res.json({ success: true });
});

module.exports = router;
