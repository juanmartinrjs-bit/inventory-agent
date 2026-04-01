require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');

// ── Integration: notify accounting agent of movements ─────────────────────────
const ACCOUNTING_URL = process.env.ACCOUNTING_URL || 'http://localhost:3002';

// Notify accounting agent — groups all movements of a session into ONE transaction
async function notifyAccountingAgentBatch(userId, movements) {
  try {
    if (!movements || movements.length === 0) return;

    const isIncome = movements[0].type === 'salida';
    const totalAmount = movements.reduce((sum, m) => sum + (m.total || 0), 0);
    if (totalAmount === 0) return; // nothing to record

    const productLines = movements.map(m => `${m.product_name} x${m.quantity}`).join(', ');
    const date = new Date().toISOString().split('T')[0];

    const payload = {
      userId,
      transactions: [{
        date,
        amount: isIncome ? totalAmount : -totalAmount,
        currency: 'COP',
        description: isIncome
          ? `Venta: ${productLines}`
          : `Compra de mercancía: ${productLines}`,
        category: isIncome ? 'Ingresos operacionales' : 'Costos de inventario',
        puc_code: isIncome ? '4135' : '6135',
        type: isIncome ? 'income' : 'expense',
        source: 'Inventory Agent',
        deductible: true,
        confidence: 'high'
      }]
    };

    const data = JSON.stringify(payload);
    const urlObj = new URL(`${ACCOUNTING_URL}/transactions/confirm`);
    const options = {
      hostname: urlObj.hostname,
      port: parseInt(urlObj.port) || 3002,
      path: urlObj.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };

    await new Promise((resolve) => {
      const req = http.request(options, (res) => {
        res.on('data', () => {});
        res.on('end', resolve);
      });
      req.on('error', () => resolve());
      req.write(data);
      req.end();
    });

    console.log(`📊 Accounting sync: ${isIncome ? 'ingreso' : 'gasto'} $${totalAmount.toLocaleString('es-CO')} COP → ${productLines}`);
  } catch (e) {
    // Don't break inventory if accounting is down
  }
}

const {
  getUser, createUser,
  getProducts, getProduct, addProduct, updateStock,
  addMovement, getMovements, getLowStockProducts,
  getInventoryValue, searchProducts
} = require('./database/db');

const { parseInventoryAction, chat } = require('./agent/claude');
const { generateInventoryReport } = require('./excel/generator');

const app = express();
const PORT = process.env.PORT || 3003;

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// In-memory state per user
const chatHistories = {};
const pendingActions = {};

// Helper: get or create user
function getOrCreateUser(userId) {
  let user = getUser(userId);
  if (!user) {
    user = createUser({
      id: userId,
      business_name: 'Mi Negocio',
      business_type: 'tienda',
      setup_complete: 1
    });
  }
  return user;
}

// Helper: format currency
function formatCurrency(amount) {
  return `$${new Intl.NumberFormat('es-CO').format(Math.round(amount))} COP`;
}

// Helper: format product list for response
function formatProductList(products) {
  if (!products || products.length === 0) {
    return '📦 No encontré productos con ese nombre.';
  }
  const lines = products.map(p => {
    const status = p.stock === 0 ? '🔴 AGOTADO' : p.stock <= p.min_stock ? '🟡 BAJO' : '🟢';
    return `${status} *${p.name}*: ${p.stock} ${p.unit} | Venta: ${formatCurrency(p.sell_price)}`;
  });
  return `📦 *Inventario:*\n${lines.join('\n')}`;
}

// ---- GET /status ----
app.get('/status', (req, res) => {
  res.json({ status: 'ok', service: 'inventory-agent', port: PORT });
});

// ---- GET /stats/:userId ----
app.get('/stats/:userId', (req, res) => {
  const { userId } = req.params;
  const user = getOrCreateUser(userId);
  const products = getProducts(userId);
  const lowStock = getLowStockProducts(userId);
  const inventoryValue = getInventoryValue(userId);

  // Today's movements
  const today = new Date().toISOString().split('T')[0];
  const allMovements = getMovements(userId, 200);
  const todayMovements = allMovements.filter(m => (m.date || m.created_at || '').startsWith(today));

  res.json({
    businessName: user.business_name,
    totalProducts: products.length,
    lowStockCount: lowStock.length,
    inventoryValue,
    inventoryValueFormatted: formatCurrency(inventoryValue),
    todayMovements: todayMovements.length
  });
});

// ---- GET /sales/:userId ----  ventas del período actual con desglose por producto
app.get('/sales/:userId', (req, res) => {
  const { userId } = req.params;
  getOrCreateUser(userId);
  const allMovements = getMovements(userId, 1000);
  const ventas = allMovements.filter(m => m.type === 'salida');

  // Total general
  const totalVentas = ventas.reduce((s, m) => s + (m.total || 0), 0);

  // Desglose por producto
  const byProduct = {};
  ventas.forEach(m => {
    if (!byProduct[m.product_name]) byProduct[m.product_name] = { total: 0, quantity: 0 };
    byProduct[m.product_name].total += m.total || 0;
    byProduct[m.product_name].quantity += m.quantity || 0;
  });

  // Ordenar de mayor a menor
  const breakdown = Object.entries(byProduct)
    .map(([name, data]) => ({ name, total: data.total, quantity: data.quantity }))
    .sort((a, b) => b.total - a.total);

  res.json({ totalVentas, breakdown });
});

// ---- GET /products/:userId ----
app.get('/products/:userId', (req, res) => {
  const { userId } = req.params;
  getOrCreateUser(userId);
  const products = getProducts(userId);
  res.json({ products });
});

// ---- POST /chat ----
app.post('/chat', async (req, res) => {
  const { userId = 'default', message } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Mensaje vacío' });
  }

  try {
    const user = getOrCreateUser(userId);
    const products = getProducts(userId);

    const action = await parseInventoryAction(message, user, products);

    // Initialize chat history
    if (!chatHistories[userId]) chatHistories[userId] = [];

    // Handle entrada / salida → ask for confirmation
    if (action.action === 'entrada' || action.action === 'salida') {
      // Check if products exist, flag unknowns
      const knownProducts = [];
      const unknownProducts = [];

      for (const item of (action.products || [])) {
        const found = getProduct(userId, item.name);
        if (found) {
          knownProducts.push({ ...item, resolved_name: found.name, product_id: found.id });
        } else {
          unknownProducts.push(item);
        }
      }

      if (knownProducts.length === 0 && unknownProducts.length > 0) {
        const names = unknownProducts.map(p => `"${p.name}"`).join(', ');
        return res.json({
          type: 'message',
          reply: `⚠️ No encontré estos productos en tu inventario: ${names}. ¿Quieres agregarlos primero?`
        });
      }

      pendingActions[userId] = { ...action, products: knownProducts, unknownProducts };

      const actionLabel = action.action === 'entrada' ? 'Entrada de mercancía' : 'Salida de inventario';
      return res.json({
        type: 'confirm',
        action: action.action,
        products: knownProducts,
        unknownProducts,
        reply: action.reply || `¿Confirmas registrar la ${action.action}?`
      });
    }

    // Handle consulta
    if (action.action === 'consulta') {
      const query = action.query || message;
      const found = searchProducts(userId, query);
      const reply = found.length > 0 ? formatProductList(found) : action.reply || '📦 No encontré ese producto.';
      return res.json({ type: 'message', reply });
    }

    // Handle reporte
    if (action.action === 'reporte') {
      const allProducts = getProducts(userId);
      const allMovements = getMovements(userId, 500);

      try {
        const { filename } = await generateInventoryReport(allProducts, allMovements, user);
        return res.json({
          type: 'report',
          filename,
          downloadUrl: `/download/${filename}`,
          reply: `📊 Reporte generado con éxito! Incluye ${allProducts.length} productos y ${allMovements.length} movimientos.`
        });
      } catch (e) {
        return res.json({
          type: 'message',
          reply: `❌ Error generando reporte: ${e.message}`
        });
      }
    }

    // Handle agregar_producto
    if (action.action === 'agregar_producto' && action.new_product) {
      pendingActions[userId] = { action: 'agregar_producto', new_product: action.new_product };
      return res.json({
        type: 'confirm',
        action: 'agregar_producto',
        new_product: action.new_product,
        reply: action.reply || `¿Confirmas agregar "${action.new_product.name}" al inventario?`
      });
    }

    // Default: general chat
    const reply = await chat(message, chatHistories[userId], user);
    chatHistories[userId].push({ role: 'user', content: message });
    chatHistories[userId].push({ role: 'assistant', content: reply });

    // Keep history trimmed to last 20 messages
    if (chatHistories[userId].length > 20) {
      chatHistories[userId] = chatHistories[userId].slice(-20);
    }

    return res.json({ type: 'message', reply });

  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({
      type: 'message',
      reply: `❌ Error procesando tu mensaje: ${err.message}`
    });
  }
});

// ---- POST /actions/confirm ----
app.post('/actions/confirm', (req, res) => {
  const { userId = 'default', confirmed } = req.body;
  const pending = pendingActions[userId];

  if (!pending || !confirmed) {
    delete pendingActions[userId];
    return res.json({ type: 'message', reply: '❌ Acción cancelada.' });
  }

  // Handle agregar_producto confirmation
  if (pending.action === 'agregar_producto') {
    const np = pending.new_product;
    const added = addProduct({
      user_id: userId,
      name: np.name,
      category: np.category || null,
      unit: np.unit || 'unidad',
      stock: np.stock || 0,
      min_stock: np.min_stock || 5,
      cost_price: np.cost_price || 0,
      sell_price: np.sell_price || 0
    });
    delete pendingActions[userId];
    return res.json({
      type: 'message',
      reply: `✅ Producto "${added.name}" agregado al inventario.`
    });
  }

  // Handle entrada / salida confirmation
  const processed = [];
  const processedMovements = [];
  const notFound = [];

  for (const item of (pending.products || [])) {
    const product = getProduct(userId, item.product_id || item.name);
    if (!product) {
      notFound.push(item.name || item.resolved_name);
      continue;
    }

    const newStock = pending.action === 'entrada'
      ? product.stock + item.quantity
      : Math.max(0, product.stock - item.quantity);

    updateStock(product.id, newStock);

    // Use product price as default if user didn't specify
    const defaultPrice = pending.action === 'salida'
      ? (product.sell_price || 0)
      : (product.cost_price || 0);
    const unitPrice = item.unit_price > 0 ? item.unit_price : defaultPrice;

    const movement = {
      user_id: userId,
      product_id: product.id,
      product_name: product.name,
      type: pending.action,
      quantity: item.quantity,
      unit_price: unitPrice,
      total: unitPrice * item.quantity
    };
    addMovement(movement);
    processedMovements.push(movement);
    processed.push({ name: product.name, quantity: item.quantity, newStock });
  }

  delete pendingActions[userId];

  // Batch notify accounting agent (one transaction for the whole operation)
  notifyAccountingAgentBatch(userId, processedMovements);

  const actionLabel = pending.action === 'entrada' ? 'Entrada' : 'Salida';
  const totalVenta = processedMovements.reduce((s, m) => s + m.total, 0);
  let reply = `✅ ${actionLabel} registrada:\n`;
  reply += processed.map(p => `• ${p.name}: ${p.quantity} uds (stock: ${p.newStock})`).join('\n');
  if (totalVenta > 0) {
    reply += `\n💰 Total: $${new Intl.NumberFormat('es-CO').format(totalVenta)} COP`;
    reply += `\n📊 Registrado automáticamente en contabilidad`;
  }

  if (notFound.length > 0) {
    reply += `\n\n⚠️ No encontrados: ${notFound.join(', ')}`;
  }

  // Low stock alerts
  const lowStock = getLowStockProducts(userId);
  if (lowStock.length > 0) {
    reply += `\n\n⚠️ Stock bajo: ${lowStock.map(p => `${p.name} (${p.stock} ${p.unit})`).join(', ')}`;
  }

  res.json({ type: 'message', reply, lowStock });
});

// ---- POST /report/:userId ----
app.post('/report/:userId', async (req, res) => {
  const { userId } = req.params;
  const user = getOrCreateUser(userId);
  const products = getProducts(userId);
  const movements = getMovements(userId, 500);

  try {
    const { filename } = await generateInventoryReport(products, movements, user);
    res.json({ filename, downloadUrl: `/download/${filename}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- GET /download/:filename ----
app.get('/download/:filename', (req, res) => {
  const { filename } = req.params;
  // Security: only allow xlsx files with safe names
  if (!/^[a-zA-Z0-9_\-\.]+\.xlsx$/.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filepath = path.join(__dirname, '../data', filename);
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  res.download(filepath, filename);
});

// Start server
app.listen(PORT, () => {
  console.log(`🏪 Inventory Agent running on http://localhost:${PORT}`);
  console.log(`📦 Ready to manage inventory for small Colombian businesses!`);
});
