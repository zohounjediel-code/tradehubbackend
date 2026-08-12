// database.js
// -----------------------------------------------------------------------
// Ce fichier gère TOUT ce qui touche à la base de données SQLite :
//   1. La connexion au fichier tradehub.db (créé automatiquement)
//   2. La création des tables si elles n'existent pas encore
//   3. Le remplissage avec des données de démonstration (seed)
//
// SQLite stocke toute la base dans un seul fichier -> pas de serveur
// de base de données à installer, parfait pour débuter !
// -----------------------------------------------------------------------

require('dotenv').config();

const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const { fetchUnsplashImage, isUnsplashConfigured } = require('./utils/unsplashImage');

const dbPath = path.join(__dirname, 'tradehub.db');
const db = new Database(dbPath);

// Active les clés étrangères (désactivées par défaut dans SQLite)
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------
// 1. CRÉATION DES TABLES
// ---------------------------------------------------------------------
function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      icon TEXT
    );

    -- Comptes administrateur : peuvent créer/gérer les comptes boutique.
    -- Complètement séparés des comptes boutique (pas d'auto-inscription).
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Comptes client (acheteurs) : inscription libre, contrairement aux
    -- comptes boutique qui sont désormais créés uniquement par un admin.
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      phone TEXT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Panier lié à un compte client : persiste côté serveur, donc survive
    -- à une déconnexion/reconnexion (contrairement à un panier "invité"
    -- qui ne vit que dans le navigateur, en localStorage).
    -- ON DELETE CASCADE : si le produit ou le compte est supprimé, la
    -- ligne de panier correspondante disparaît proprement.
    CREATE TABLE IF NOT EXISTS cart_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
      UNIQUE(customer_id, product_id)
    );

    -- Comptes boutique : créés uniquement par un administrateur (voir
    -- routes/admin.js). Chaque boutique peut ensuite se connecter et gérer
    -- ses propres produits depuis l'espace vendeur.
    -- iban_encrypted / bic_encrypted sont stockés CHIFFRÉS (voir utils/crypto.js),
    -- jamais en clair : ce sont des données bancaires sensibles.
    CREATE TABLE IF NOT EXISTS shops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      country TEXT,
      verified INTEGER DEFAULT 0,
      bank_account_holder TEXT,
      iban_encrypted TEXT,
      bic_encrypted TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT,
      price REAL NOT NULL,
      moq INTEGER NOT NULL DEFAULT 1,
      image_url TEXT,
      category_id INTEGER,
      shop_id INTEGER NOT NULL,
      rating REAL DEFAULT 4.5,
      orders_count INTEGER DEFAULT 0,
      FOREIGN KEY (category_id) REFERENCES categories(id),
      FOREIGN KEY (shop_id) REFERENCES shops(id)
    );

    -- customer_id : désormais toujours renseigné pour une nouvelle commande
    -- (la commande "invité" a été retirée -- il faut être connecté). La
    -- colonne reste nullable pour ne pas casser d'éventuelles anciennes
    -- commandes passées avant ce changement, et ON DELETE SET NULL évite
    -- de bloquer la suppression d'un compte client plus tard.
    --
    -- Paiement par virement bancaire : payment_status vaut 'pending' par
    -- défaut (en attente), puis 'reported' une fois que le client a
    -- indiqué avoir payé (avec sa preuve). Ce n'est PAS une confirmation
    -- que l'argent est bien arrivé -- juste un signalement du client, à
    -- vérifier manuellement par la boutique/l'admin.
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      customer_phone TEXT,
      shipping_address TEXT NOT NULL,
      total REAL NOT NULL,
      status TEXT DEFAULT 'en attente',
      payment_status TEXT DEFAULT 'pending',
      payment_proof_filename TEXT,
      payment_reported_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_id INTEGER,
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price REAL NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
    );

    -- Messages du formulaire de contact (voir contact.html). Comme le
    -- projet n'a pas de service d'envoi d'email configuré, les messages
    -- sont stockés ici pour de vrai (pas un formulaire factice) et
    -- consultables par un admin (voir admin-messages.html).
    CREATE TABLE IF NOT EXISTS contact_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      message TEXT NOT NULL,
      is_read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
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
// produits ci-dessous. (Avant, il y avait 17 boutiques de démo -- passé
// à une seule à la demande, directement dans le code de seed cette fois,
// pour que ça survive à un `rm tradehub.db` lors d'une future mise à jour.)
const SHOP_NAME = 'Legros';
const SHOP_EMAIL = 'legrosdetail@gmail.com';
const SHOP_PASSWORD = '12345678';
const SHOP_COUNTRY = 'France';

const shops = [
  { shop_name: SHOP_NAME, email: SHOP_EMAIL, country: SHOP_COUNTRY, verified: 1 },
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
  const count = db.prepare('SELECT COUNT(*) AS n FROM categories').get().n;
  if (count > 0) {
    console.log('La base contient déjà des données (catégories/boutiques/produits), seed ignoré.');
    return;
  }

  console.log('Remplissage de la base avec les données de démonstration...');
  if (isUnsplashConfigured()) {
    console.log('  → clé Unsplash détectée : recherche de vraies photos pour chaque produit...');
  } else {
    console.log('  → pas de clé Unsplash configurée : les produits sans photo resteront sans image (voir .env.example).');
  }

  // --- Catégories ---
  const insertCategory = db.prepare(
    'INSERT INTO categories (name, slug, icon) VALUES (@name, @slug, @icon)'
  );
  const categoryIdBySlug = {};
  const insertManyCategories = db.transaction((rows) => {
    for (const c of rows) {
      const info = insertCategory.run(c);
      categoryIdBySlug[c.slug] = info.lastInsertRowid;
    }
  });
  insertManyCategories(categories);

  // --- Boutiques (avec mot de passe hashé) ---
  const passwordHash = bcrypt.hashSync(SHOP_PASSWORD, 10);
  const insertShop = db.prepare(`
    INSERT INTO shops (shop_name, email, password_hash, country, verified)
    VALUES (@shop_name, @email, @password_hash, @country, @verified)
  `);
  const shopIdByEmail = {};
  const insertManyShops = db.transaction((rows) => {
    for (const s of rows) {
      const info = insertShop.run({ ...s, password_hash: passwordHash });
      shopIdByEmail[s.email] = info.lastInsertRowid;
    }
  });
  insertManyShops(shops);

  // --- Produits ---
  // On récupère d'abord TOUTES les images via Unsplash, une par une, AVANT
  // d'insérer -- les appels réseau sont asynchrones, donc on ne peut pas
  // les faire à l'intérieur de la transaction SQLite ci-dessous (qui, elle,
  // doit rester synchrone). Si aucune photo n'est trouvée pour un produit,
  // image_url reste vide : mieux vaut ne rien afficher qu'un mockup qui ne
  // ressemble pas à une vraie photo.
  const productsWithImages = [];
  for (const p of products) {
    const unsplashUrl = await fetchUnsplashImage(p.imageQuery);
    productsWithImages.push({ ...p, image_url: unsplashUrl || null });
  }

  const insertProduct = db.prepare(`
    INSERT INTO products
      (name, slug, description, price, moq, image_url, category_id, shop_id, rating, orders_count)
    VALUES
      (@name, @slug, @description, @price, @moq, @image_url, @category_id, @shop_id, @rating, @orders_count)
  `);
  const insertManyProducts = db.transaction((rows) => {
    for (const p of rows) {
      insertProduct.run({
        name: p.name,
        slug: p.slug,
        description: p.description,
        price: p.price,
        moq: p.moq,
        image_url: p.image_url,
        category_id: categoryIdBySlug[p.category],
        shop_id: shopIdByEmail[p.shopEmail],
        rating: p.rating,
        orders_count: p.orders,
      });
    }
  });
  insertManyProducts(productsWithImages);

  console.log(`✔ ${categories.length} catégories, ${shops.length} boutiques et ${products.length} produits insérés.`);
  console.log(`ℹ Connecte-toi à l'espace vendeur avec : ${SHOP_EMAIL} / ${SHOP_PASSWORD}`);
}

// ---------------------------------------------------------------------
// 4. COMPTE ADMIN (vérifié et créé indépendamment du reste)
// ---------------------------------------------------------------------
// Contrairement à seedIfEmpty() ci-dessus (qui ne s'exécute que sur une
// base totalement vide), cette vérification tourne à CHAQUE démarrage du
// serveur. Utile si tu ajoutes ou changes les identifiants admin dans ce
// fichier après avoir déjà lancé le projet une première fois : pas besoin
// de supprimer toute ta base pour autant, juste de relancer `npm start`.
function seedAdminIfMissing() {
  const existingAdmin = db.prepare('SELECT id FROM admins WHERE email = ?').get(ADMIN_EMAIL.toLowerCase());
  if (existingAdmin) {
    console.log(`La base contient déjà un compte admin (${ADMIN_EMAIL}), seed admin ignoré.`);
    return;
  }

  db.prepare(`
    INSERT INTO admins (name, email, password_hash)
    VALUES (@name, @email, @password_hash)
  `).run({
    name: 'Admin TradeHub',
    email: ADMIN_EMAIL.toLowerCase(),
    password_hash: bcrypt.hashSync(ADMIN_PASSWORD, 10),
  });

  console.log(`✔ Compte admin créé : ${ADMIN_EMAIL}`);
}

// ---------------------------------------------------------------------
// Initialisation du module
// ---------------------------------------------------------------------
// La création des tables reste synchrone (rapide, pas de réseau).
// Le seed, lui, est asynchrone à cause des appels à l'API Unsplash --
// c'est pour ça qu'on exporte une fonction `initDatabase()` que
// server.js doit `await` avant de démarrer le serveur, plutôt que de
// tout exécuter immédiatement à l'import comme avant.
createTables();

async function initDatabase() {
  await seedIfEmpty();
  seedAdminIfMissing();
}

module.exports = { db, initDatabase };
