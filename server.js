// server.js
// -----------------------------------------------------------------------
// Point d'entrée du serveur backend TradeHub.
// Lance une API REST (Express) + sert les fichiers du frontend.
// -----------------------------------------------------------------------

const express = require('express');
const cors = require('cors');
const path = require('path');

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

// --- Routes API ---
app.use('/api', catalogRoutes);
app.use('/api', orderRoutes);
app.use('/api/shops', shopRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/contact', contactRoutes);

// --- Sert les fichiers statiques du frontend ---
const frontendPath = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendPath));

// Toute route non-API renvoie index.html (simple, pas de routeur front ici)
app.get('*', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// --- Gestion des erreurs d'upload (fichier trop lourd, mauvais format...) ---
// Doit être déclaré en dernier : Express le repère automatiquement grâce
// à sa signature à 4 arguments (err, req, res, next).
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'Image trop lourde (5 Mo maximum).' });
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
    console.log(`\n🚀 TradeHub démarré : http://localhost:${PORT}\n`);
  });
})();
