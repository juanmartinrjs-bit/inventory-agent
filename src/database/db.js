const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'inventory.db'));

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    business_name TEXT,
    business_type TEXT,
    currency TEXT DEFAULT 'COP',
    low_stock_threshold INTEGER DEFAULT 5,
    setup_complete INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    sku TEXT,
    category TEXT,
    unit TEXT DEFAULT 'unidad',
    stock INTEGER DEFAULT 0,
    min_stock INTEGER DEFAULT 5,
    cost_price REAL DEFAULT 0,
    sell_price REAL DEFAULT 0,
    expiry_date TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    product_id INTEGER NOT NULL,
    product_name TEXT,
    type TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price REAL DEFAULT 0,
    total REAL DEFAULT 0,
    notes TEXT,
    date TEXT DEFAULT (datetime('now')),
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// --- User functions ---

function getUser(userId) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

function createUser(data) {
  const stmt = db.prepare(`
    INSERT INTO users (id, business_name, business_type, currency, low_stock_threshold, setup_complete)
    VALUES (@id, @business_name, @business_type, @currency, @low_stock_threshold, @setup_complete)
  `);
  stmt.run({
    id: data.id,
    business_name: data.business_name || 'Mi Negocio',
    business_type: data.business_type || 'tienda',
    currency: data.currency || 'COP',
    low_stock_threshold: data.low_stock_threshold || 5,
    setup_complete: data.setup_complete || 0
  });
  return getUser(data.id);
}

function updateUser(userId, data) {
  const fields = Object.keys(data).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE users SET ${fields} WHERE id = @id`).run({ ...data, id: userId });
  return getUser(userId);
}

// --- Product functions ---

function addProduct(data) {
  const stmt = db.prepare(`
    INSERT INTO products (user_id, name, sku, category, unit, stock, min_stock, cost_price, sell_price, expiry_date)
    VALUES (@user_id, @name, @sku, @category, @unit, @stock, @min_stock, @cost_price, @sell_price, @expiry_date)
  `);
  const result = stmt.run({
    user_id: data.user_id,
    name: data.name,
    sku: data.sku || null,
    category: data.category || null,
    unit: data.unit || 'unidad',
    stock: data.stock || 0,
    min_stock: data.min_stock || 5,
    cost_price: data.cost_price || 0,
    sell_price: data.sell_price || 0,
    expiry_date: data.expiry_date || null
  });
  return db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid);
}

function getProduct(userId, nameOrId) {
  // Try by ID first
  if (typeof nameOrId === 'number' || /^\d+$/.test(nameOrId)) {
    const byId = db.prepare('SELECT * FROM products WHERE id = ? AND user_id = ?').get(nameOrId, userId);
    if (byId) return byId;
  }
  // Try exact name match
  const exact = db.prepare('SELECT * FROM products WHERE user_id = ? AND LOWER(name) = LOWER(?)').get(userId, nameOrId);
  if (exact) return exact;
  // Try partial name match
  return db.prepare('SELECT * FROM products WHERE user_id = ? AND LOWER(name) LIKE LOWER(?)').get(userId, `%${nameOrId}%`);
}

function getProducts(userId) {
  return db.prepare('SELECT * FROM products WHERE user_id = ? ORDER BY name').all(userId);
}

function updateStock(productId, newStock) {
  db.prepare("UPDATE products SET stock = ?, updated_at = datetime('now') WHERE id = ?").run(newStock, productId);
}

function updateProduct(productId, data) {
  const fields = Object.keys(data).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE products SET ${fields}, updated_at = datetime('now') WHERE id = @id`).run({ ...data, id: productId });
  return db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
}

function getLowStockProducts(userId) {
  return db.prepare('SELECT * FROM products WHERE user_id = ? AND stock <= min_stock ORDER BY stock ASC').all(userId);
}

function getProductsByCategory(userId, category) {
  return db.prepare('SELECT * FROM products WHERE user_id = ? AND LOWER(category) = LOWER(?) ORDER BY name').all(userId, category);
}

function getInventoryValue(userId) {
  const result = db.prepare('SELECT SUM(stock * cost_price) as total FROM products WHERE user_id = ?').get(userId);
  return result ? result.total || 0 : 0;
}

function searchProducts(userId, query) {
  return db.prepare('SELECT * FROM products WHERE user_id = ? AND LOWER(name) LIKE LOWER(?) ORDER BY name').all(userId, `%${query}%`);
}

// --- Movement functions ---

function addMovement(data) {
  const stmt = db.prepare(`
    INSERT INTO movements (user_id, product_id, product_name, type, quantity, unit_price, total, notes)
    VALUES (@user_id, @product_id, @product_name, @type, @quantity, @unit_price, @total, @notes)
  `);
  const result = stmt.run({
    user_id: data.user_id,
    product_id: data.product_id,
    product_name: data.product_name || null,
    type: data.type,
    quantity: data.quantity,
    unit_price: data.unit_price || 0,
    total: data.total || 0,
    notes: data.notes || null
  });
  return db.prepare('SELECT * FROM movements WHERE id = ?').get(result.lastInsertRowid);
}

function getMovements(userId, limit = 100) {
  return db.prepare('SELECT * FROM movements WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit);
}

function getMovementsByProduct(productId, limit = 50) {
  return db.prepare('SELECT * FROM movements WHERE product_id = ? ORDER BY created_at DESC LIMIT ?').all(productId, limit);
}

// --- Seed demo data ---
const demoUser = getUser('demo');
if (!demoUser) {
  createUser({ id: 'demo', business_name: 'Tienda Demo', business_type: 'tienda', setup_complete: 1 });
  ['Camisas talla M', 'Pantalones talla 32', 'Zapatos talla 40', 'Bolsos de cuero', 'Cinturones'].forEach((name, i) => {
    addProduct({
      user_id: 'demo',
      name,
      category: 'Ropa',
      unit: 'unidad',
      stock: (i + 1) * 10,
      min_stock: 5,
      cost_price: 50000 * (i + 1),
      sell_price: 80000 * (i + 1)
    });
  });
}

module.exports = {
  getUser,
  createUser,
  updateUser,
  addProduct,
  getProduct,
  getProducts,
  updateStock,
  updateProduct,
  getLowStockProducts,
  getProductsByCategory,
  getInventoryValue,
  searchProducts,
  addMovement,
  getMovements,
  getMovementsByProduct
};
