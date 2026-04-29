// ==UserScript==
// @name         Odoo Robot Lite · San Jorge (Transferencia)
// @namespace    https://sanjorge.local/
// @version      1.0.0
// @description  Guía solo el flujo: Transferencia interna a otro punto de venta.
// @match        https://odonessas-sanjorge-v18-develop-31010714.dev.odoo.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function(){
  'use strict';

  const LS_ENABLED = 'sj.robot.lite.enabled';
  const LS_OPEN = 'sj.robot.lite.open';

  const steps = [
    { title:'Paso 1', text:'Haz clic en Inventario.', selectors:["a[data-menu-xmlid='stock.menu_stock_root']", ".o_app[data-menu-xmlid='stock.menu_stock_root']"] },
    { title:'Paso 2', text:'En la barra superior, haz clic en Operaciones.', selectors:["a[data-menu-xmlid='stock.menu_stock_warehouse_mgmt']", "a"] , contains:'Operaciones'},
    { title:'Paso 3', text:'Haz clic en Transferencias internas.', selectors:["a[data-menu-xmlid='stock.menu_stock_internal_transfer']", "a"], contains:'Transferencias internas'},
    { title:'Paso 4', text:'Haz clic en Nuevo (arriba izquierda).', selectors:["button.o_list_button_add", "button"], contains:'Nuevo'},
    { title:'Paso 5', text:'Completa Ubicación origen y destino (punto de venta).', selectors:["div[name='location_id'] input", "div[name='location_dest_id'] input"] },
    { title:'Paso 6', text:'Agrega producto(s) y cantidad(es).', selectors:["td[name='product_id'] input", "td[name='quantity'] input", "a[role='button'][name='add_line']"] },
    { title:'Paso 7', text:'Haz clic en Validar para confirmar transferencia.', selectors:["button[name='button_validate']", "button"], contains:'Validar'}
  ];

  let idx = 0;
  let highlighted = null;

  const style = document.createElement('style');
  style.textContent = `
    #sj-robot-btn{position:fixed;right:20px;bottom:24px;z-index:2147483647;width:56px;height:56px;border-radius:50%;border:none;background:#1b8f5a;color:#fff;font-size:24px;cursor:pointer;box-shadow:0 8px 20px rgba(0,0,0,.25)}
    #sj-robot-panel{position:fixed;right:20px;bottom:88px;width:360px;background:#fff;border-radius:12px;box-shadow:0 14px 30px rgba(0,0,0,.3);z-index:2147483647;display:none;font-family:Arial,sans-serif}
    #sj-robot-panel.open{display:block}
    #sj-robot-head{background:#1b8f5a;color:#fff;padding:10px 12px;border-radius:12px 12px 0 0;font-weight:700;display:flex;justify-content:space-between;align-items:center}
    #sj-robot-body{padding:10px}
    #sj-robot-step{font-weight:700;color:#176f46;margin-bottom:6px}
    #sj-robot-text{font-size:13px;margin-bottom:8px}
    #sj-robot-status{font-size:12px;color:#4f5f58;min-height:16px;margin-bottom:8px}
    #sj-robot-actions{display:flex;gap:6px;flex-wrap:wrap}
    #sj-robot-actions button{border:1px solid #cdeedc;background:#f5fff9;color:#1b8f5a;border-radius:8px;padding:6px 10px;cursor:pointer}
    .sj-highlight{outline:3px solid #2bbb76 !important;box-shadow:0 0 0 5px rgba(43,187,118,.25) !important;border-radius:4px}
  `;
  document.head.appendChild(style);

  const btn = document.createElement('button');
  btn.id='sj-robot-btn'; btn.textContent='🤖'; btn.title='Robot San Jorge';

  const panel = document.createElement('div');
  panel.id='sj-robot-panel';
  panel.innerHTML = `
    <div id="sj-robot-head">Robot San Jorge <label style="font-size:12px;font-weight:400">ON <input id="sj-enabled" type="checkbox"></label></div>
    <div id="sj-robot-body">
      <div id="sj-robot-step"></div>
      <div id="sj-robot-text"></div>
      <div id="sj-robot-status">Autorizado solo para: transferencia interna a otro punto de venta</div>
      <div id="sj-robot-actions">
        <button id="sj-prev">Anterior</button>
        <button id="sj-next">Siguiente</button>
        <button id="sj-find">Encontrar botón</button>
        <button id="sj-close">Cerrar</button>
      </div>
    </div>`;

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  function clearHighlight(){ if(highlighted){ highlighted.classList.remove('sj-highlight'); highlighted=null; } }
  function findTarget(step){
    for(const sel of step.selectors||[]){
      const list = Array.from(document.querySelectorAll(sel));
      if(!list.length) continue;
      if(step.contains){
        const found = list.find(el => (el.textContent||'').toLowerCase().includes(step.contains.toLowerCase()));
        if(found) return found;
      } else {
        return list[0];
      }
    }
    return null;
  }
  function render(){
    const s = steps[idx];
    document.getElementById('sj-robot-step').textContent = `${s.title} (${idx+1}/${steps.length})`;
    document.getElementById('sj-robot-text').textContent = s.text;
    clearHighlight();
  }
  function highlightCurrent(){
    const s=steps[idx];
    const el=findTarget(s);
    const status=document.getElementById('sj-robot-status');
    if(!el){ status.textContent='No encontré el botón automáticamente. Sigue la instrucción visual.'; return; }
    highlighted=el; highlighted.classList.add('sj-highlight');
    highlighted.scrollIntoView({behavior:'smooth', block:'center'});
    status.textContent='Encontrado ✅. Haz clic en el elemento resaltado.';
  }

  btn.onclick=()=>{ if(localStorage.getItem(LS_ENABLED)==='0') return; panel.classList.toggle('open'); localStorage.setItem(LS_OPEN,panel.classList.contains('open')?'1':'0'); render(); };
  document.getElementById('sj-prev').onclick=()=>{ idx=Math.max(0,idx-1); render(); };
  document.getElementById('sj-next').onclick=()=>{ idx=Math.min(steps.length-1,idx+1); render(); };
  document.getElementById('sj-find').onclick=()=>highlightCurrent();
  document.getElementById('sj-close').onclick=()=>panel.classList.remove('open');

  const enabled = localStorage.getItem(LS_ENABLED)!=='0';
  const chk = document.getElementById('sj-enabled'); chk.checked=enabled;
  chk.onchange=()=>{ localStorage.setItem(LS_ENABLED, chk.checked?'1':'0'); btn.style.display=chk.checked?'block':'none'; if(!chk.checked) panel.classList.remove('open'); };
  btn.style.display=enabled?'block':'none';

  if(localStorage.getItem(LS_OPEN)==='1' && enabled){ panel.classList.add('open'); render(); }
})();