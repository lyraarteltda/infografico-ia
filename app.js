/**
 * Infográfico IA — Main Application Logic
 *
 * Flow: briefing → LLM → strict JSON schema → deterministic infographic RENDER
 * (5 layout types × 4 visual themes, brand-colorable) → PNG export
 * (SVG foreignObject → canvas, SYSTEM fonts inline → no taint) + copy(md) +
 * localStorage library.
 *
 * BYOK: the user's OWN key (OpenRouter preferred, OpenAI native) — localStorage
 * only, never sent to our backend (Hard Rule #1).
 *
 * Resilience (proven CORs): reasoning:{effort:'low'} on OpenRouter EXCEPT
 * deepseek/* (COR-034/035) + empty-content retry-without-reasoning (COR-035) +
 * JSON auto-reroll stricter+cooler (COR-032) + repair ladder + clean()
 * null-string normalizer (COR-015). Init via 3 idempotent triggers incl.
 * MutationObserver on #app-screen (COR-044).
 */
(function () {
  'use strict';

  // ================= tiny utils =================
  function $(id) { return document.getElementById(id); }
  function clean(v) {
    if (v === null || v === undefined) return '';
    var s = String(v).trim();
    if (/^(null|undefined|n\/a|na|-|—)$/i.test(s)) return '';
    return s;
  }
  function arr(v) {
    if (!v) return [];
    if (!Array.isArray(v)) v = [v];
    return v.map(clean).filter(Boolean);
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function slug(s) {
    return clean(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'infografico';
  }
  function toast(msg, isErr) {
    var t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'show' + (isErr ? ' err' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = ''; }, isErr ? 4200 : 2600);
  }

  // ================= color helpers (deterministic render) =================
  function hexToRgb(h) {
    h = String(h || '').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) h = '2036c9';
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  function rgbToHex(r, g, b) {
    function c(x) { return ('0' + Math.round(Math.max(0, Math.min(255, x))).toString(16)).slice(-2); }
    return '#' + c(r) + c(g) + c(b);
  }
  function mix(hex, other, amt) {
    var a = hexToRgb(hex), b = hexToRgb(other);
    return rgbToHex(a.r + (b.r - a.r) * amt, a.g + (b.g - a.g) * amt, a.b + (b.b - a.b) * amt);
  }
  function luminance(hex) {
    var c = hexToRgb(hex);
    var f = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function onColor(hex) { return luminance(hex) > 0.5 ? '#141414' : '#ffffff'; }
  function normalizeHex(h) {
    h = String(h || '').trim();
    if (!/^#/.test(h)) h = '#' + h;
    if (!/^#[0-9a-fA-F]{6}$/.test(h)) return '#2036c9';
    return h.toLowerCase();
  }

  function palette(theme, accent) {
    accent = normalizeHex(accent);
    var on = onColor(accent);
    var tint = mix(accent, '#ffffff', 0.9);
    var tintStrong = mix(accent, '#ffffff', 0.78);
    if (theme === 'escuro') {
      return {
        bg: '#14161c', panel: '#1e212b', ink: '#f3f3f6', muted: '#aeaebb', dim: '#7c7c88',
        divider: '#2b2f3a', accent: accent, accentText: on,
        headBg: accent, headText: on, chipBg: mix(accent, '#14161c', 0.55),
        tint: mix(accent, '#14161c', 0.74), stroke: '#2b2f3a', minimal: false
      };
    }
    if (theme === 'bold') {
      return {
        bg: '#ffffff', panel: tint, ink: '#161620', muted: '#4a4a55', dim: '#7a7a86',
        divider: tintStrong, accent: accent, accentText: on,
        headBg: accent, headText: on, chipBg: accent, tint: tint, stroke: tintStrong, bold: true, minimal: false
      };
    }
    if (theme === 'minimal') {
      return {
        bg: '#ffffff', panel: '#ffffff', ink: '#17181c', muted: '#5a5a63', dim: '#8a8a92',
        divider: '#e6e6ea', accent: accent, accentText: on,
        headBg: '#ffffff', headText: '#17181c', chipBg: '#f4f4f6', tint: '#fafafb', stroke: '#e6e6ea', minimal: true
      };
    }
    // moderno (default)
    return {
      bg: '#ffffff', panel: '#f6f7fb', ink: '#1a1a24', muted: '#54545f', dim: '#87878f',
      divider: '#e8e9ef', accent: accent, accentText: on,
      headBg: accent, headText: on, chipBg: tint, tint: tint, stroke: '#e8e9ef', minimal: false
    };
  }

  var TIPO_LABEL = {
    lista: 'Lista', passos: 'Passo a passo', estatisticas: 'Estatísticas',
    comparacao: 'Comparação', linha_do_tempo: 'Linha do tempo'
  };
  var VALID_TIPOS = ['lista', 'passos', 'estatisticas', 'comparacao', 'linha_do_tempo'];
  var ASPECT_MINH = { portrait: 1350, square: 1080, story: 1920 };

  // ================= state =================
  var wired = false;
  var currentData = null;   // last generated JSON
  var currentOpts = null;   // { tema, tipo, tom, theme, accent, aspect, model }
  var LIB_KEY = 'infografico-ia_library_v1';

  // ================= chip groups =================
  function chipVal(groupId) {
    var g = $(groupId);
    if (!g) return '';
    var a = g.querySelector('.chip.active');
    return a ? a.getAttribute('data-val') : '';
  }
  function wireChips(groupId, onChange) {
    var g = $(groupId);
    if (!g) return;
    function activate(chip) {
      if (g.getAttribute('data-single')) g.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('active'); });
      chip.classList.add('active');
      if (onChange) onChange(chip.getAttribute('data-val'));
    }
    g.querySelectorAll('.chip').forEach(function (chip) {
      chip.addEventListener('click', function () { activate(chip); });
      chip.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(chip); }
      });
    });
  }

  // ================= LLM plumbing =================
  function activeKey() { return window.ApiKeyManager ? ApiKeyManager.getActiveKey() : null; }

  function friendlyHttp(status, body) {
    var detail = '';
    try { var j = JSON.parse(body); detail = (j.error && (j.error.message || j.error)) || j.message || ''; } catch (_) {}
    if (status === 401) return 'Chave inválida ou expirada. Verifique em Gerenciar chaves.';
    if (status === 402) return 'Créditos insuficientes na sua chave. Adicione créditos ou escolha um modelo do grupo Grátis.';
    if (status === 403) return 'Acesso negado pelo provedor. ' + (detail || 'Verifique permissões/faturamento da sua chave.');
    if (status === 429) return 'Muitas requisições ou limite atingido. Aguarde alguns segundos e tente de novo.';
    if (status >= 500) return 'O provedor de IA está instável agora. Tente novamente em instantes.';
    return 'Erro do provedor (' + status + ')' + (detail ? ': ' + detail : '') + '.';
  }

  // one round-trip; rejects with {emptyContent:true} on empty content
  function fetchContent(messages, active, temperature, noReasoning) {
    var model = ApiKeyManager.getModel();
    var url, headers, body;
    if (active.service === 'openrouter') {
      url = 'https://openrouter.ai/api/v1/chat/completions';
      headers = {
        'Authorization': 'Bearer ' + active.key,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://infograficoia.maestrosdaia.com',
        'X-Title': 'Infografico IA'
      };
      body = { model: model, messages: messages, temperature: temperature, max_tokens: 4000 };
      var isDeepSeek = model.indexOf('deepseek/') === 0;             // COR-035
      if (!noReasoning && !isDeepSeek) body.reasoning = { effort: 'low' }; // COR-034
    } else {
      url = 'https://api.openai.com/v1/chat/completions';
      headers = { 'Authorization': 'Bearer ' + active.key, 'Content-Type': 'application/json' };
      var oaModel = (model.indexOf('openai/') === 0) ? model.slice(7) : 'gpt-5.5';
      body = { model: oaModel, messages: messages, temperature: temperature, max_tokens: 4000 };
    }
    return fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) })
      .then(function (res) {
        return res.text().then(function (txt) {
          if (!res.ok) { var e = new Error(friendlyHttp(res.status, txt)); e.status = res.status; throw e; }
          var data;
          try { data = JSON.parse(txt); } catch (_) { throw new Error('Resposta inesperada do provedor.'); }
          var choice = (data.choices && data.choices[0]) || {};
          var content = choice.message && choice.message.content;
          if (!content || !String(content).trim()) { var e2 = new Error('Resposta vazia do modelo.'); e2.emptyContent = true; throw e2; }
          return String(content);
        });
      });
  }

  // empty-content retry-without-reasoning net (COR-035)
  function fetchResilient(messages, active, temperature) {
    return fetchContent(messages, active, temperature, false).catch(function (e) {
      if (e && e.emptyContent && active.service === 'openrouter') return fetchContent(messages, active, temperature, true);
      throw e;
    });
  }

  // ---------- JSON repair ladder ----------
  function stripToObject(s) {
    s = s.replace(/```json/gi, '').replace(/```/g, '');
    var i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i >= 0 && j > i) s = s.slice(i, j + 1);
    return s.trim();
  }
  function tryParse(s) { try { return JSON.parse(s); } catch (_) { return null; } }
  function repairJSON(raw) {
    var cand = stripToObject(raw);
    var out = tryParse(cand); if (out) return out;
    var c2 = cand.replace(/,(\s*[}\]])/g, '$1');
    out = tryParse(c2); if (out) return out;
    var c3 = c2.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[\x00-\x1f]+/g, ' ');
    out = tryParse(c3); if (out) return out;
    return null;
  }

  // COR-032: auto-reroll once (stricter, cooler) on parse failure before erroring
  function generateJSON(messages, active) {
    return RateLimiter.executeWithLimit('infografico-generate', function () {
      return fetchResilient(messages, active, 0.8).then(function (text) {
        var obj = repairJSON(text);
        if (obj) return obj;
        var strict = messages.concat([{
          role: 'user',
          content: 'Sua resposta anterior NÃO era um JSON válido. Responda NOVAMENTE apenas com o objeto JSON pedido, com aspas retas ("), sem markdown, sem comentários e sem texto fora do JSON.'
        }]);
        return fetchResilient(strict, active, 0.4).then(function (t2) {
          var o2 = repairJSON(t2);
          if (o2) return o2;
          throw new Error('O modelo não devolveu um JSON válido. Tente gerar novamente.');
        });
      });
    });
  }

  // ================= prompt =================
  function buildMessages(opts) {
    var sys = [
      'Você é um designer de informação e redator sênior, especialista em transformar conteúdo em infográficos claros, densos em informação e prontos para redes sociais no mercado brasileiro.',
      'Escreva SEMPRE em português do Brasil, com textos CURTOS, concretos e escaneáveis — títulos de 2 a 6 palavras e descrições de no máximo 1 frase (até ~110 caracteres).',
      'Nada de encher linguiça: cada item precisa carregar informação real e específica.',
      'Responda EXCLUSIVAMENTE com um objeto JSON válido no schema pedido — sem markdown, sem comentários, sem texto fora do JSON.'
    ].join(' ');

    var tipo = opts.tipo;
    var tipoInstr;
    if (tipo === 'auto') {
      tipoInstr = 'Escolha o MELHOR tipo para este conteúdo entre: "lista", "passos", "estatisticas", "comparacao", "linha_do_tempo". Defina o campo "tipo" com o que escolher.';
    } else {
      tipoInstr = 'O campo "tipo" DEVE ser exatamente "' + tipo + '".';
    }

    var schema = [
      '{',
      '  "titulo": "título forte e curto do infográfico (até 8 palavras)",',
      '  "subtitulo": "1 linha de contexto/gancho (até ~90 caracteres)",',
      '  "tipo": "lista | passos | estatisticas | comparacao | linha_do_tempo",',
      '  "itens": [',
      '    { "chave": "rótulo curto do item — para estatisticas o NÚMERO/estatística (ex: \'73%\', \'3x\', \'R$ 2 mil\'); para passos o número (\'1\'); para linha_do_tempo o marco (\'2019\', \'Fase 1\'); para lista pode ficar vazio", "titulo": "título do item (2-6 palavras)", "texto": "1 frase curta de descrição (até ~110 caracteres)" }',
      '  ],',
      '  "comparacao": { "a_nome": "nome do lado A", "b_nome": "nome do lado B", "linhas": [ { "criterio": "critério comparado (curto)", "a": "valor do lado A (curto)", "b": "valor do lado B (curto)" } ] },',
      '  "rodape": "fonte, @perfil ou chamada curta para o rodapé (até ~60 caracteres)"',
      '}'
    ].join('\n');

    var ask = [
      'CONTEÚDO / TEMA:',
      opts.tema,
      '',
      'Tom de linguagem: ' + opts.tom + '.',
      tipoInstr,
      'Gere de 4 a 6 itens (para "comparacao", de 4 a 6 linhas em "comparacao.linhas").',
      'Regras por tipo:',
      '- lista: "itens" com titulo + texto (chave pode ficar vazia).',
      '- passos: "itens" em ORDEM, "chave" = número do passo ("1","2",...).',
      '- estatisticas: "itens" com "chave" = a estatística/número em destaque e "titulo"/"texto" explicando.',
      '- comparacao: preencha o objeto "comparacao" (a_nome, b_nome, linhas) e deixe "itens" como lista vazia.',
      '- linha_do_tempo: "itens" em ordem cronológica, "chave" = o marco (ano/fase).',
      'Se o tipo NÃO for "comparacao", ainda inclua "comparacao" como {"a_nome":"","b_nome":"","linhas":[]}.',
      'Preencha TODOS os campos aplicáveis. Textos curtos e específicos.',
      '',
      'Responda apenas com o JSON neste schema:',
      schema
    ].join('\n');

    return [{ role: 'system', content: sys }, { role: 'user', content: ask }];
  }

  // ================= normalize model output =================
  function normalizeData(raw, opts) {
    var d = raw || {};
    var tipo = clean(d.tipo).toLowerCase().replace(/[\s-]+/g, '_');
    if (VALID_TIPOS.indexOf(tipo) < 0) tipo = (opts.tipo !== 'auto' && VALID_TIPOS.indexOf(opts.tipo) >= 0) ? opts.tipo : 'lista';

    var itens = Array.isArray(d.itens) ? d.itens : [];
    itens = itens.map(function (it) {
      it = it || {};
      return { chave: clean(it.chave || it.numero || it.valor || it.marco), titulo: clean(it.titulo || it.title), texto: clean(it.texto || it.descricao || it.desc) };
    }).filter(function (it) { return it.titulo || it.texto || it.chave; }).slice(0, 6);

    var comp = d.comparacao || {};
    var linhas = Array.isArray(comp.linhas) ? comp.linhas : [];
    linhas = linhas.map(function (l) {
      l = l || {};
      return { criterio: clean(l.criterio || l.criterion), a: clean(l.a), b: clean(l.b) };
    }).filter(function (l) { return l.criterio || l.a || l.b; }).slice(0, 6);

    var out = {
      titulo: clean(d.titulo) || clean(opts.tema).slice(0, 60) || 'Infográfico',
      subtitulo: clean(d.subtitulo),
      tipo: tipo,
      itens: itens,
      comparacao: { a_nome: clean(comp.a_nome), b_nome: clean(comp.b_nome), linhas: linhas },
      rodape: clean(d.rodape)
    };
    // guard: comparacao needs at least the two names + rows; otherwise fall back to lista
    if (out.tipo === 'comparacao' && (!out.comparacao.linhas.length)) out.tipo = out.itens.length ? 'lista' : 'comparacao';
    if (out.tipo !== 'comparacao' && !out.itens.length && out.comparacao.linhas.length) out.tipo = 'comparacao';
    return out;
  }

  // ================= RENDER (deterministic infographic) =================
  var W = 1080;

  function styleStr(o) {
    return Object.keys(o).map(function (k) { return k + ':' + o[k]; }).join(';');
  }

  function buildSheet(data, opts) {
    var p = palette(opts.theme, opts.accent);
    var minH = ASPECT_MINH[opts.aspect] || ASPECT_MINH.portrait;
    var pad = 66;

    var sheet = document.createElement('div');
    sheet.style.cssText = styleStr({
      width: W + 'px', 'min-height': minH + 'px', background: p.bg, color: p.ink,
      'font-family': '-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif',
      display: 'flex', 'flex-direction': 'column', overflow: 'hidden',
      'box-sizing': 'border-box', position: 'relative'
    });

    sheet.appendChild(buildHeader(data, opts, p, pad));

    var bodyWrap = document.createElement('div');
    bodyWrap.style.cssText = styleStr({ flex: '1', padding: pad + 'px', 'padding-top': '52px', 'padding-bottom': '40px', display: 'flex', 'flex-direction': 'column' });
    bodyWrap.innerHTML = renderBody(data, p);
    sheet.appendChild(bodyWrap);

    sheet.appendChild(buildFooter(data, opts, p, pad));
    return sheet;
  }

  function buildHeader(data, opts, p, pad) {
    var h = document.createElement('div');
    var kicker = TIPO_LABEL[data.tipo] || 'Infográfico';
    if (p.minimal) {
      h.style.cssText = styleStr({ padding: pad + 'px', 'padding-bottom': '30px', background: p.headBg, 'border-bottom': '3px solid ' + p.accent });
      h.innerHTML =
        '<div style="' + styleStr({ font: '700 22px/1 ui-monospace,Menlo,monospace', color: p.accent, 'letter-spacing': '3px', 'text-transform': 'uppercase', 'margin-bottom': '20px', display: 'flex', 'align-items': 'center', gap: '12px' }) + '">' +
          '<span style="' + styleStr({ width: '26px', height: '26px', background: p.accent, display: 'inline-block' }) + '"></span>' + esc(kicker) +
        '</div>' +
        '<div style="' + styleStr({ font: '800 62px/1.02 -apple-system,Helvetica,Arial,sans-serif', color: p.ink, 'letter-spacing': '-0.02em' }) + '">' + esc(data.titulo) + '</div>' +
        (data.subtitulo ? '<div style="' + styleStr({ 'margin-top': '18px', font: '400 28px/1.4 -apple-system,Helvetica,Arial,sans-serif', color: p.muted, 'max-width': '860px' }) + '">' + esc(data.subtitulo) + '</div>' : '');
      return h;
    }
    h.style.cssText = styleStr({ padding: pad + 'px', 'padding-top': '58px', 'padding-bottom': '46px', background: p.headBg, color: p.headText, position: 'relative' });
    h.innerHTML =
      '<div style="' + styleStr({ display: 'inline-block', font: '700 21px/1 ui-monospace,Menlo,monospace', 'letter-spacing': '3px', 'text-transform': 'uppercase', color: p.headText, opacity: '0.85', border: '2px solid ' + hexA(p.headText, 0.5), 'border-radius': '4px', padding: '7px 14px', 'margin-bottom': '26px' }) + '">' + esc(kicker) + '</div>' +
      '<div style="' + styleStr({ font: '800 66px/1.02 -apple-system,Helvetica,Arial,sans-serif', 'letter-spacing': '-0.02em', color: p.headText }) + '">' + esc(data.titulo) + '</div>' +
      (data.subtitulo ? '<div style="' + styleStr({ 'margin-top': '20px', font: '400 29px/1.4 -apple-system,Helvetica,Arial,sans-serif', color: hexA(p.headText, 0.9), 'max-width': '880px' }) + '">' + esc(data.subtitulo) + '</div>' : '');
    return h;
  }

  function buildFooter(data, opts, p, pad) {
    var f = document.createElement('div');
    f.style.cssText = styleStr({
      display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', gap: '16px',
      padding: (pad - 16) + 'px ' + pad + 'px', 'border-top': '2px solid ' + p.divider,
      background: p.minimal ? '#ffffff' : (opts.theme === 'escuro' ? '#0f1116' : mix(p.bg, p.accent, 0.03))
    });
    var left = data.rodape
      ? '<div style="' + styleStr({ font: '600 24px/1.3 -apple-system,Helvetica,Arial,sans-serif', color: p.muted }) + '">' + esc(data.rodape) + '</div>'
      : '<div style="' + styleStr({ font: '700 22px/1 ui-monospace,Menlo,monospace', color: p.accent, 'letter-spacing': '1px' }) + '">MAESTROS DA IA</div>';
    f.innerHTML = left +
      '<div style="' + styleStr({ display: 'flex', 'align-items': 'center', gap: '12px' }) + '">' +
        '<div style="' + styleStr({ display: 'flex', gap: '5px', 'align-items': 'flex-end' }) + '">' +
          '<span style="' + styleStr({ width: '9px', height: '16px', background: p.accent, display: 'inline-block' }) + '"></span>' +
          '<span style="' + styleStr({ width: '9px', height: '26px', background: p.accent, display: 'inline-block' }) + '"></span>' +
          '<span style="' + styleStr({ width: '9px', height: '20px', background: p.accent, display: 'inline-block' }) + '"></span>' +
        '</div>' +
        '<span style="' + styleStr({ font: '600 20px/1 ui-monospace,Menlo,monospace', color: p.dim, 'letter-spacing': '0.5px' }) + '">feito com Infográfico IA</span>' +
      '</div>';
    return f;
  }

  function hexA(hex, a) {
    var c = hexToRgb(hex);
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')';
  }

  function renderBody(data, p) {
    switch (data.tipo) {
      case 'estatisticas': return renderStats(data.itens, p);
      case 'passos': return renderSteps(data.itens, p);
      case 'comparacao': return renderComparison(data.comparacao, p);
      case 'linha_do_tempo': return renderTimeline(data.itens, p);
      default: return renderList(data.itens, p);
    }
  }

  function itemText(it, p, big) {
    return it.texto ? '<div style="' + styleStr({ 'margin-top': '8px', font: '400 ' + (big ? 25 : 24) + 'px/1.42 -apple-system,Helvetica,Arial,sans-serif', color: p.muted }) + '">' + esc(it.texto) + '</div>' : '';
  }

  function renderList(itens, p) {
    var rows = itens.map(function (it, i) {
      return '<div style="' + styleStr({ display: 'flex', gap: '24px', 'align-items': 'flex-start', background: p.panel, border: '2px solid ' + p.stroke, 'border-radius': '14px', padding: '26px 28px' }) + '">' +
        '<div style="' + styleStr({ flex: 'none', width: '54px', height: '54px', 'border-radius': '12px', background: p.accent, color: p.accentText, display: 'flex', 'align-items': 'center', 'justify-content': 'center', font: '800 28px/1 -apple-system,Helvetica,Arial,sans-serif' }) + '">' + (i + 1) + '</div>' +
        '<div style="' + styleStr({ flex: '1', 'min-width': '0' }) + '">' +
          '<div style="' + styleStr({ font: '800 32px/1.15 -apple-system,Helvetica,Arial,sans-serif', color: p.ink }) + '">' + esc(it.titulo || it.chave) + '</div>' +
          itemText(it, p) +
        '</div></div>';
    }).join('');
    return '<div style="' + styleStr({ display: 'flex', 'flex-direction': 'column', gap: '20px' }) + '">' + rows + '</div>';
  }

  function renderSteps(itens, p) {
    var rows = itens.map(function (it, i) {
      var last = i === itens.length - 1;
      var num = it.chave && /\d/.test(it.chave) ? it.chave : String(i + 1);
      return '<div style="' + styleStr({ display: 'flex', gap: '26px', 'align-items': 'stretch' }) + '">' +
        '<div style="' + styleStr({ flex: 'none', display: 'flex', 'flex-direction': 'column', 'align-items': 'center' }) + '">' +
          '<div style="' + styleStr({ width: '64px', height: '64px', 'border-radius': '50%', background: p.accent, color: p.accentText, display: 'flex', 'align-items': 'center', 'justify-content': 'center', font: '800 30px/1 -apple-system,Helvetica,Arial,sans-serif' }) + '">' + esc(num) + '</div>' +
          (last ? '' : '<div style="' + styleStr({ width: '4px', flex: '1', background: p.divider, 'margin-top': '6px' }) + '"></div>') +
        '</div>' +
        '<div style="' + styleStr({ flex: '1', 'min-width': '0', background: p.panel, border: '2px solid ' + p.stroke, 'border-radius': '14px', padding: '24px 28px', 'margin-bottom': last ? '0' : '10px' }) + '">' +
          '<div style="' + styleStr({ font: '800 32px/1.15 -apple-system,Helvetica,Arial,sans-serif', color: p.ink }) + '">' + esc(it.titulo) + '</div>' +
          itemText(it, p) +
        '</div></div>';
    }).join('');
    return '<div style="' + styleStr({ display: 'flex', 'flex-direction': 'column', gap: '4px' }) + '">' + rows + '</div>';
  }

  function renderStats(itens, p) {
    var two = itens.length > 3;
    var cards = itens.map(function (it) {
      return '<div style="' + styleStr({ background: p.panel, border: '2px solid ' + p.stroke, 'border-radius': '16px', padding: '30px 30px', display: 'flex', 'flex-direction': 'column', gap: '6px' }) + '">' +
        '<div style="' + styleStr({ font: '800 78px/1 -apple-system,Helvetica,Arial,sans-serif', color: p.accent, 'letter-spacing': '-0.03em' }) + '">' + esc(it.chave || '•') + '</div>' +
        '<div style="' + styleStr({ font: '800 28px/1.2 -apple-system,Helvetica,Arial,sans-serif', color: p.ink, 'margin-top': '10px' }) + '">' + esc(it.titulo) + '</div>' +
        (it.texto ? '<div style="' + styleStr({ font: '400 23px/1.4 -apple-system,Helvetica,Arial,sans-serif', color: p.muted, 'margin-top': '4px' }) + '">' + esc(it.texto) + '</div>' : '') +
      '</div>';
    }).join('');
    return '<div style="' + styleStr({ display: 'grid', 'grid-template-columns': two ? '1fr 1fr' : '1fr', gap: '22px' }) + '">' + cards + '</div>';
  }

  function renderTimeline(itens, p) {
    var rows = itens.map(function (it, i) {
      var last = i === itens.length - 1;
      return '<div style="' + styleStr({ display: 'flex', gap: '26px', 'align-items': 'stretch' }) + '">' +
        '<div style="' + styleStr({ flex: 'none', width: '150px', 'text-align': 'right', 'padding-top': '4px' }) + '">' +
          '<div style="' + styleStr({ font: '800 34px/1 -apple-system,Helvetica,Arial,sans-serif', color: p.accent }) + '">' + esc(it.chave || (i + 1)) + '</div>' +
        '</div>' +
        '<div style="' + styleStr({ flex: 'none', display: 'flex', 'flex-direction': 'column', 'align-items': 'center' }) + '">' +
          '<div style="' + styleStr({ width: '22px', height: '22px', 'border-radius': '50%', background: p.accent, border: '4px solid ' + p.bg, 'box-shadow': '0 0 0 3px ' + p.accent }) + '"></div>' +
          (last ? '' : '<div style="' + styleStr({ width: '4px', flex: '1', background: p.divider, 'margin-top': '4px' }) + '"></div>') +
        '</div>' +
        '<div style="' + styleStr({ flex: '1', 'min-width': '0', background: p.panel, border: '2px solid ' + p.stroke, 'border-radius': '14px', padding: '22px 26px', 'margin-bottom': last ? '0' : '18px' }) + '">' +
          '<div style="' + styleStr({ font: '800 30px/1.15 -apple-system,Helvetica,Arial,sans-serif', color: p.ink }) + '">' + esc(it.titulo) + '</div>' +
          itemText(it, p) +
        '</div></div>';
    }).join('');
    return '<div style="' + styleStr({ display: 'flex', 'flex-direction': 'column', gap: '2px' }) + '">' + rows + '</div>';
  }

  function renderComparison(c, p) {
    var head =
      '<div style="' + styleStr({ display: 'grid', 'grid-template-columns': '1.1fr 1fr 1fr', gap: '0', 'border-radius': '14px 14px 0 0', overflow: 'hidden' }) + '">' +
        '<div style="' + styleStr({ background: p.panel, padding: '22px 24px', font: '700 22px/1 ui-monospace,Menlo,monospace', color: p.dim, 'text-transform': 'uppercase', 'letter-spacing': '1px', 'align-self': 'center' }) + '">Critério</div>' +
        '<div style="' + styleStr({ background: p.accent, color: p.accentText, padding: '22px 24px', font: '800 30px/1.1 -apple-system,Helvetica,Arial,sans-serif', 'text-align': 'center' }) + '">' + esc(c.a_nome || 'Opção A') + '</div>' +
        '<div style="' + styleStr({ background: mix(p.accent, '#000000', 0.28), color: onColor(mix(p.accent, '#000000', 0.28)), padding: '22px 24px', font: '800 30px/1.1 -apple-system,Helvetica,Arial,sans-serif', 'text-align': 'center' }) + '">' + esc(c.b_nome || 'Opção B') + '</div>' +
      '</div>';
    var rows = c.linhas.map(function (l, i) {
      var zebra = i % 2 ? p.tint : p.bg;
      return '<div style="' + styleStr({ display: 'grid', 'grid-template-columns': '1.1fr 1fr 1fr', gap: '0', background: zebra, 'border-bottom': '1px solid ' + p.divider }) + '">' +
        '<div style="' + styleStr({ padding: '20px 24px', font: '700 25px/1.3 -apple-system,Helvetica,Arial,sans-serif', color: p.ink }) + '">' + esc(l.criterio) + '</div>' +
        '<div style="' + styleStr({ padding: '20px 24px', font: '400 24px/1.35 -apple-system,Helvetica,Arial,sans-serif', color: p.muted, 'text-align': 'center', 'border-left': '1px solid ' + p.divider }) + '">' + esc(l.a) + '</div>' +
        '<div style="' + styleStr({ padding: '20px 24px', font: '400 24px/1.35 -apple-system,Helvetica,Arial,sans-serif', color: p.muted, 'text-align': 'center', 'border-left': '1px solid ' + p.divider }) + '">' + esc(l.b) + '</div>' +
      '</div>';
    }).join('');
    return '<div style="' + styleStr({ border: '2px solid ' + p.stroke, 'border-radius': '16px', overflow: 'hidden' }) + '">' + head + rows + '</div>';
  }

  // ================= preview =================
  function showStage(html) { $('stage-body').innerHTML = html; }

  // Refit the printed sheet to the available press-bed width (also on window resize).
  function fitPreview() {
    var wrap = document.querySelector('#stage-body .press-bed');
    var sw = wrap && wrap.querySelector('.sheet-wrap');
    var scaleBox = $('ig-scale');
    var node = $('ig-node');
    if (!wrap || !sw || !scaleBox || !node || !node.firstChild) return;
    var avail = wrap.clientWidth - 52; // press-bed padding
    if (avail < 120) avail = ($('stage-body').clientWidth || 320) - 20;
    var s = Math.min(1, avail / W);
    // measure unscaled height: neutralise transform first
    scaleBox.style.transform = 'none';
    var natH = node.firstChild.getBoundingClientRect().height;
    scaleBox.style.transform = 'scale(' + s + ')';
    sw.style.width = (W * s) + 'px';
    sw.style.height = (natH * s) + 'px';
  }

  var _fitTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(_fitTimer);
    _fitTimer = setTimeout(fitPreview, 150);
  });

  function renderPreview(data, opts) {
    var sheet = buildSheet(data, opts);
    var wrap = document.createElement('div');
    wrap.className = 'press-bed';
    var sw = document.createElement('div');
    sw.className = 'sheet-wrap';
    var scaleBox = document.createElement('div');
    scaleBox.id = 'ig-scale';
    scaleBox.style.cssText = 'transform-origin:top left;width:' + W + 'px;';
    var node = document.createElement('div');
    node.id = 'ig-node';
    node.appendChild(sheet);
    scaleBox.appendChild(node);
    sw.appendChild(scaleBox);
    wrap.appendChild(sw);
    var body = $('stage-body');
    body.innerHTML = '';
    body.appendChild(wrap);
    requestAnimationFrame(fitPreview);
    return node;
  }

  // ================= export =================
  function renderToCanvas(sheetNode, scale) {
    return new Promise(function (resolve, reject) {
      try {
        var clone = sheetNode.cloneNode(true);
        // measure at natural width offscreen
        var holder = document.createElement('div');
        holder.style.cssText = 'position:fixed;left:-99999px;top:0;width:' + W + 'px;';
        holder.appendChild(clone);
        document.body.appendChild(holder);
        var h = Math.ceil(clone.getBoundingClientRect().height);
        document.body.removeChild(holder);
        if (!h) h = 1350;

        var xhtml = new XMLSerializer().serializeToString(clone);
        var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + h + '">' +
          '<foreignObject width="100%" height="100%">' +
          '<div xmlns="http://www.w3.org/1999/xhtml">' + xhtml + '</div>' +
          '</foreignObject></svg>';
        var svgUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        var img = new Image();
        img.onload = function () {
          var canvas = document.createElement('canvas');
          canvas.width = W * scale; canvas.height = h * scale;
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.setTransform(scale, 0, 0, scale, 0, 0);
          ctx.drawImage(img, 0, 0);
          resolve(canvas);
        };
        img.onerror = function () { reject(new Error('img')); };
        img.src = svgUrl;
      } catch (e) { reject(e); }
    });
  }

  function exportPNG() {
    var node = $('ig-node');
    if (!node || !node.firstChild) { toast('Gere um infográfico primeiro.', true); return; }
    toast('Renderizando PNG...');
    renderToCanvas(node.firstChild, 2).then(function (canvas) {
      canvas.toBlob(function (blob) {
        if (!blob) { toast('Não foi possível exportar. Tente copiar o texto.', true); return; }
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'infografico-' + slug(currentData && currentData.titulo) + '.png';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
        toast('Infográfico baixado em PNG.');
      }, 'image/png');
    }).catch(function () { toast('Não foi possível gerar a imagem. Tente copiar o texto.', true); });
  }

  function makeThumb() {
    var node = $('ig-node');
    if (!node || !node.firstChild) return Promise.resolve('');
    return renderToCanvas(node.firstChild, 0.34).then(function (canvas) {
      try { return canvas.toDataURL('image/jpeg', 0.7); } catch (_) { return ''; }
    }).catch(function () { return ''; });
  }

  // ================= copy text =================
  function dataToText(d) {
    var L = [];
    L.push('# ' + (d.titulo || 'Infográfico'));
    if (d.subtitulo) { L.push(''); L.push(d.subtitulo); }
    L.push(''); L.push('_' + (TIPO_LABEL[d.tipo] || 'Infográfico') + '_'); L.push('');
    if (d.tipo === 'comparacao') {
      var c = d.comparacao;
      L.push('| Critério | ' + (c.a_nome || 'A') + ' | ' + (c.b_nome || 'B') + ' |');
      L.push('|---|---|---|');
      c.linhas.forEach(function (l) { L.push('| ' + l.criterio + ' | ' + l.a + ' | ' + l.b + ' |'); });
    } else {
      d.itens.forEach(function (it, i) {
        var head = it.chave ? it.chave + ' — ' : ((d.tipo === 'passos') ? (i + 1) + '. ' : '• ');
        L.push('**' + head + (it.titulo || '') + '**');
        if (it.texto) L.push(it.texto);
        L.push('');
      });
    }
    if (d.rodape) { L.push(''); L.push('_' + d.rodape + '_'); }
    return L.join('\n');
  }

  function copyText() {
    if (!currentData) { toast('Gere um infográfico primeiro.', true); return; }
    var txt = dataToText(currentData);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { toast('Texto copiado.'); }, function () { fallbackCopy(txt); });
    } else fallbackCopy(txt);
  }
  function fallbackCopy(txt) {
    var ta = document.createElement('textarea'); ta.value = txt; ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Texto copiado.'); } catch (_) { toast('Não foi possível copiar.', true); }
    document.body.removeChild(ta);
  }

  // ================= library =================
  function loadLib() { try { return JSON.parse(localStorage.getItem(LIB_KEY)) || []; } catch (_) { return []; } }
  function saveLib(list) { try { localStorage.setItem(LIB_KEY, JSON.stringify(list)); } catch (_) {} }

  function saveCurrent() {
    if (!currentData) { toast('Gere um infográfico primeiro.', true); return; }
    toast('Salvando...');
    makeThumb().then(function (thumb) {
      var list = loadLib();
      list.unshift({
        id: 'ig_' + Date.now(),
        data: currentData, opts: currentOpts, thumb: thumb,
        titulo: currentData.titulo, tipo: currentData.tipo
      });
      if (list.length > 12) list = list.slice(0, 12);
      saveLib(list);
      renderLibrary();
      toast('Salvo na biblioteca.');
    });
  }

  function renderLibrary() {
    var grid = $('library-grid'); if (!grid) return;
    var list = loadLib();
    var count = $('lib-count');
    if (count) count.textContent = list.length ? (list.length + ' salvo' + (list.length > 1 ? 's' : '')) : '';
    if (!list.length) { grid.innerHTML = '<p class="lib-empty">Nenhum infográfico salvo ainda. Gere um e clique em “Salvar”.</p>'; return; }
    grid.innerHTML = '';
    list.forEach(function (item, i) {
      var card = document.createElement('div'); card.className = 'lib-card';
      var num = ('00' + (list.length - i)).slice(-3);
      card.innerHTML =
        '<div class="lib-thumb">' + (item.thumb ? '<img alt="" src="' + item.thumb + '">' : '') + '</div>' +
        '<div class="lib-meta">' +
          '<span class="lib-num">Nº' + num + '</span>' +
          '<span class="lib-title">' + esc(item.titulo || 'Infográfico') + '</span>' +
          '<span class="lib-type">' + esc(TIPO_LABEL[item.tipo] || '') + '</span>' +
          '<button class="lib-del" data-id="' + item.id + '">Excluir</button>' +
        '</div>';
      card.querySelector('.lib-thumb').addEventListener('click', function () { reopen(item); });
      card.querySelector('.lib-title').addEventListener('click', function () { reopen(item); });
      card.querySelector('.lib-del').addEventListener('click', function (e) { e.stopPropagation(); delItem(item.id); });
      grid.appendChild(card);
    });
  }

  function reopen(item) {
    currentData = item.data; currentOpts = item.opts;
    // restore controls
    applyOptsToControls(item.opts);
    renderPreview(currentData, currentOpts);
    $('stage-actions').style.display = 'flex';
    $('run-stamp').textContent = 'Reaberto · ' + (TIPO_LABEL[item.tipo] || '');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function delItem(id) {
    var list = loadLib().filter(function (x) { return x.id !== id; });
    saveLib(list); renderLibrary(); toast('Removido da biblioteca.');
  }

  function applyOptsToControls(o) {
    if (!o) return;
    setChip('chips-tipo', o.tipo); setChip('chips-tema', o.theme);
    setChip('chips-formato', o.aspect); setChip('chips-tom', o.tom);
    if ($('in-cor')) { $('in-cor').value = normalizeHex(o.accent); if ($('cor-hex')) $('cor-hex').textContent = normalizeHex(o.accent).toUpperCase(); }
    if (o.tema && $('in-tema')) $('in-tema').value = o.tema;
  }
  function setChip(groupId, val) {
    var g = $(groupId); if (!g) return;
    var found = false;
    g.querySelectorAll('.chip').forEach(function (c) {
      var m = c.getAttribute('data-val') === val;
      c.classList.toggle('active', m); if (m) found = true;
    });
    if (!found) { var first = g.querySelector('.chip'); if (first) first.classList.add('active'); }
  }

  // ================= generate =================
  function setBusy(b) {
    var btn = $('btn-generate');
    if (btn) { btn.disabled = b; btn.textContent = b ? 'Gerando...' : 'Gerar infográfico'; }
    var rb = $('btn-regenerate'); if (rb) rb.disabled = b;
  }

  function collectOpts() {
    return {
      tema: clean($('in-tema') ? $('in-tema').value : ''),
      tipo: chipVal('chips-tipo') || 'auto',
      theme: chipVal('chips-tema') || 'moderno',
      aspect: chipVal('chips-formato') || 'portrait',
      tom: chipVal('chips-tom') || 'Profissional',
      accent: normalizeHex($('in-cor') ? $('in-cor').value : '#2036c9'),
      model: window.ApiKeyManager ? ApiKeyManager.getModel() : ''
    };
  }

  function generate() {
    var opts = collectOpts();
    if (!opts.tema || opts.tema.length < 8) { toast('Descreva o tema do infográfico (pelo menos uma frase).', true); if ($('in-tema')) $('in-tema').focus(); return; }
    var active = activeKey();
    if (!active) { toast('Configure sua chave de IA primeiro.', true); if (window.MembershipGate) MembershipGate.showScreen('key-screen'); return; }

    setBusy(true);
    showStage(
      '<div class="stage-loading"><div class="press-anim"><span class="bar b1"></span><span class="bar b2"></span><span class="bar b3"></span></div>' +
      '<p>Estruturando o conteúdo e imprimindo...</p></div>'
    );
    $('stage-actions').style.display = 'none';
    $('run-stamp').textContent = 'Imprimindo...';

    generateJSON(buildMessages(opts), active).then(function (raw) {
      var data = normalizeData(raw, opts);
      if (!data.itens.length && !(data.comparacao && data.comparacao.linhas.length)) {
        throw new Error('O modelo não retornou itens suficientes. Tente reformular o tema ou gerar novamente.');
      }
      currentData = data; currentOpts = opts;
      renderPreview(data, opts);
      $('stage-actions').style.display = 'flex';
      $('run-stamp').textContent = (TIPO_LABEL[data.tipo] || 'Pronto') + ' · impresso';
      toast('Infográfico gerado!');
    }).catch(function (err) {
      showStage('<div class="stage-empty"><h3>Não deu certo</h3><p>' + esc(err && err.message ? err.message : 'Erro ao gerar. Tente novamente.') + '</p></div>');
      $('run-stamp').textContent = 'Prensa · pronta';
      toast(err && err.message ? err.message : 'Erro ao gerar.', true);
    }).then(function () { setBusy(false); });
  }

  // ================= swatches =================
  var SWATCHES = ['#2036c9', '#e5341f', '#0f9d58', '#7b2ff7', '#ff6f00', '#0a7ea4', '#d81b60', '#111827'];
  function renderSwatches() {
    var box = $('swatch-presets'); if (!box) return;
    box.innerHTML = '';
    SWATCHES.forEach(function (hex) {
      var b = document.createElement('button');
      b.className = 'swatch'; b.type = 'button'; b.style.background = hex; b.title = hex;
      b.setAttribute('aria-label', 'Cor ' + hex);
      b.addEventListener('click', function () {
        if ($('in-cor')) $('in-cor').value = hex;
        if ($('cor-hex')) $('cor-hex').textContent = hex.toUpperCase();
        box.querySelectorAll('.swatch').forEach(function (s) { s.classList.remove('active'); });
        b.classList.add('active');
      });
      box.appendChild(b);
    });
  }

  // ================= wire (idempotent) =================
  function wire() {
    if (wired) return;
    if (!$('app-screen') || !$('app-screen').classList.contains('active')) return;
    wired = true;

    var nameEl = $('user-name');
    try { var sess = JSON.parse(localStorage.getItem('maestria_member_session') || '{}'); if (nameEl && sess.display_name) nameEl.textContent = sess.display_name; } catch (_) {}

    wireChips('chips-tipo'); wireChips('chips-tema'); wireChips('chips-formato'); wireChips('chips-tom');
    renderSwatches();

    if ($('in-cor')) $('in-cor').addEventListener('input', function () { if ($('cor-hex')) $('cor-hex').textContent = normalizeHex($('in-cor').value).toUpperCase(); });

    if (window.ApiKeyManager && ApiKeyManager.renderModelPicker) ApiKeyManager.renderModelPicker('model-select');

    var g = $('btn-generate'); if (g) g.addEventListener('click', generate);
    var rg = $('btn-regenerate'); if (rg) rg.addEventListener('click', generate);
    var ex = $('btn-export'); if (ex) ex.addEventListener('click', exportPNG);
    var cp = $('btn-copy'); if (cp) cp.addEventListener('click', copyText);
    var sv = $('btn-save'); if (sv) sv.addEventListener('click', saveCurrent);

    renderLibrary();
  }

  // 3 idempotent init triggers (COR-008 + COR-044)
  function go() { wire(); }
  document.addEventListener('maestria:app-ready', go);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(go, 60); });
  } else { setTimeout(go, 60); }
  (function () {
    var app = document.getElementById('app-screen');
    if (!app || !window.MutationObserver) return;
    var mo = new MutationObserver(function () { if (app.classList.contains('active')) go(); });
    mo.observe(app, { attributes: true, attributeFilter: ['class'] });
  })();

})();
