// database.js
// -----------------------------------------------------------------------
// Ce fichier gère TOUT ce qui touche à la base de données PostgreSQL :
//   1. La connexion (pool) via DATABASE_URL
//   2. La création des tables si elles n'existent pas encore
//   3. Le remplissage avec des données de démonstration (seed)
// -----------------------------------------------------------------------

require('dotenv').config();

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { fetchUnsplashImage, isUnsplashConfigured } = require('./utils/unsplashImage');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL manquant : copie .env.example en .env et renseigne-le (voir README).');
}

// Pas de SSL nécessaire contre une base locale ; requis contre Neon/Railway.
const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);
const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

// Exécute `fn(client)` dans une transaction : COMMIT si tout se passe bien,
// ROLLBACK si `fn` lève une erreur. Remplace `db.transaction()` (synchrone)
// de better-sqlite3, qui n'a pas d'équivalent direct en asynchrone avec `pg`.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------
// 1. CRÉATION DES TABLES
// ---------------------------------------------------------------------
async function createTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      icon TEXT
    );

    -- Comptes administrateur : peuvent créer/gérer les comptes boutique.
    -- Complètement séparés des comptes boutique (pas d'auto-inscription).
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    -- Comptes client (acheteurs) : inscription libre, contrairement aux
    -- comptes boutique qui sont créés uniquement par un admin.
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      phone TEXT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    -- Comptes boutique : créés uniquement par un administrateur (voir
    -- routes/admin.js). iban_encrypted / bic_encrypted sont chiffrés
    -- (voir utils/crypto.js), jamais en clair.
    CREATE TABLE IF NOT EXISTS shops (
      id SERIAL PRIMARY KEY,
      shop_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      country TEXT,
      verified BOOLEAN DEFAULT FALSE,
      bank_account_holder TEXT,
      iban_encrypted TEXT,
      bic_encrypted TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT,
      price DOUBLE PRECISION NOT NULL,
      moq INTEGER NOT NULL DEFAULT 1,
      image_url TEXT,
      image_public_id TEXT,
      category_id INTEGER REFERENCES categories(id),
      shop_id INTEGER NOT NULL REFERENCES shops(id),
      rating DOUBLE PRECISION DEFAULT 4.5,
      orders_count INTEGER DEFAULT 0
    );

    -- Panier lié à un compte client : persiste côté serveur.
    CREATE TABLE IF NOT EXISTS cart_items (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      quantity INTEGER NOT NULL,
      UNIQUE(customer_id, product_id)
    );

    -- Paiement par virement bancaire : payment_status vaut 'pending' par
    -- défaut, puis 'reported' une fois que le client a signalé avoir payé.
    -- payment_proof_url pointe vers le fichier hébergé sur Cloudinary.
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      customer_phone TEXT,
      shipping_address TEXT NOT NULL,
      total DOUBLE PRECISION NOT NULL,
      status TEXT DEFAULT 'en attente',
      payment_status TEXT DEFAULT 'pending',
      payment_proof_url TEXT,
      payment_reported_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price DOUBLE PRECISION NOT NULL
    );

    -- Messages du formulaire de contact.
    CREATE TABLE IF NOT EXISTS contact_messages (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      message TEXT NOT NULL,
      is_read BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

// ---------------------------------------------------------------------
// 2. DONNÉES DE DÉMONSTRATION
// ---------------------------------------------------------------------
const categories = [
  { name: 'Électronique',              slug: 'electronique',      icon: '🔌' },
  { name: 'Textile & Vêtements',       slug: 'textile',           icon: '🧵' },
  { name: 'Machines industrielles',    slug: 'machines',          icon: '⚙️' },
  { name: 'Maison & Jardin',           slug: 'maison-jardin',     icon: '🏡' },
  { name: 'Emballage & Impression',    slug: 'emballage',         icon: '📦' },
  { name: 'Beauté & Cosmétiques',      slug: 'beaute',            icon: '💄' },
];

// Compte administrateur de démonstration
const ADMIN_EMAIL = 'bestadmin1234@gmail.com';
const ADMIN_PASSWORD = 'Bigadmin1234';

// Une seule boutique de démo : "Legros", propriétaire de tous les
// produits ci-dessous.
const SHOP_NAME = 'Legros';
const SHOP_EMAIL = 'legrosdetail@gmail.com';
const SHOP_PASSWORD = '12345678';
const SHOP_COUNTRY = 'France';

const shops = [
  { shop_name: SHOP_NAME, email: SHOP_EMAIL, country: SHOP_COUNTRY, verified: true },
];

// Chaque produit référence sa boutique via l'email (plus lisible qu'un index).
// `imageQuery` est le mot-clé (en anglais, Unsplash indexe mieux ainsi)
// utilisé pour chercher une vraie photo correspondante.
const products = [
  // Électronique
  { name: 'Écouteurs sans fil Bluetooth 5.3', slug: 'ecouteurs-bt-53', description: "Écouteurs intra-auriculaires avec réduction de bruit active, autonomie 30h avec boîtier de charge.", price: 4.8, moq: 100, category: 'electronique', shopEmail: SHOP_EMAIL, rating: 4.6, orders: 12500, imageQuery: 'wireless earbuds' },
  { name: 'Chargeur rapide USB-C 65W',        slug: 'chargeur-usbc-65w', description: "Chargeur GaN compact, compatible charge rapide pour smartphones, tablettes et laptops.", price: 3.2, moq: 200, category: 'electronique', shopEmail: SHOP_EMAIL, rating: 4.7, orders: 8900, imageQuery: 'usb-c charger' },
  { name: 'Montre connectée sport IP68',       slug: 'montre-connectee-ip68', description: "Étanche, suivi du rythme cardiaque et du sommeil, autonomie 7 jours.", price: 9.5, moq: 50, category: 'electronique', shopEmail: SHOP_EMAIL, rating: 4.3, orders: 3200, imageQuery: 'smartwatch fitness' },
  { name: 'Enceinte Bluetooth étanche',        slug: 'enceinte-bt-etanche', description: "Enceinte portable 20W, certification IPX7, autonomie 12h.", price: 6.9, moq: 150, category: 'electronique', shopEmail: SHOP_EMAIL, rating: 4.5, orders: 5400, imageQuery: 'portable bluetooth speaker' },

  // Textile
  { name: 'T-shirts coton bio uni (lot)',      slug: 'tshirt-coton-bio', description: "100% coton biologique, 180g/m², disponible en 8 coloris et toutes tailles.", price: 2.1, moq: 500, category: 'textile', shopEmail: SHOP_EMAIL, rating: 4.4, orders: 21000, imageQuery: 'folded cotton t-shirts' },
  { name: 'Sacs à dos toile résistante',       slug: 'sac-a-dos-toile', description: "Toile canvas renforcée, compartiment laptop 15 pouces, personnalisable avec logo.", price: 5.4, moq: 100, category: 'textile', shopEmail: SHOP_EMAIL, rating: 4.6, orders: 7600, imageQuery: 'canvas backpack' },
  { name: 'Écharpes en laine mérinos',         slug: 'echarpe-laine-merinos', description: "Laine mérinos douce et chaude, tissage traditionnel, plusieurs motifs disponibles.", price: 7.8, moq: 80, category: 'textile', shopEmail: SHOP_EMAIL, rating: 4.8, orders: 1900, imageQuery: 'wool scarf' },

  // Machines
  { name: 'Machine à coudre industrielle',     slug: 'machine-coudre-industrielle', description: "Point droit haute vitesse, moteur servo silencieux, idéale pour ateliers de confection.", price: 285, moq: 2, category: 'machines', shopEmail: SHOP_EMAIL, rating: 4.7, orders: 640, imageQuery: 'industrial sewing machine' },
  { name: 'Découpeuse laser CO2 60W',          slug: 'decoupeuse-laser-co2', description: "Découpe et gravure bois, acrylique et cuir, zone de travail 60x40cm.", price: 1250, moq: 1, category: 'machines', shopEmail: SHOP_EMAIL, rating: 4.5, orders: 210, imageQuery: 'laser cutting machine' },
  { name: 'Compresseur d\'air 50L',            slug: 'compresseur-air-50l', description: "Moteur 2HP, cuve 50 litres, idéal pour ateliers et petites industries.", price: 165, moq: 5, category: 'machines', shopEmail: SHOP_EMAIL, rating: 4.2, orders: 380, imageQuery: 'air compressor tool' },

  // Maison & Jardin
  { name: 'Set de casseroles inox (lot de 8)', slug: 'casseroles-inox-lot8', description: "Fond thermodiffuseur, compatible tous feux dont induction, manches ergonomiques.", price: 18.5, moq: 30, category: 'maison-jardin', shopEmail: SHOP_EMAIL, rating: 4.6, orders: 4300, imageQuery: 'stainless steel cookware set' },
  { name: 'Lampes solaires de jardin LED',     slug: 'lampes-solaires-jardin', description: "Étanches IP65, capteur crépusculaire automatique, lot de 20 unités.", price: 1.6, moq: 300, category: 'maison-jardin', shopEmail: SHOP_EMAIL, rating: 4.4, orders: 9800, imageQuery: 'solar pathway light outdoor' },
  { name: 'Tapis de salon tissé main',         slug: 'tapis-salon-tisse', description: "Motifs berbères traditionnels, laine et coton, plusieurs dimensions.", price: 32, moq: 20, category: 'maison-jardin', shopEmail: SHOP_EMAIL, rating: 4.9, orders: 890, imageQuery: 'handwoven area rug' },

  // Emballage
  { name: 'Boîtes carton kraft personnalisables', slug: 'boites-carton-kraft', description: "Carton ondulé recyclable, impression logo possible, plusieurs formats.", price: 0.35, moq: 1000, category: 'emballage', shopEmail: SHOP_EMAIL, rating: 4.5, orders: 15600, imageQuery: 'kraft cardboard boxes' },
  { name: 'Sachets zip refermables',           slug: 'sachets-zip', description: "Polyéthylène épais, transparents, fermeture zip, plusieurs tailles.", price: 0.04, moq: 5000, category: 'emballage', shopEmail: SHOP_EMAIL, rating: 4.3, orders: 22000, imageQuery: 'ziplock plastic bags' },

  // Beauté
  { name: 'Sérum vitamine C bio (OEM)',        slug: 'serum-vitamine-c', description: "Formule anti-oxydante, packaging personnalisable, certifié cosmétique bio.", price: 2.9, moq: 200, category: 'beaute', shopEmail: SHOP_EMAIL, rating: 4.7, orders: 6700, imageQuery: 'vitamin c serum bottle' },
  { name: 'Pinceaux maquillage professionnels (set)', slug: 'pinceaux-maquillage', description: "Set de 12 pinceaux, poils synthétiques doux, manche bois, trousse incluse.", price: 3.5, moq: 150, category: 'beaute', shopEmail: SHOP_EMAIL, rating: 4.4, orders: 4100, imageQuery: 'makeup brush set' },
];

// ---------------------------------------------------------------------
// 3. INSERTION DES DONNÉES (uniquement si la base est vide)
// ---------------------------------------------------------------------
async function seedIfEmpty() {
  const { rows } = await pool.query('SELECT COUNT(*) AS n FROM categories');
  if (Number(rows[0].n) > 0) {
    console.log('La base contient déjà des données (catégories/boutiques/produits), seed ignoré.');
    return;
  }

  console.log('Remplissage de la base avec les données de démonstration...');
  if (isUnsplashConfigured()) {
    console.log('  → clé Unsplash détectée : recherche de vraies photos pour chaque produit...');
  } else {
    console.log('  → pas de clé Unsplash configurée : les produits sans photo resteront sans image (voir .env.example).');
  }

  await withTransaction(async (client) => {
    // --- Catégories ---
    const categoryIdBySlug = {};
    for (const c of categories) {
      const { rows } = await client.query(
        'INSERT INTO categories (name, slug, icon) VALUES ($1, $2, $3) RETURNING id',
        [c.name, c.slug, c.icon]
      );
      categoryIdBySlug[c.slug] = rows[0].id;
    }

    // --- Boutiques (avec mot de passe hashé) ---
    const passwordHash = bcrypt.hashSync(SHOP_PASSWORD, 10);
    const shopIdByEmail = {};
    for (const s of shops) {
      const { rows } = await client.query(
        `INSERT INTO shops (shop_name, email, password_hash, country, verified)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [s.shop_name, s.email, passwordHash, s.country, s.verified]
      );
      shopIdByEmail[s.email] = rows[0].id;
    }

    // --- Produits ---
    // On récupère d'abord TOUTES les images via Unsplash, une par une, AVANT
    // d'insérer -- les appels réseau sont asynchrones. Si aucune photo n'est
    // trouvée pour un produit, image_url reste vide.
    for (const p of products) {
      const imageUrl = await fetchUnsplashImage(p.imageQuery);
      await client.query(
        `INSERT INTO products
           (name, slug, description, price, moq, image_url, category_id, shop_id, rating, orders_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          p.name, p.slug, p.description, p.price, p.moq,
          imageUrl || null, categoryIdBySlug[p.category], shopIdByEmail[p.shopEmail],
          p.rating, p.orders,
        ]
      );
    }
  });

  console.log(`✔ ${categories.length} catégories, ${shops.length} boutiques et ${products.length} produits insérés.`);
  console.log(`ℹ Connecte-toi à l'espace vendeur avec : ${SHOP_EMAIL} / ${SHOP_PASSWORD}`);
}

// ---------------------------------------------------------------------
// 4. COMPTE ADMIN (vérifié et créé indépendamment du reste)
// ---------------------------------------------------------------------
// Contrairement à seedIfEmpty() ci-dessus (qui ne s'exécute que sur une
// base totalement vide), cette vérification tourne à CHAQUE démarrage du
// serveur.
async function seedAdminIfMissing() {
  const { rows } = await pool.query('SELECT id FROM admins WHERE email = $1', [ADMIN_EMAIL.toLowerCase()]);
  if (rows[0]) {
    console.log(`La base contient déjà un compte admin (${ADMIN_EMAIL}), seed admin ignoré.`);
    return;
  }

  await pool.query(
    'INSERT INTO admins (name, email, password_hash) VALUES ($1, $2, $3)',
    ['Admin TradeHub', ADMIN_EMAIL.toLowerCase(), bcrypt.hashSync(ADMIN_PASSWORD, 10)]
  );

  console.log(`✔ Compte admin créé : ${ADMIN_EMAIL}`);
}

// ---------------------------------------------------------------------
// Initialisation du module
// ---------------------------------------------------------------------
// server.js doit `await initDatabase()` avant de démarrer le serveur.
async function initDatabase() {
  await createTables();
  await seedIfEmpty();
  await seedAdminIfMissing();
}

module.exports = { pool, withTransaction, initDatabase };
