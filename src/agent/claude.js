const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-5-20250929';

const SYSTEM_PROMPT = `Eres un asistente de inventario para pequeños negocios colombianos. Eres práctico, directo y hablas en español.

Ayudas a:
- Registrar entradas de mercancía (compras, recepción de pedidos)
- Registrar salidas (ventas, mermas, devoluciones)
- Consultar stock actual
- Ver productos con stock bajo
- Analizar qué se vende más
- Generar reportes

Cuando el usuario menciona productos con cantidades y precios, extrae la información y actúa.
Confirma antes de guardar cambios importantes.
Sé conciso — respuestas cortas y al punto.`;

/**
 * Parse natural language into structured inventory action
 */
async function parseInventoryAction(message, user, products) {
  const productList = products.length > 0
    ? products.map(p => `${p.name} (${p.stock} ${p.unit})`).join(', ')
    : 'Sin productos registrados';

  const prompt = `Analiza este mensaje y determina qué quiere hacer el usuario con su inventario.

Negocio: ${user.business_name} (${user.business_type})
Productos actuales: ${productList}
Mensaje: "${message}"

Responde ÚNICAMENTE en JSON válido (sin markdown, sin texto adicional):
{
  "action": "entrada|salida|consulta|reporte|agregar_producto|chat",
  "products": [{"name": "nombre exacto o aproximado del producto", "quantity": N, "unit_price": N}],
  "query": "término de búsqueda si es consulta",
  "new_product": {"name":"...","category":"...","unit":"...","min_stock":5,"cost_price":0,"sell_price":0},
  "reply": "respuesta conversacional breve para el usuario"
}

Notas:
- "entrada" = compras, llegó mercancía, recibí pedido
- "salida" = vendí, despachué, merma, devolución
- "consulta" = quiero ver stock, cuánto tengo, buscar producto
- "reporte" = genera reporte, dame informe, exportar Excel
- "agregar_producto" = nuevo producto, agregar al inventario
- "chat" = pregunta general o conversación
- Si el producto no existe en la lista, aún incluirlo en products[] con el nombre mencionado
- unit_price puede ser 0 si no se menciona precio`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = response.content[0].text.trim();

  try {
    // Extract JSON if wrapped in code blocks
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || text.match(/(\{[\s\S]*\})/);
    const jsonStr = jsonMatch ? jsonMatch[1] : text;
    return JSON.parse(jsonStr);
  } catch (e) {
    // Fallback if JSON parsing fails
    return {
      action: 'chat',
      products: [],
      query: '',
      reply: text
    };
  }
}

/**
 * Generate inventory report analysis
 */
async function generateReport(products, movements, user) {
  const totalValue = products.reduce((sum, p) => sum + (p.stock * p.cost_price), 0);
  const lowStock = products.filter(p => p.stock <= p.min_stock);
  const outOfStock = products.filter(p => p.stock === 0);

  // Calculate top sellers from movements
  const salesByProduct = {};
  movements.filter(m => m.type === 'salida').forEach(m => {
    salesByProduct[m.product_name] = (salesByProduct[m.product_name] || 0) + m.quantity;
  });
  const topSellers = Object.entries(salesByProduct)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, qty]) => `${name}: ${qty} uds`);

  const prompt = `Genera un análisis breve del inventario para ${user.business_name}:

Resumen:
- Total productos: ${products.length}
- Valor total inventario: $${new Intl.NumberFormat('es-CO').format(totalValue)} COP
- Productos con stock bajo: ${lowStock.length}
- Productos agotados: ${outOfStock.length}
- Top ventas: ${topSellers.length > 0 ? topSellers.join(', ') : 'Sin movimientos'}

Productos con stock bajo: ${lowStock.map(p => `${p.name} (${p.stock} uds)`).join(', ') || 'Ninguno'}

Proporciona:
1. Resumen ejecutivo (2-3 oraciones)
2. Alertas importantes
3. 2-3 recomendaciones concretas

Sé conciso y práctico. Usa formato de texto plano.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }]
  });

  return response.content[0].text;
}

/**
 * Answer general inventory/business question
 */
async function chat(message, history, user) {
  const messages = [
    ...history.slice(-10).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message }
  ];

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: `${SYSTEM_PROMPT}\n\nNegocio actual: ${user.business_name} (${user.business_type}), moneda: ${user.currency}`,
    messages
  });

  return response.content[0].text;
}

module.exports = { parseInventoryAction, generateReport, chat };
