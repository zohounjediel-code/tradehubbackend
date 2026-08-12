// middleware/auth.js
// -----------------------------------------------------------------------
// Vérifie qu'une requête vient bien d'une boutique OU d'un admin connecté.
//
// Comment ça marche :
//   1. Au login, le serveur génère un "token" (jeton) signé avec un secret,
//      qui contient un `role` ('shop' ou 'admin') en plus de l'identité.
//   2. Le frontend garde ce token (dans localStorage) et le renvoie dans
//      l'en-tête `Authorization: Bearer <token>` à chaque requête protégée.
//   3. Les middlewares ci-dessous vérifient le token ET le rôle attendu,
//      pour qu'un token boutique ne puisse jamais servir sur une route
//      admin (et inversement).
// -----------------------------------------------------------------------

const jwt = require('jsonwebtoken');

// ⚠️ En production, ce secret DOIT venir d'une variable d'environnement
// (process.env.JWT_SECRET), jamais écrit en clair dans le code.
const JWT_SECRET = process.env.JWT_SECRET || 'tradehub_dev_secret_change_in_production';
const TOKEN_EXPIRY = '7d';

function signShopToken(shop) {
  return jwt.sign(
    { role: 'shop', id: shop.id, shopName: shop.shop_name, email: shop.email },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

function signAdminToken(admin) {
  return jwt.sign(
    { role: 'admin', id: admin.id, name: admin.name, email: admin.email },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

function signCustomerToken(customer) {
  return jwt.sign(
    {
      role: 'customer',
      id: customer.id,
      // "name" (nom complet) reste dispo pour le code existant qui
      // l'utilise déjà (ex. orders.js, checkout.html).
      name: `${customer.first_name} ${customer.last_name}`.trim(),
      firstName: customer.first_name,
      lastName: customer.last_name,
      email: customer.email,
    },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

function verifyRole(req, res, expectedRole) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: 'Connexion requise.' });
    return null;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== expectedRole) {
      // Un token valide mais du mauvais rôle est traité comme une session
      // invalide (401), pas comme un simple refus (403) : ça permet au
      // frontend de déconnecter proprement et rediriger vers la connexion.
      res.status(401).json({ error: 'Session invalide pour cet espace.' });
      return null;
    }
    return payload;
  } catch {
    res.status(401).json({ error: 'Session invalide ou expirée, reconnecte-toi.' });
    return null;
  }
}

function requireShopAuth(req, res, next) {
  const payload = verifyRole(req, res, 'shop');
  if (!payload) return; // la réponse d'erreur a déjà été envoyée
  req.shop = payload;
  next();
}

function requireAdminAuth(req, res, next) {
  const payload = verifyRole(req, res, 'admin');
  if (!payload) return;
  req.admin = payload;
  next();
}

function requireCustomerAuth(req, res, next) {
  const payload = verifyRole(req, res, 'customer');
  if (!payload) return;
  req.customer = payload;
  next();
}

// Vérifie un token SANS imposer de rôle précis -- utile pour les rares
// routes accessibles à plusieurs rôles différents à la fois, où c'est le
// code de la route qui décide ensuite qui a le droit de voir quoi (ex. le
// détail d'une commande : accessible au client propriétaire OU à un admin).
// Renvoie le payload décodé, ou `null` si le token est absent/invalide.
function verifyAnyToken(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

module.exports = {
  requireShopAuth, requireAdminAuth, requireCustomerAuth,
  signShopToken, signAdminToken, signCustomerToken,
  verifyAnyToken,
};
