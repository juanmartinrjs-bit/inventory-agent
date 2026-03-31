const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const { generateReport } = require('../agent/claude');

const dataDir = path.join(__dirname, '../../data');

async function generateInventoryReport(products, movements, user) {
  const wb = XLSX.utils.book_new();

  // ---- Sheet 1: Inventario Actual ----
  const inventoryData = [
    ['Producto', 'Categoría', 'Stock', 'Unidad', 'Stock Mínimo', 'Precio Compra', 'Precio Venta', 'Valor Inventario', 'Estado']
  ];
  for (const p of products) {
    const value = p.stock * p.cost_price;
    let status = 'OK';
    if (p.stock === 0) status = 'AGOTADO';
    else if (p.stock <= p.min_stock) status = 'BAJO';

    inventoryData.push([
      p.name,
      p.category || '',
      p.stock,
      p.unit,
      p.min_stock,
      p.cost_price,
      p.sell_price,
      value,
      status
    ]);
  }
  const wsInventory = XLSX.utils.aoa_to_sheet(inventoryData);
  // Style header row
  wsInventory['!cols'] = [
    { wch: 30 }, { wch: 15 }, { wch: 10 }, { wch: 10 },
    { wch: 15 }, { wch: 15 }, { wch: 15 }, { wch: 18 }, { wch: 10 }
  ];
  XLSX.utils.book_append_sheet(wb, wsInventory, 'Inventario Actual');

  // ---- Sheet 2: Movimientos ----
  const last500 = movements.slice(0, 500);
  const movData = [
    ['Fecha', 'Producto', 'Tipo', 'Cantidad', 'Precio Unitario', 'Total', 'Notas']
  ];
  for (const m of last500) {
    movData.push([
      m.date || m.created_at,
      m.product_name || '',
      m.type === 'entrada' ? 'Entrada' : 'Salida',
      m.quantity,
      m.unit_price,
      m.total,
      m.notes || ''
    ]);
  }
  const wsMovements = XLSX.utils.aoa_to_sheet(movData);
  wsMovements['!cols'] = [
    { wch: 20 }, { wch: 30 }, { wch: 10 }, { wch: 10 }, { wch: 15 }, { wch: 15 }, { wch: 25 }
  ];
  XLSX.utils.book_append_sheet(wb, wsMovements, 'Movimientos');

  // ---- Sheet 3: Resumen ----
  const totalValue = products.reduce((sum, p) => sum + (p.stock * p.cost_price), 0);
  const lowStockProds = products.filter(p => p.stock <= p.min_stock && p.stock > 0);
  const outOfStock = products.filter(p => p.stock === 0);

  // Top 10 sellers
  const salesByProduct = {};
  movements.filter(m => m.type === 'salida').forEach(m => {
    salesByProduct[m.product_name] = (salesByProduct[m.product_name] || 0) + m.quantity;
  });
  const topSellers = Object.entries(salesByProduct)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // Slow movers (products with no sales)
  const soldProducts = new Set(movements.filter(m => m.type === 'salida').map(m => m.product_name));
  const slowMovers = products.filter(p => !soldProducts.has(p.name) && p.stock > 0);

  const summaryData = [
    ['RESUMEN DE INVENTARIO'],
    [''],
    ['Métrica', 'Valor'],
    ['Total de productos', products.length],
    ['Valor total del inventario', `$${new Intl.NumberFormat('es-CO').format(totalValue)} COP`],
    ['Productos con stock bajo', lowStockProds.length],
    ['Productos agotados', outOfStock.length],
    ['Total movimientos registrados', movements.length],
    [''],
    ['TOP 10 PRODUCTOS MÁS VENDIDOS'],
    ['Producto', 'Unidades Vendidas'],
    ...topSellers.map(([name, qty]) => [name, qty]),
    [''],
    ['PRODUCTOS SIN MOVIMIENTO (LENTOS)'],
    ['Producto', 'Stock Actual'],
    ...slowMovers.slice(0, 10).map(p => [p.name, p.stock])
  ];
  const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
  wsSummary['!cols'] = [{ wch: 35 }, { wch: 25 }];
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Resumen');

  // ---- Sheet 4: Análisis IA ----
  let aiAnalysis = 'Análisis no disponible';
  try {
    aiAnalysis = await generateReport(products, movements, user);
  } catch (e) {
    aiAnalysis = 'Error generando análisis de IA: ' + e.message;
  }

  const aiLines = aiAnalysis.split('\n').map(line => [line]);
  const wsAI = XLSX.utils.aoa_to_sheet([
    ['ANÁLISIS DE INVENTARIO - GENERADO POR IA'],
    ['Fecha:', new Date().toLocaleString('es-CO')],
    ['Negocio:', user.business_name],
    [''],
    ...aiLines
  ]);
  wsAI['!cols'] = [{ wch: 80 }];
  XLSX.utils.book_append_sheet(wb, wsAI, 'Análisis IA');

  // Save file
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const filename = `inventario_${user.id}_${Date.now()}.xlsx`;
  const filepath = path.join(dataDir, filename);
  XLSX.writeFile(wb, filepath);

  return { filepath, filename };
}

module.exports = { generateInventoryReport };
