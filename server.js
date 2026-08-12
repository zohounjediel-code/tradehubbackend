// server.js
// -----------------------------------------------------------------------
// Point d'entrée du serveur backend TradeHub.
// Lance une API REST (Express) -- pure API JSON, le frontend est déployé
// séparément (Vercel) et appelle cette API en URL absolue.
// -----------------------------------------------------------------------

const express = require('express');
const cors = require('cors');

const { initDatabase } = require('./database');
const catalogRoutes = require('./routes/catalog');
const orderRoutes = require('./routes/orders');
const shopRoutes = require('./routes/shops');
const adminRoutes = require('./routes/admin');
const customerRoutes = require('./routes/customers');
const cartRoutes = require('./routes/cart');
const contactRoutes = require('./routes/contact');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middlewares ---
app.use(cors());              // autorise les requêtes depuis le frontend
app.use(express.json());      // permet de lire du JSON dans req.body

// --- Health check (utile pour Railway et pour vérifier que l'API tourne) ---
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'tradehub-backend' });
});

// --- Routes API ---
app.use('/api', catalogRoutes);
app.use('/api', orderRoutes);
app.use('/api/shops', shopRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/contact', contactRoutes);

// --- Route non trouvée ---
app.use((req, res) => {
  res.status(404).json({ error: 'Route introuvable.' });
});

// --- Gestion des erreurs d'upload (fichier trop lourd, mauvais format...) ---
// Doit être déclaré en dernier : Express le repère automatiquement grâce
// à sa signature à 4 arguments (err, req, res, next).
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'Fichier trop lourd.' });
  }
  if (err) {
    return res.status(400).json({ error: err.message || 'Erreur lors du traitement du fichier.' });
  }
  next();
});

// On attend la fin de l'initialisation de la base (création des tables +
// seed, qui peut faire des appels réseau vers Unsplash) AVANT de démarrer
// le serveur, pour être sûr que les données sont prêtes dès la première
// requête.
(async () => {
  await initDatabase();
  app.listen(PORT, () => {
    console.log(`\n🚀 TradeHub API démarrée : http://localhost:${PORT}\n`);
  });
})();
