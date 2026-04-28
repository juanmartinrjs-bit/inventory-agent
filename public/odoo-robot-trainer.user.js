// ==UserScript==
// @name         Odoo Robot Trainer v1 · San Jorge
// @namespace    https://sanjorge.local/
// @version      1.0.0
// @description  Guía paso a paso para procesos de ventas, compras, inventario y POS en Odoo.
// @author       Inventory Agent
// @match        https://odonessas-sanjorge-v18-develop-31010714.dev.odoo.com/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const LS_ENABLED = 'odoo.robotTrainer.enabled';
  const LS_OPEN = 'odoo.robotTrainer.open';
  const LS_WAIT_CLICK = 'odoo.robotTrainer.waitClick';
  const AGENT_BASE_URL = 'http://localhost:3003';

  const EMBEDDED_FLOWS = {
    version: '1.0.0',
    source: 'embedded-fallback',
    flows: [
      {
        id: 'ventas_crear_cotizacion',
        title: 'Ventas · Crear cotización',
        intentKeywords: ['vender productos', 'vender', 'cotizacion', 'cotización', 'venta'],
        steps: [
          { id: 'vcc_1', title: 'Abrir Ventas', instruction: 'Haz clic en Ventas.', selectorCandidates: ["a[data-menu-xmlid='sale.sale_menu_root']"], fallbackText: ['Si no ves el acceso, busca la app Ventas.'] }
        ]
      },
      {
        id: 'compras_recibir_mercancia',
        title: 'Compras · Recibir mercancía',
        intentKeywords: ['ingresar pedido', 'recibir mercancía', 'entrada inventario'],
        steps: [
          { id: 'crm_1', title: 'Abrir recepción', instruction: 'Abre una recepción pendiente.', selectorCandidates: ["a[data-menu-xmlid='stock.menu_stock_warehouse_mgmt']"], fallbackText: ['Entra a Inventario > Operaciones > Transferencias.'] }
        ]
      }
    ]
  };

  const state = {
    enabled: localStorage.getItem(LS_ENABLED) !== '0',
    panelOpen: localStorage.getItem(LS_OPEN) === '1',
    waitClickMode: localStorage.getItem(LS_WAIT_CLICK) === '1',
    flowsCatalog: null,
    currentFlow: null,
    currentStepIndex: 0,
    highlightedEl: null,
    waitingForClick: false,
    clickHandler: null
  };

  function saveState() {
    localStorage.setItem(LS_ENABLED, state.enabled ? '1' : '0');
    localStorage.setItem(LS_OPEN, state.panelOpen ? '1' : '0');
    localStorage.setItem(LS_WAIT_CLICK, state.waitClickMode ? '1' : '0');
  }

  function normalizeText(s) {
    return (s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();
  }

  function parseIntent(message) {
    const txt = normalizeText(message);
    if (!txt) return null;

    const map = [
      { intent: 'vender_productos', patterns: ['vender productos', 'venta', 'vender'] },
      { intent: 'ingresar_pedido', patterns: ['ingresar pedido', 'recibir mercancia', 'recibir mercancia', 'compra'] },
      { intent: 'devoluciones', patterns: ['devoluciones', 'devolucion', 'devolver'] },
      { intent: 'transferencias', patterns: ['transferencias entre bodegas', 'transferencias entre sedes', 'transferencia interna'] },
      { intent: 'apertura_pv', patterns: ['apertura punto de venta', 'abrir punto de venta', 'apertura pos'] },
      { intent: 'cierre_caja', patterns: ['cierre de caja', 'cerrar caja', 'cierre punto de venta'] }
    ];

    for (const entry of map) {
      if (entry.patterns.some(p => txt.includes(normalizeText(p)))) return entry.intent;
    }
    return null;
  }

  function flowMatchesIntent(flow, intent) {
    const keywords = (flow.intentKeywords || []).map(normalizeText);
    const byIntent = {
      vender_productos: ['vender productos', 'venta', 'vender'],
      ingresar_pedido: ['ingresar pedido', 'recibir mercancia', 'compra'],
      devoluciones: ['devolucion', 'devolver'],
      transferencias: ['transferencias', 'transferencia interna', 'bodegas', 'sedes'],
      apertura_pv: ['apertura punto de venta', 'apertura pos', 'abrir punto de venta'],
      cierre_caja: ['cierre de caja', 'cerrar caja', 'cierre punto de venta']
    };
    return (byIntent[intent] || []).some(k => keywords.some(kw => kw.includes(k) || k.includes(kw)));
  }

  function queryByContains(selector) {
    const match = selector.match(/^([^:]+):contains\(['\"](.+)['\"]\)$/);
    if (!match) return null;
    const base = match[1].trim();
    const needle = normalizeText(match[2]);
    const nodes = Array.from(document.querySelectorAll(base));
    return nodes.find(n => normalizeText(n.textContent).includes(needle)) || null;
  }

  function resolveElement(selectors) {
    for (const sel of selectors || []) {
      let el = null;
      try {
        if (sel.includes(':contains(')) {
          el = queryByContains(sel);
        } else {
          el = document.querySelector(sel);
        }
      } catch (_) {
        el = null;
      }
      if (el) return { el, selector: sel };
    }
    return null;
  }

  function clearHighlight() {
    if (state.highlightedEl) {
      state.highlightedEl.classList.remove('odoo-robot-highlight');
      state.highlightedEl = null;
    }
  }

  function highlightElement(el) {
    clearHighlight();
    if (!el) return;
    state.highlightedEl = el;
    el.classList.add('odoo-robot-highlight');
    try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
  }

  function stopWaitingForClick() {
    state.waitingForClick = false;
    if (state.clickHandler) {
      document.removeEventListener('click', state.clickHandler, true);
      state.clickHandler = null;
    }
    setStatus('');
  }

  function startWaitingForClick(targetEl) {
    stopWaitingForClick();
    if (!state.waitClickMode || !targetEl) return;

    state.waitingForClick = true;
    setStatus('⏳ Esperando clic en el elemento resaltado...');
    state.clickHandler = function (ev) {
      if (targetEl === ev.target || targetEl.contains(ev.target)) {
        stopWaitingForClick();
        nextStep();
      }
    };
    document.addEventListener('click', state.clickHandler, true);
  }

  function setStatus(msg) {
    const statusEl = document.getElementById('odoo-robot-status');
    if (statusEl) statusEl.textContent = msg || '';
  }

  function renderFlowList() {
    const list = document.getElementById('odoo-robot-flow-list');
    if (!list) return;
    list.innerHTML = '';

    const flows = (state.flowsCatalog && state.flowsCatalog.flows) || [];
    flows.forEach(flow => {
      const btn = document.createElement('button');
      btn.className = 'odoo-robot-flow-btn';
      btn.textContent = flow.title;
      btn.onclick = () => startFlow(flow.id);
      list.appendChild(btn);
    });
  }

  function renderStep() {
    const content = document.getElementById('odoo-robot-content');
    if (!content) return;

    if (!state.currentFlow) {
      content.innerHTML = '<div class="odoo-robot-empty">Escribe un comando o elige un flujo para comenzar.</div>';
      clearHighlight();
      stopWaitingForClick();
      return;
    }

    const step = state.currentFlow.steps[state.currentStepIndex];
    if (!step) {
      content.innerHTML = '<div class="odoo-robot-empty">Flujo completado ✅</div>';
      clearHighlight();
      stopWaitingForClick();
      return;
    }

    const found = resolveElement(step.selectorCandidates || []);
    highlightElement(found && found.el);

    const fallbackHtml = (step.fallbackText || []).map(t => `<li>${t}</li>`).join('');
    content.innerHTML = `
      <div class="odoo-robot-step-title">${state.currentFlow.title}</div>
      <div class="odoo-robot-step-meta">Paso ${state.currentStepIndex + 1} de ${state.currentFlow.steps.length}: ${step.title}</div>
      <div class="odoo-robot-step-instruction">${step.instruction}</div>
      <div class="odoo-robot-step-match">${found ? `🎯 Selector encontrado: <code>${found.selector}</code>` : '⚠️ No encontré el elemento en pantalla actual.'}</div>
      ${fallbackHtml ? `<ul class="odoo-robot-fallback">${fallbackHtml}</ul>` : ''}
    `;

    if (found && state.waitClickMode) startWaitingForClick(found.el);
    else stopWaitingForClick();
  }

  function startFlow(flowId) {
    const flow = (state.flowsCatalog.flows || []).find(f => f.id === flowId);
    if (!flow) return;
    state.currentFlow = flow;
    state.currentStepIndex = 0;
    renderStep();
  }

  function nextStep() {
    if (!state.currentFlow) return;
    if (state.waitingForClick) return;
    if (state.currentStepIndex < state.currentFlow.steps.length - 1) {
      state.currentStepIndex += 1;
      renderStep();
    } else {
      state.currentStepIndex += 1;
      renderStep();
    }
  }

  function prevStep() {
    if (!state.currentFlow || state.currentStepIndex <= 0) return;
    stopWaitingForClick();
    state.currentStepIndex -= 1;
    renderStep();
  }

  function repeatStep() {
    if (!state.currentFlow) return;
    stopWaitingForClick();
    renderStep();
  }

  function exitFlow() {
    state.currentFlow = null;
    state.currentStepIndex = 0;
    renderStep();
  }

  function handleCommand(raw) {
    const cmd = normalizeText(raw);
    if (!cmd) return;

    const intent = parseIntent(cmd);
    if (!intent) {
      setStatus('No entendí el comando. Prueba: "vender productos" o "devoluciones".');
      return;
    }

    const matches = (state.flowsCatalog.flows || []).filter(f => flowMatchesIntent(f, intent));
    if (!matches.length) {
      setStatus(`No encontré flujos para: ${intent}`);
      return;
    }

    startFlow(matches[0].id);
    setStatus(`▶ Flujo activado: ${matches[0].title}`);
  }

  function buildUI() {
    GM_addStyle(`
      #odoo-robot-btn {
        position: fixed; right: 20px; bottom: 24px; z-index: 999999;
        width: 56px; height: 56px; border-radius: 50%; border: none;
        background: linear-gradient(135deg, #1b8f5a, #28b66e);
        color: #fff; font-size: 26px; cursor: pointer;
        box-shadow: 0 8px 24px rgba(0,0,0,0.22);
      }
      #odoo-robot-panel {
        position: fixed; right: 20px; bottom: 88px; width: 420px; max-height: 80vh;
        background: #fff; border-radius: 14px; overflow: hidden; z-index: 999999;
        box-shadow: 0 15px 40px rgba(0,0,0,0.28); font-family: Inter, Arial, sans-serif;
        display: none;
      }
      #odoo-robot-panel.open { display: block; }
      .odoo-robot-header {
        background: #1b8f5a; color: #fff; padding: 10px 12px; display: flex; align-items: center; justify-content: space-between;
      }
      .odoo-robot-title { font-weight: 700; font-size: 14px; }
      .odoo-robot-body { padding: 10px; display: grid; grid-template-columns: 1fr; gap: 8px; }
      .odoo-robot-controls { display: flex; gap: 6px; flex-wrap: wrap; }
      .odoo-robot-controls button, .odoo-robot-flow-btn {
        border: 1px solid #cdeedc; background: #f5fff9; color: #1b8f5a; border-radius: 8px; padding: 6px 10px; cursor: pointer;
      }
      .odoo-robot-flow-list { max-height: 120px; overflow: auto; display: flex; gap: 6px; flex-wrap: wrap; }
      #odoo-robot-content { border: 1px solid #e7efeb; border-radius: 8px; padding: 8px; min-height: 130px; }
      .odoo-robot-step-title { font-weight: 700; color: #176f46; margin-bottom: 3px; }
      .odoo-robot-step-meta { font-size: 12px; color: #6a7f75; margin-bottom: 8px; }
      .odoo-robot-step-instruction { font-size: 13px; margin-bottom: 6px; }
      .odoo-robot-step-match { font-size: 12px; color: #3c5a4c; }
      .odoo-robot-fallback { margin: 8px 0 0 18px; padding: 0; font-size: 12px; color: #6b6969; }
      .odoo-robot-empty { color: #6b7d74; font-size: 13px; }
      #odoo-robot-input { width: 100%; border: 1px solid #d4e6dc; border-radius: 8px; padding: 8px; }
      #odoo-robot-status { min-height: 18px; font-size: 12px; color: #2f5f48; }
      .odoo-robot-highlight {
        outline: 3px solid #2bbb76 !important;
        box-shadow: 0 0 0 5px rgba(43, 187, 118, 0.25) !important;
        border-radius: 4px;
        transition: all .2s ease;
      }
      .odoo-robot-toggle-row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
    `);

    const btn = document.createElement('button');
    btn.id = 'odoo-robot-btn';
    btn.textContent = '🤖';
    btn.title = 'Odoo Robot Trainer';

    const panel = document.createElement('div');
    panel.id = 'odoo-robot-panel';
    panel.innerHTML = `
      <div class="odoo-robot-header">
        <span class="odoo-robot-title">Robot Trainer · San Jorge</span>
        <label class="odoo-robot-toggle-row">ON/OFF
          <input id="odoo-robot-enabled" type="checkbox" ${state.enabled ? 'checked' : ''}>
        </label>
      </div>
      <div class="odoo-robot-body">
        <div class="odoo-robot-toggle-row">
          <input id="odoo-robot-wait-click" type="checkbox" ${state.waitClickMode ? 'checked' : ''}>
          <label for="odoo-robot-wait-click">Esperando clic para avanzar</label>
        </div>
        <input id="odoo-robot-input" placeholder="Escribe: vender productos / devoluciones / cierre de caja">
        <div class="odoo-robot-controls">
          <button id="odoo-robot-send">Iniciar comando</button>
          <button id="odoo-robot-prev">Anterior</button>
          <button id="odoo-robot-next">Siguiente</button>
          <button id="odoo-robot-repeat">Repetir paso</button>
          <button id="odoo-robot-exit">Salir</button>
        </div>
        <div id="odoo-robot-status"></div>
        <div id="odoo-robot-content"></div>
        <div class="odoo-robot-flow-list" id="odoo-robot-flow-list"></div>
      </div>
    `;

    document.body.appendChild(btn);
    document.body.appendChild(panel);

    if (state.panelOpen) panel.classList.add('open');

    btn.onclick = () => {
      if (!state.enabled) return;
      state.panelOpen = !panel.classList.contains('open');
      panel.classList.toggle('open', state.panelOpen);
      saveState();
    };

    const enabled = panel.querySelector('#odoo-robot-enabled');
    enabled.onchange = () => {
      state.enabled = !!enabled.checked;
      if (!state.enabled) {
        panel.classList.remove('open');
        clearHighlight();
        stopWaitingForClick();
      }
      saveState();
    };

    const waitClick = panel.querySelector('#odoo-robot-wait-click');
    waitClick.onchange = () => {
      state.waitClickMode = !!waitClick.checked;
      saveState();
      renderStep();
    };

    panel.querySelector('#odoo-robot-send').onclick = () => {
      if (!state.enabled) return;
      handleCommand(panel.querySelector('#odoo-robot-input').value);
    };
    panel.querySelector('#odoo-robot-prev').onclick = prevStep;
    panel.querySelector('#odoo-robot-next').onclick = nextStep;
    panel.querySelector('#odoo-robot-repeat').onclick = repeatStep;
    panel.querySelector('#odoo-robot-exit').onclick = exitFlow;

    panel.querySelector('#odoo-robot-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleCommand(e.target.value);
    });
  }

  function loadFlowsViaGM() {
    return new Promise((resolve) => {
      const url = `${AGENT_BASE_URL}/odoo/flows`;
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          onload: (resp) => {
            if (resp.status >= 200 && resp.status < 300) {
              try {
                const parsed = JSON.parse(resp.responseText);
                if (parsed && parsed.flows && parsed.flows.length) return resolve(parsed);
              } catch (_) {}
            }
            resolve(null);
          },
          onerror: () => resolve(null)
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  async function init() {
    buildUI();
    const remote = await loadFlowsViaGM();
    state.flowsCatalog = remote || EMBEDDED_FLOWS;
    renderFlowList();
    renderStep();
    setStatus(remote ? 'Catálogo cargado desde inventory-agent.' : 'Usando catálogo embebido (fallback).');
  }

  init();
})();
