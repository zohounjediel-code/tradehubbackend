// routes/customers.js
// -----------------------------------------------------------------------
// Comptes client (acheteurs). Contrairement aux comptes boutique,
// l'inscription est libre et publique : n'importe qui peut créer un
// compte client pour acheter sur TradeHub.
// -----------------------------------------------------------------------

const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { pool } = require('../database');
const { requireCustomerAuth, signCustomerToken } = require('../middleware/auth');
const { sendCustomerWelcomeEmail } = require('../utils/email');

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
router.post('/register', async (req, res) => {
  const { firstName, lastName, phone, email, password } = req.body;

  if (!firstName || !lastName || !email || !password) {
    return res.status(400).json({ error: 'Prénom, nom, email et mot de passe sont requis.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });
  }

  const existing = await pool.query('SELECT id FROM customers WHERE email = $1', [email.toLowerCase()]);
  if (existing.rows[0]) {
    return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const { rows } = await pool.query(
    `INSERT INTO customers (first_name, last_name, phone, email, password_hash)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [firstName.trim(), lastName.trim(), (phone || '').trim() || null, email.toLowerCase(), passwordHash]
  );

  const customer = rows[0];
  const token = signCustomerToken(customer);
  const payload = toCustomerPayload(customer);

  sendCustomerWelcomeEmail(payload); // en tâche de fond, ne bloque pas la réponse

  res.status(201).json({ token, customer: payload });
});

// -----------------------------------------------------------------------
// CONNEXION
// -----------------------------------------------------------------------
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis.' });
  }

  const { rows } = await pool.query('SELECT * FROM customers WHERE email = $1', [email.toLowerCase()]);
  const customer = rows[0];
  if (!customer || !bcrypt.compareSync(password, customer.password_hash)) {
    return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
  }

  const token = signCustomerToken(customer);
  res.json({ token, customer: toCustomerPayload(customer) });
});

// -----------------------------------------------------------------------
// PROFIL DU CLIENT CONNECTÉ
// -----------------------------------------------------------------------
router.get('/me', requireCustomerAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM customers WHERE id = $1', [req.customer.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Compte introuvable.' });
  res.json(toCustomerPayload(rows[0]));
});

// Modifier prénom / nom / téléphone (l'email n'est pas modifiable ici,
// c'est l'identifiant de connexion)
router.put('/me', requireCustomerAuth, async (req, res) => {
  const { firstName, lastName, phone } = req.body;
  if (!firstName || !firstName.trim() || !lastName || !lastName.trim()) {
    return res.status(400).json({ error: 'Prénom et nom sont requis.' });
  }

  await pool.query(
    'UPDATE customers SET first_name = $1, last_name = $2, phone = $3 WHERE id = $4',
    [firstName.trim(), lastName.trim(), (phone || '').trim() || null, req.customer.id]
  );

  const { rows } = await pool.query('SELECT * FROM customers WHERE id = $1', [req.customer.id]);
  const updated = rows[0];
  const token = signCustomerToken(updated);

  res.json({ token, customer: toCustomerPayload(updated) });
});

// Modifier le mot de passe (demande l'ancien, par sécurité)
router.put('/me/password', requireCustomerAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Mot de passe actuel et nouveau mot de passe requis.' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 6 caractères.' });
  }

  const { rows } = await pool.query('SELECT * FROM customers WHERE id = $1', [req.customer.id]);
  const customer = rows[0];
  if (!customer || !bcrypt.compareSync(currentPassword, customer.password_hash)) {
    return res.status(400).json({ error: 'Ancien mot de passe incorrect !' });
  }
  if (bcrypt.compareSync(newPassword, customer.password_hash)) {
    return res.status(400).json({ error: "Le nouveau mot de passe doit être différent de l'ancien." });
  }

  const newHash = bcrypt.hashSync(newPassword, 10);
  await pool.query('UPDATE customers SET password_hash = $1 WHERE id = $2', [newHash, customer.id]);

  res.json({ success: true });
});

module.exports = router;
