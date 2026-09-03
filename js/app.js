/* ==========================================================
   NPS dos ISAs — lógica do painel
   Fontes: data/nps.json (Databricks, automático)
           data/zendesk_semanal.csv (editado no GitHub)
           data/metas.json (metas do semestre)
   ========================================================== */

(function () {
  "use strict";

  /* ---------- paleta ---------- */
  const C = {
    navy: "#233E72",
    navySoft: "rgba(35,62,114,.10)",
    teal: "#00B9BB",
    tealSoft: "rgba(0,185,187,.14)",
    pink: "#ED1E79",
    pinkSoft: "rgba(237,30,121,.10)",
    amber: "#F2B705",
    grid: "#EDEFF5",
    muted: "#6B7690",
    green: "#12946A",
    red: "#D64545"
  };

  const MESES = { "01":"Janeiro","02":"Fevereiro","03":"Março","04":"Abril","05":"Maio","06":"Junho",
                  "07":"Julho","08":"Agosto","09":"Setembro","10":"Outubro","11":"Novembro","12":"Dezembro" };
  const mesLabel = m => (MESES[String(m).slice(5,7)] || m);
  const mesCurto = m => (mesLabel(m) || "").slice(0,3);

  const DIMENSOES = [
    { key: "pontualidade_pagamento", label: "Pontualidade Pagamento" },
    { key: "gestao_escalas",         label: "Gestão de Escalas" },
    { key: "experiencia_geral",      label: "Experiência Geral" },
    { key: "app_isa_atende",         label: "App Isa Atende" },
    { key: "comunicacao",            label: "Comunicação" },
    { key: "suporte_chat",           label: "Suporte Chat" }
  ];

  /* ---------- helpers ---------- */
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  function num(v) {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(String(v).replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  function fmt(n, casas) {
    if (n === null || n === undefined || Number.isNaN(n)) return "—";
    const c = casas === undefined ? 1 : casas;
    return n.toLocaleString("pt-BR", { minimumFractionDigits: c, maximumFractionDigits: c });
  }
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function scorePill(v) {
    if (v === null || v === undefined) return "pill-neutral";
    if (v >= 4.2) return "pill-good";
    if (v >= 3.5) return "pill-teal";
    if (v >= 3) return "pill-mid";
    return "pill-bad";
  }
  function npsColor(v) {
    if (v >= 75) return C.green;
    if (v >= 50) return C.teal;
    if (v >= 0) return C.amber;
    return C.red;
  }
  function animateNumber(node, target, casas, suffix) {
    if (target === null || target === undefined || Number.isNaN(target)) { node.textContent = "—"; return; }
    const finalTxt = fmt(target, casas) + (suffix || "");
    // Em aba oculta o requestAnimationFrame fica congelado — nesse caso (e quando o
    // usuário pede menos movimento) mostramos o valor final direto, nunca um zero preso.
    const semAnimacao = document.hidden ||
      (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (semAnimacao) { node.textContent = finalTxt; return; }

    const dur = 850, t0 = performance.now();
    let done = false;
    const finish = () => { if (!done) { done = true; node.textContent = finalTxt; } };
    setTimeout(finish, dur + 500); // rede de segurança: setTimeout roda mesmo em background
    (function step(now) {
      if (done) return;
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      node.textContent = fmt(target * eased, casas) + (suffix || "");
      if (p < 1) requestAnimationFrame(step); else finish();
    })(t0);
  }

  /* Dispara transições CSS de forma segura mesmo com a aba em segundo plano. */
  function afterPaint(fn) { setTimeout(fn, 40); }

  /* ---------- CSV ---------- */
  function parseCSV(text) {
    const rows = []; let row = [], field = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i+1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i+1] === "\n") i++;
        row.push(field); field = ""; rows.push(row); row = [];
      } else field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    const clean = rows.filter(r => r.some(v => v !== ""));
    if (!clean.length) return [];
    const head = clean.shift().map(h => h.trim());
    return clean.map(r => {
      const o = {}; head.forEach((h, i) => o[h] = (r[i] ?? "").trim()); return o;
    });
  }

  /* ---------- estado ---------- */
  const S = { nps: null, metas: null, zendesk: [], charts: {}, espSort: "nps", espSel: null, satSort: { col: "experiencia_geral", dir: -1 } };

  /* ---------- carregamento ---------- */
  async function loadAll() {
    const [nps, metas, zen] = await Promise.all([
      fetch("data/nps.json", { cache: "no-store" }).then(r => r.json()),
      fetch("data/metas.json", { cache: "no-store" }).then(r => r.ok ? r.json() : { objetivos: [] }).catch(() => ({ objetivos: [] })),
      loadZendesk()
    ]);
    S.nps = nps; S.metas = metas; S.zendesk = zen;
  }

  async function loadZendesk() {
    const url = window.NPS_CONFIG && window.NPS_CONFIG.ZENDESK_CSV_URL;
    if (url) {
      try {
        const r = await fetch(url, { cache: "no-store" });
        if (r.ok) return parseCSV(await r.text());
      } catch (e) { console.warn("Fonte externa do Zendesk indisponível, usando o arquivo do repositório.", e); }
    }
    const r = await fetch("data/zendesk_semanal.csv", { cache: "no-store" });
    if (!r.ok) return [];
    return parseCSV(await r.text());
  }

  /* ---------- acesso a dados ---------- */
  const zenMensal = () => S.zendesk.filter(r => (num(r.semana) ?? 0) === 0).sort((a,b) => a.mes.localeCompare(b.mes));
  const zenSemanal = mes => S.zendesk.filter(r => r.mes === mes && (num(r.semana) ?? 0) > 0).sort((a,b) => num(a.semana) - num(b.semana));
  const zenMes = mes => zenMensal().find(r => r.mes === mes) || null;

  function objetivo(id) { return (S.metas.objetivos || []).find(o => o.id === id) || null; }
  function metaDoMes(id, mes) {
    const o = objetivo(id);
    return o && o.metas ? (o.metas[mes] ?? null) : null;
  }
  function realizadoDoMes(o, mes) {
    if (!o) return null;
    if (o.fonte_realizado === "nps") {
      const h = (S.nps.historico_nps || []).find(x => x.mes === mes);
      return h ? h.nps : null;
    }
    const campo = String(o.fonte_realizado || "").split(":")[1];
    const linha = zenMes(mes);
    return linha ? num(linha[campo]) : null;
  }

  /* ---------- navegação ---------- */
  const PAGES = {
    visao:          { t: "Visão geral",     s: "Panorama da experiência dos profissionais" },
    especialidades: { t: "Especialidades",  s: "Onde a experiência é melhor e pior" },
    sac:            { t: "SAC & Zendesk",   s: "Indicadores de atendimento e suporte" },
    metas:          { t: "Metas SMART",     s: "Atingimento das metas do segundo semestre" },
    alavancas:      { t: "Alavancas",       s: "O que o time executou a cada semana" }
  };

  function setupNav() {
    $$(".nav-item").forEach(btn => {
      btn.addEventListener("click", () => {
        const page = btn.dataset.page;
        $$(".nav-item").forEach(b => b.classList.toggle("active", b === btn));
        $$(".page").forEach(p => p.classList.toggle("active", p.id === "page-" + page));
        $("#page-title").textContent = PAGES[page].t;
        $("#page-sub").textContent = PAGES[page].s;
        $("#sidebar").classList.remove("open");
        window.scrollTo({ top: 0, behavior: "smooth" });
        Object.values(S.charts).forEach(c => c && c.resize());
      });
    });
    const mt = $("#menu-toggle");
    if (mt) mt.addEventListener("click", () => $("#sidebar").classList.toggle("open"));
  }

  /* ---------- topo ---------- */
  function renderTopbar() {
    const d = new Date(S.nps.generated_at);
    const txt = "Atualizado em " + d.toLocaleDateString("pt-BR") + " às " +
                d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    $("#updated-text").textContent = txt;
    $("#foot-updated").textContent = txt;
    $("#side-updated").textContent = d.toLocaleDateString("pt-BR");

    const sel = $("#month-select");
    const meses = (S.nps.historico_nps || []).map(h => h.mes);
    sel.innerHTML = "";
    meses.forEach(m => {
      const o = el("option"); o.value = m; o.textContent = mesLabel(m);
      if (m === S.nps.current_month) o.selected = true;
      sel.appendChild(o);
    });
    sel.disabled = meses.length <= 1;
    sel.addEventListener("change", () => {
      if (sel.value !== S.nps.current_month) {
        pushAlert("O detalhamento por especialidade existe apenas para o mês vigente (" +
                  mesLabel(S.nps.current_month) + "). O histórico de todos os meses aparece nos gráficos de evolução.");
        sel.value = S.nps.current_month;
      }
    });
  }

  function pushAlert(msg) {
    const slot = $("#alert-slot");
    slot.innerHTML = "";
    const a = el("div", "alert-bar",
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/></svg><span>' + msg + "</span>");
    slot.appendChild(a);
    setTimeout(() => a.remove(), 6000);
  }

  /* ---------- PÁGINA: VISÃO GERAL ---------- */
  function renderHero() {
    const k = S.nps.kpi, mes = S.nps.current_month;
    $("#hero-month").textContent = mesLabel(mes) + " de " + mes.slice(0,4);
    animateNumber($("#hero-nps"), k.nps_geral, 1);
    $("#hero-desc").textContent =
      "Calculado sobre " + k.total_respostas + " respostas de " + mesLabel(mes).toLowerCase() +
      ". NPS = % promotores − % detratores.";

    const delta = $("#hero-delta");
    if (typeof k.nps_geral_variacao_pct === "number") {
      const up = k.nps_geral_variacao_pct >= 0;
      delta.className = "hero-delta " + (up ? "up" : "down");
      delta.innerHTML = (up ? "▲ " : "▼ ") + fmt(Math.abs(k.nps_geral_variacao_pct), 1) + "% vs. mês anterior";
    } else {
      delta.className = "hero-delta";
      delta.innerHTML = "primeiro mês da série";
    }

    animateNumber($("#hs-prom"), k.promotores, 0);
    animateNumber($("#hs-neut"), k.neutros, 0);
    animateNumber($("#hs-detr"), k.detratores, 0);
    animateNumber($("#hs-total"), k.total_respostas, 0);

    // gauge de atingimento da meta
    const meta = metaDoMes("nps", mes);
    const legend = $("#gauge-legend");
    if (meta) {
      const pct = Math.round((k.nps_geral / meta) * 100);
      const R = 64, CIRC = 2 * Math.PI * R;
      const frac = Math.max(0, Math.min(1.35, pct / 100)) / 1.35;
      const fill = $("#gauge-fill");
      fill.setAttribute("stroke-dasharray", CIRC);
      fill.setAttribute("stroke-dashoffset", CIRC);
      fill.style.stroke = pct >= 100 ? "#35D07F" : (pct >= 85 ? C.teal : "#FCA5A5");
      afterPaint(() => { fill.setAttribute("stroke-dashoffset", CIRC * (1 - frac)); });
      animateNumber($("#gauge-pct"), pct, 0, "%");
      legend.innerHTML =
        "Meta de " + mesLabel(mes).toLowerCase() + ": <b>" + fmt(meta, 1) + "</b><br>" +
        "Realizado: <b>" + fmt(k.nps_geral, 1) + "</b><br>" +
        "Meta de dezembro: <b>" + fmt((objetivo("nps") || {}).alvo_final, 0) + "</b>";
    } else {
      $("#gauge-pct").textContent = "—";
      legend.innerHTML = "Sem meta cadastrada<br>para este mês.";
    }

    // distribuição
    const tot = k.promotores + k.neutros + k.detratores || 1;
    const bar = $("#dist-bar");
    const parts = [["dist-prom", k.promotores], ["dist-neut", k.neutros], ["dist-detr", k.detratores]];
    bar.innerHTML = "";
    parts.forEach(([cls, val]) => {
      const s = el("span", cls); s.style.width = "0%";
      bar.appendChild(s);
      afterPaint(() => { s.style.width = (val / tot * 100) + "%"; });
    });
    const legendItems = [
      ["Promotores", k.promotores, "#35D07F"],
      ["Neutros", k.neutros, C.amber],
      ["Detratores", k.detratores, "#F06767"]
    ];
    $("#dist-legend").innerHTML = legendItems.map(([nome, val, cor]) =>
      '<div class="dist-item"><span class="dist-dot" style="background:' + cor + '"></span>' +
      nome + ' <b>' + val + '</b> <small>(' + fmt(val / tot * 100, 1) + '%)</small></div>').join("");
  }

  function renderHistorico(withCsat) {
    const hist = S.nps.historico_nps || [];
    const objNps = objetivo("nps") || { metas: {} };
    const meses = Array.from(new Set([...hist.map(h => h.mes), ...Object.keys(objNps.metas || {})])).sort();

    const realizado = meses.map(m => { const h = hist.find(x => x.mes === m); return h ? h.nps : null; });
    const metas = meses.map(m => objNps.metas ? (objNps.metas[m] ?? null) : null);
    const csatMap = {}; zenMensal().forEach(r => csatMap[r.mes] = num(r.csat_humano));
    const csat = meses.map(m => csatMap[m] ?? null);

    const ds = [
      { label: "NPS realizado", data: realizado, borderColor: C.navy, backgroundColor: C.navySoft,
        fill: true, tension: .34, borderWidth: 2.6, pointRadius: 4.5, pointBackgroundColor: C.navy,
        pointBorderColor: "#fff", pointBorderWidth: 2, yAxisID: "y", spanGaps: false },
      { label: "Meta", data: metas, borderColor: C.muted, borderDash: [5,5], borderWidth: 1.8,
        backgroundColor: "transparent", tension: .34, pointRadius: 2.5, pointBackgroundColor: C.muted, yAxisID: "y", spanGaps: true }
    ];
    if (withCsat) ds.push({
      label: "CSAT humano", data: csat, borderColor: C.pink, backgroundColor: "transparent",
      borderWidth: 2, tension: .34, pointRadius: 3.5, pointBackgroundColor: C.pink, yAxisID: "y1", spanGaps: true
    });

    mkChart("chart-historico", {
      type: "line",
      data: { labels: meses.map(mesCurto), datasets: ds },
      options: baseOpts({
        plugins: { legend: legendBottom() },
        scales: {
          y: { min: 0, max: 100, grid: { color: C.grid }, ticks: { padding: 6 }, title: axisTitle("NPS") },
          y1: withCsat ? { min: 0, max: 5, position: "right", grid: { display: false }, title: axisTitle("CSAT") } : { display: false },
          x: { grid: { display: false } }
        }
      })
    });
  }

  function renderRadar() {
    const map = {};
    (S.nps.media_por_pergunta || []).forEach(p => map[p.pergunta] = p.media);
    const labels = DIMENSOES.map(d => d.label);
    const vals = labels.map(l => map[l] ?? null);
    mkChart("chart-radar", {
      type: "radar",
      data: { labels: labels.map(l => l.split(" ")[0]), datasets: [{
        data: vals, borderColor: C.teal, backgroundColor: "rgba(0,185,187,.18)",
        borderWidth: 2, pointRadius: 3, pointBackgroundColor: C.teal
      }]},
      options: baseOpts({
        plugins: { legend: { display: false }, tooltip: { callbacks: {
          title: it => labels[it[0].dataIndex],
          label: c => "Nota " + fmt(c.parsed.r, 2)
        }}},
        scales: { r: { min: 0, max: 5, ticks: { stepSize: 1, backdropColor: "transparent", font: { size: 9 } },
                        grid: { color: C.grid }, angleLines: { color: C.grid }, pointLabels: { font: { size: 10 } } } }
      })
    });
  }

  function renderPerguntas() {
    const items = [...(S.nps.media_por_pergunta || [])].sort((a,b) => b.media - a.media);
    const cores = items.map((it, i) => i === 0 ? C.teal : (i === items.length - 1 ? C.pink : C.navy));
    mkChart("chart-perguntas", {
      type: "bar",
      data: { labels: items.map(i => i.pergunta), datasets: [{
        data: items.map(i => i.media), backgroundColor: cores,
        borderRadius: 6, maxBarThickness: 26
      }]},
      options: baseOpts({
        indexAxis: "y",
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => "Nota média: " + fmt(c.parsed.x, 2) } } },
        scales: { x: { min: 0, max: 5, grid: { color: C.grid } }, y: { grid: { display: false }, ticks: { font: { size: 11.5 } } } }
      })
    });
  }

  function renderInsights() {
    const box = $("#insights"); box.innerHTML = "";
    const perg = [...(S.nps.media_por_pergunta || [])].sort((a,b) => b.media - a.media);
    const esp = (S.nps.nps_por_especialidade || []).filter(e => e.pct_amostra >= 3);
    const melhorEsp = [...esp].sort((a,b) => b.nps - a.nps)[0];
    const piorEsp = [...esp].sort((a,b) => a.nps - b.nps)[0];
    const meta = metaDoMes("nps", S.nps.current_month);
    const k = S.nps.kpi;

    const cards = [];
    if (meta) {
      const dif = k.nps_geral - meta;
      cards.push({
        cls: dif >= 0 ? "" : "warn",
        html: dif >= 0
          ? "O NPS está <b>" + fmt(dif,1) + " pontos acima</b> da meta de " + mesLabel(S.nps.current_month).toLowerCase() +
            " (" + fmt(meta,1) + "), o equivalente a <b>" + Math.round(k.nps_geral/meta*100) + "%</b> de atingimento."
          : "O NPS está <b>" + fmt(Math.abs(dif),1) + " pontos abaixo</b> da meta de " + mesLabel(S.nps.current_month).toLowerCase() + " (" + fmt(meta,1) + ")."
      });
    }
    if (perg.length) {
      cards.push({ cls: "", html: "<b>" + perg[0].pergunta + "</b> é a dimensão mais bem avaliada (" + fmt(perg[0].media,2) + "), e <b>" +
        perg[perg.length-1].pergunta + "</b> a mais crítica (" + fmt(perg[perg.length-1].media,2) + ") — a diferença entre elas é de " +
        fmt(perg[0].media - perg[perg.length-1].media, 2) + " ponto." });
    }
    if (melhorEsp && piorEsp && melhorEsp !== piorEsp) {
      cards.push({ cls: "alert", html: "Entre as especialidades com amostra relevante, <b>" + melhorEsp.especialidade +
        "</b> lidera com NPS " + fmt(melhorEsp.nps,1) + ", enquanto <b>" + piorEsp.especialidade + "</b> fica em " + fmt(piorEsp.nps,1) + "." });
    }
    const detrPct = k.detratores / (k.promotores + k.neutros + k.detratores) * 100;
    cards.push({ cls: detrPct > 15 ? "warn" : "", html: "Detratores representam <b>" + fmt(detrPct,1) +
      "%</b> da base respondente — cada ponto percentual reduzido aqui vale ~1 ponto de NPS." });

    cards.forEach((c, i) => {
      const d = el("div", "callout " + c.cls, c.html);
      d.style.marginBottom = i < cards.length - 1 ? "10px" : "0";
      box.appendChild(d);
    });
  }

  /* ---------- PÁGINA: ESPECIALIDADES ---------- */
  function renderEspStats() {
    const esp = S.nps.nps_por_especialidade || [];
    const rel = esp.filter(e => e.pct_amostra >= 3);
    const best = [...rel].sort((a,b) => b.nps - a.nps)[0];
    const worst = [...rel].sort((a,b) => a.nps - b.nps)[0];
    const maior = [...esp].sort((a,b) => b.pct_amostra - a.pct_amostra)[0];

    const cards = [
      { cls: "navy",  label: "Especialidades", value: esp.length, note: "com pelo menos 1 resposta", casas: 0 },
      { cls: "",      label: "Maior volume", value: maior ? maior.pct_amostra : null, suffix: "%", note: maior ? maior.especialidade : "—", casas: 1 },
      { cls: "amber", label: "Melhor NPS (amostra ≥3%)", value: best ? best.nps : null, note: best ? best.especialidade : "—", casas: 1 },
      { cls: "pink",  label: "Pior NPS (amostra ≥3%)", value: worst ? worst.nps : null, note: worst ? worst.especialidade : "—", casas: 1 }
    ];
    const box = $("#esp-stats"); box.innerHTML = "";
    cards.forEach(c => {
      const d = el("div", "stat " + c.cls);
      d.innerHTML = '<div class="stat-label">' + c.label + '</div><div class="stat-value">—</div>' +
                    '<div class="stat-note">' + c.note + "</div>";
      box.appendChild(d);
      animateNumber(d.querySelector(".stat-value"), c.value, c.casas, c.suffix);
    });
  }

  function renderEspBarlist() {
    const list = [...(S.nps.nps_por_especialidade || [])];
    list.sort((a,b) => S.espSort === "nps" ? b.nps - a.nps : b.pct_amostra - a.pct_amostra);
    const box = $("#esp-barlist"); box.innerHTML = "";

    list.forEach(item => {
      const row = el("div", "barrow" + (S.espSel === item.especialidade ? " active" : ""));
      const width = Math.max(0, (item.nps + 100) / 200 * 100); // -100..100 → 0..100
      row.innerHTML =
        '<div class="barrow-name">' + item.especialidade + '<small>' + fmt(item.pct_amostra,1) + '% da amostra</small></div>' +
        '<div class="barrow-track"><div class="barrow-fill" style="width:0%;background:' + npsColor(item.nps) + '"></div></div>' +
        '<div class="barrow-val" style="color:' + npsColor(item.nps) + '">' + fmt(item.nps,1) + "</div>";
      row.addEventListener("click", () => selectEsp(item.especialidade));
      box.appendChild(row);
      afterPaint(() => { row.querySelector(".barrow-fill").style.width = width + "%"; });
    });
  }

  function selectEsp(nome) {
    S.espSel = S.espSel === nome ? null : nome;
    renderEspBarlist();
    renderEspDetail();
    renderSatTable();
  }

  function renderEspDetail() {
    const box = $("#esp-detail");
    if (!S.espSel) {
      box.innerHTML = '<div class="detail-empty">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 3h6M12 3v5"/><circle cx="12" cy="14" r="7"/></svg>' +
        "<div>Selecione uma especialidade ao lado para ver as notas detalhadas.</div></div>";
      return;
    }
    const sat = (S.nps.satisfacao_por_especialidade || []).find(s => s.especialidade === S.espSel);
    const nps = (S.nps.nps_por_especialidade || []).find(s => s.especialidade === S.espSel);
    if (!sat) { box.innerHTML = '<div class="detail-empty">Sem detalhamento para esta especialidade.</div>'; return; }

    let html = '<div class="detail-name">' + sat.especialidade + "</div>" +
      '<div class="detail-meta">' + sat.n + " respostas · NPS " +
      '<b style="color:' + npsColor(nps ? nps.nps : 0) + '">' + fmt(nps ? nps.nps : null, 1) + "</b>" +
      (nps ? " · " + fmt(nps.pct_amostra,1) + "% da amostra" : "") + "</div>" +
      '<div class="detail-scores">';
    DIMENSOES.forEach(d => {
      const v = sat[d.key];
      html += '<div class="dscore"><div><div class="dscore-label">' + d.label + "</div>" +
        '<div class="dscore-bar"><div class="dscore-fill" style="width:' + ((v||0)/5*100) + '%;background:' +
        (v >= 4.2 ? C.green : v >= 3.5 ? C.teal : v >= 3 ? C.amber : C.red) + '"></div></div></div>' +
        '<div class="dscore-val">' + fmt(v, 2) + "</div></div>";
    });
    html += "</div>";
    box.innerHTML = html;
  }

  function renderSatTable() {
    const head = $("#sat-head"), body = $("#tbl-satisfacao tbody");
    const cols = [{ key: "especialidade", label: "Especialidade", txt: true }, { key: "n", label: "Respostas", casas: 0 }]
      .concat(DIMENSOES.map(d => ({ key: d.key, label: d.label, casas: 2 })));

    head.innerHTML = cols.map(c => {
      const sorted = S.satSort.col === c.key;
      return '<th class="sortable ' + (c.txt ? "" : "num ") + (sorted ? "sorted" : "") + '" data-col="' + c.key + '">' +
        c.label + '<span class="arrow">' + (sorted ? (S.satSort.dir === 1 ? "▲" : "▼") : "▲") + "</span></th>";
    }).join("");
    head.querySelectorAll("th").forEach(th => th.addEventListener("click", () => {
      const col = th.dataset.col;
      if (S.satSort.col === col) S.satSort.dir *= -1;
      else { S.satSort.col = col; S.satSort.dir = col === "especialidade" ? 1 : -1; }
      renderSatTable();
    }));

    const rows = [...(S.nps.satisfacao_por_especialidade || [])].sort((a,b) => {
      const va = a[S.satSort.col], vb = b[S.satSort.col];
      if (typeof va === "string") return S.satSort.dir * va.localeCompare(vb);
      return S.satSort.dir * ((va ?? -Infinity) - (vb ?? -Infinity));
    });

    body.innerHTML = "";
    rows.forEach(r => {
      const tr = el("tr", S.espSel === r.especialidade ? "selected" : "");
      let html = '<td class="strong">' + r.especialidade + "</td>" +
                 '<td class="num" style="color:var(--muted)">' + r.n + "</td>";
      DIMENSOES.forEach(d => {
        html += '<td class="num"><span class="pill ' + scorePill(r[d.key]) + '">' + fmt(r[d.key], 2) + "</span></td>";
      });
      tr.innerHTML = html;
      tr.style.cursor = "pointer";
      tr.addEventListener("click", () => selectEsp(r.especialidade));
      body.appendChild(tr);
    });
  }

  /* ---------- PÁGINA: SAC ---------- */
  function renderSac() {
    const mensal = zenMensal();
    // último mês que efetivamente tem indicador preenchido (ignora meses ainda em branco)
    const preenchidos = mensal.filter(r =>
      ["csat_ia","csat_humano","fcr_pct","resolucao_ia_pct"].some(c => num(r[c]) !== null) ||
      (r.tma_primeira_resposta || "").trim() || (r.tmr || "").trim());
    const atual = preenchidos[preenchidos.length - 1];
    const anterior = preenchidos[preenchidos.length - 2];

    function delta(campo, inverso) {
      if (!atual || !anterior) return "";
      const a = num(atual[campo]), b = num(anterior[campo]);
      if (a === null || b === null || b === 0) return "";
      const p = (a - b) / Math.abs(b) * 100;
      const bom = inverso ? p < 0 : p > 0;
      return '<span class="trend ' + (bom ? "up" : "down") + '">' + (p >= 0 ? "▲" : "▼") + " " + fmt(Math.abs(p), 1) + "%</span>";
    }

    const cards = [
      { cls: "",      label: "CSAT humano",      val: atual ? num(atual.csat_humano) : null, casas: 2, note: "Escala 0–5" + delta("csat_humano") },
      { cls: "navy",  label: "CSAT IA",          val: atual ? num(atual.csat_ia) : null,     casas: 2, note: "Escala 0–5" + delta("csat_ia") },
      { cls: "amber", label: "Resolução com IA", val: atual ? num(atual.resolucao_ia_pct) : null, casas: 0, suffix: "%", note: "Sem intervenção humana" + delta("resolucao_ia_pct") },
      { cls: "pink",  label: "FCR",              val: atual ? num(atual.fcr_pct) : null,     casas: 1, suffix: "%", note: "Resolução no 1º contato" + delta("fcr_pct") },
      { cls: "",      label: "TMA 1ª resposta",  txt: (atual && atual.tma_primeira_resposta) || "—", note: "Tempo médio de atendimento" },
      { cls: "navy",  label: "TMR",              txt: (atual && atual.tmr) || "—", note: "Tempo médio de resolução" }
    ];
    const ref = $("#sac-ref");
    if (ref) ref.innerHTML = atual
      ? "Números de <b>" + (atual.mes_label || mesLabel(atual.mes)) + "</b>" +
        (anterior ? " · variação vs. " + (anterior.mes_label || mesLabel(anterior.mes)).toLowerCase() : "")
      : "Nenhum mês preenchido ainda em data/zendesk_semanal.csv.";

    const box = $("#sac-stats"); box.innerHTML = "";
    cards.forEach(c => {
      const d = el("div", "stat " + c.cls);
      d.innerHTML = '<div class="stat-label">' + c.label + "</div>" +
        '<div class="stat-value">' + (c.txt !== undefined ? c.txt : "—") + "</div>" +
        '<div class="stat-note">' + c.note + "</div>";
      box.appendChild(d);
      if (c.txt === undefined) animateNumber(d.querySelector(".stat-value"), c.val, c.casas, c.suffix);
    });

    const meses = mensal.map(r => r.mes);
    // CSAT
    mkChart("chart-csat", {
      type: "line",
      data: { labels: meses.map(mesCurto), datasets: [
        { label: "CSAT humano", data: mensal.map(r => num(r.csat_humano)), borderColor: C.pink, backgroundColor: C.pinkSoft,
          fill: true, tension: .34, borderWidth: 2.4, pointRadius: 4, pointBackgroundColor: C.pink, pointBorderColor: "#fff", pointBorderWidth: 2 },
        { label: "CSAT IA", data: mensal.map(r => num(r.csat_ia)), borderColor: C.navy, backgroundColor: "transparent",
          tension: .34, borderWidth: 2, pointRadius: 3.5, pointBackgroundColor: C.navy, borderDash: [4,3] }
      ]},
      options: baseOpts({ plugins: { legend: legendBottom() },
        scales: { y: { min: 0, max: 5, grid: { color: C.grid } }, x: { grid: { display: false } } } })
    });
    // FCR
    mkChart("chart-fcr", {
      type: "line",
      data: { labels: meses.map(mesCurto), datasets: [
        { label: "FCR", data: mensal.map(r => num(r.fcr_pct)), borderColor: C.teal, backgroundColor: C.tealSoft,
          fill: true, tension: .34, borderWidth: 2.4, pointRadius: 4, pointBackgroundColor: C.teal, pointBorderColor: "#fff", pointBorderWidth: 2 },
        { label: "Resolução com IA", data: mensal.map(r => num(r.resolucao_ia_pct)), borderColor: C.amber, backgroundColor: "transparent",
          tension: .34, borderWidth: 2, pointRadius: 3.5, pointBackgroundColor: C.amber }
      ]},
      options: baseOpts({ plugins: { legend: legendBottom(), tooltip: { callbacks: { label: c => c.dataset.label + ": " + fmt(c.parsed.y,1) + "%" } } },
        scales: { y: { min: 0, grid: { color: C.grid }, ticks: { callback: v => v + "%" } }, x: { grid: { display: false } } } })
    });

    // week over week
    const sem = zenSemanal(S.nps.current_month);
    mkChart("chart-wow", {
      type: "bar",
      data: { labels: sem.map(r => "S" + r.semana), datasets: [
        { type: "bar", label: "FCR (%)", data: sem.map(r => num(r.fcr_pct)), backgroundColor: C.tealSoft,
          borderColor: C.teal, borderWidth: 1.5, borderRadius: 6, maxBarThickness: 40, yAxisID: "y" },
        { type: "line", label: "CSAT humano", data: sem.map(r => num(r.csat_humano)), borderColor: C.pink,
          backgroundColor: "transparent", tension: .34, borderWidth: 2.4, pointRadius: 4, pointBackgroundColor: C.pink, yAxisID: "y1" }
      ]},
      options: baseOpts({ plugins: { legend: legendBottom() },
        scales: {
          y: { min: 0, max: 100, grid: { color: C.grid }, ticks: { callback: v => v + "%" }, title: axisTitle("FCR") },
          y1: { min: 0, max: 5, position: "right", grid: { display: false }, title: axisTitle("CSAT") },
          x: { grid: { display: false } }
        } })
    });

    // tabelas
    const tb = $("#tbl-zendesk tbody"); tb.innerHTML = "";
    mensal.forEach(r => {
      const tr = el("tr");
      tr.innerHTML = '<td class="strong">' + (r.mes_label || mesLabel(r.mes)) + "</td>" +
        '<td class="num">' + fmt(num(r.csat_ia), 2) + "</td>" +
        '<td class="num">' + fmt(num(r.csat_humano), 2) + "</td>" +
        '<td class="num">' + (r.tma_primeira_resposta || "—") + "</td>" +
        '<td class="num">' + (r.tmr || "—") + "</td>" +
        '<td class="num">' + (r.fcr_pct ? fmt(num(r.fcr_pct),1) + "%" : "—") + "</td>" +
        '<td class="num">' + (r.resolucao_ia_pct ? fmt(num(r.resolucao_ia_pct),0) + "%" : "—") + "</td>";
      tb.appendChild(tr);
    });

    const ts = $("#tbl-semanal tbody"); ts.innerHTML = "";
    if (!sem.length) {
      ts.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted-2);padding:22px;">Nenhuma semana preenchida para ' + mesLabel(S.nps.current_month) + ".</td></tr>";
    }
    sem.forEach(r => {
      const tr = el("tr");
      tr.innerHTML = '<td class="strong">Semana ' + r.semana + "</td><td>" + (r.periodo || "—") + "</td>" +
        '<td class="num">' + fmt(num(r.csat_ia), 2) + "</td>" +
        '<td class="num">' + fmt(num(r.csat_humano), 2) + "</td>" +
        '<td class="num">' + (r.tma_primeira_resposta || "—") + "</td>" +
        '<td class="num">' + (r.tmr || "—") + "</td>" +
        '<td class="num">' + (r.fcr_pct ? fmt(num(r.fcr_pct),1) + "%" : "—") + "</td>";
      ts.appendChild(tr);
    });
  }

  /* ---------- PÁGINA: METAS ---------- */
  function renderMetas() {
    const mes = S.nps.current_month;
    const box = $("#goal-cards"); box.innerHTML = "";

    (S.metas.objetivos || []).forEach(o => {
      const meta = metaDoMes(o.id, mes);
      const real = realizadoDoMes(o, mes);
      const att = (meta && real !== null) ? Math.round(real / meta * 100) : null;
      const good = att !== null && att >= 100;
      const R = 18, CIRC = 2 * Math.PI * R;
      const frac = att === null ? 0 : Math.max(0, Math.min(1, att / 100));

      const card = el("div", "goal");
      card.innerHTML =
        '<div class="goal-badge">Meta ' + mesCurto(mes).toLowerCase() + ": " + fmt(meta, o.casas) + (o.unidade === "%" ? "%" : "") + "</div>" +
        '<div class="goal-desc">' + o.descricao + "</div>" +
        '<div class="goal-real"><div class="goal-real-label">Realizado</div>' +
        '<div class="goal-real-value">' + fmt(real, o.casas) + (o.unidade === "%" ? "%" : "") + "</div></div>" +
        '<div class="goal-foot">' +
          '<div><div class="goal-real-label">Real vs. meta</div>' +
          '<div class="goal-att ' + (good ? "good" : "bad") + '">' + (att === null ? "—" : att + "%") + "</div></div>" +
          '<div class="goal-ring"><svg width="44" height="44" viewBox="0 0 44 44">' +
            '<circle cx="22" cy="22" r="18" fill="none" stroke="#EDEFF5" stroke-width="4"/>' +
            '<circle cx="22" cy="22" r="18" fill="none" stroke="' + (good ? C.green : C.red) + '" stroke-width="4" stroke-linecap="round" ' +
            'stroke-dasharray="' + CIRC + '" stroke-dashoffset="' + CIRC + '" class="ring-fill"/>' +
          "</svg></div>" +
        "</div>";
      box.appendChild(card);
      const ring = card.querySelector(".ring-fill");
      afterPaint(() => { ring.style.transition = "stroke-dashoffset 1s cubic-bezier(.2,.8,.3,1)"; ring.setAttribute("stroke-dashoffset", CIRC * (1 - frac)); });
    });

    // trajetória: normaliza cada objetivo como % da meta de dezembro
    const objs = S.metas.objetivos || [];
    const meses = Array.from(new Set(objs.flatMap(o => Object.keys(o.metas || {})))).sort();
    const cores = [C.navy, C.pink, C.amber, C.teal];
    const ds = [];
    objs.forEach((o, i) => {
      ds.push({
        label: o.label + " (real)",
        data: meses.map(m => { const r = realizadoDoMes(o, m); return r === null ? null : Math.round(r / o.alvo_final * 100); }),
        borderColor: cores[i % cores.length], backgroundColor: "transparent",
        borderWidth: 2.4, tension: .34, pointRadius: 4, pointBackgroundColor: cores[i % cores.length], spanGaps: false
      });
      ds.push({
        label: o.label + " (meta)",
        data: meses.map(m => { const v = o.metas[m]; return v === undefined ? null : Math.round(v / o.alvo_final * 100); }),
        borderColor: cores[i % cores.length], backgroundColor: "transparent",
        borderWidth: 1.4, borderDash: [4,4], tension: .34, pointRadius: 0, spanGaps: true
      });
    });
    mkChart("chart-meta", {
      type: "line",
      data: { labels: meses.map(mesCurto), datasets: ds },
      options: baseOpts({
        plugins: { legend: legendBottom(9), tooltip: { callbacks: { label: c => c.dataset.label + ": " + c.parsed.y + "% do alvo de dezembro" } } },
        scales: { y: { min: 0, grid: { color: C.grid }, ticks: { callback: v => v + "%" }, title: axisTitle("% do alvo final") }, x: { grid: { display: false } } }
      })
    });

    // resumo
    const sum = $("#meta-summary"); sum.innerHTML = "";
    objs.forEach(o => {
      const real = realizadoDoMes(o, mes);
      const falta = real === null ? null : o.alvo_final - real;
      const pct = real === null ? null : Math.round(real / o.alvo_final * 100);
      const d = el("div");
      d.style.cssText = "padding:13px 0;border-bottom:1px solid var(--line)";
      d.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;">' +
          '<span style="font-size:13.5px;font-weight:600;color:var(--navy)">' + o.label + "</span>" +
          '<span class="pill ' + (pct !== null && pct >= 100 ? "pill-good" : pct !== null && pct >= 80 ? "pill-teal" : "pill-mid") + '">' +
            (pct === null ? "—" : pct + "% do alvo") + "</span></div>" +
        '<div style="font-size:11.5px;color:var(--muted);margin-top:4px;">' +
          (falta === null ? "sem dado no mês" :
           falta <= 0 ? "alvo de dezembro já atingido" :
           "faltam " + fmt(falta, o.casas) + (o.unidade === "%" ? " p.p." : " pts") + " para o alvo de dezembro (" + fmt(o.alvo_final, 0) + ")") +
        "</div>";
      sum.appendChild(d);
    });
    if (S.metas.observacao) {
      sum.appendChild(el("div", "callout alert", S.metas.observacao)).style.marginTop = "14px";
    }
  }

  /* ---------- PÁGINA: ALAVANCAS ---------- */
  function renderAlavancas() {
    const sel = $("#alav-month");
    const meses = Array.from(new Set(S.zendesk.filter(r => r.narrativa).map(r => r.mes))).sort().reverse();
    if (!sel.options.length) {
      meses.forEach(m => { const o = el("option"); o.value = m; o.textContent = mesLabel(m); sel.appendChild(o); });
      sel.addEventListener("change", () => drawTimeline(sel.value));
    }
    drawTimeline(sel.value || meses[0]);
  }

  function drawTimeline(mes) {
    const box = $("#timeline"); box.innerHTML = "";
    const semanas = zenSemanal(mes).filter(r => r.narrativa);
    if (!semanas.length) {
      box.innerHTML = '<div class="detail-empty">Nenhuma alavanca registrada para ' + mesLabel(mes) + ".</div>";
      return;
    }
    semanas.forEach((r, i) => {
      const item = el("div", "tl-item" + (i === semanas.length - 1 ? " latest" : ""));
      const chips = [];
      if (r.fcr_pct) chips.push("FCR <b>" + fmt(num(r.fcr_pct),1) + "%</b>");
      if (r.csat_humano) chips.push("CSAT <b>" + fmt(num(r.csat_humano),2) + "</b>");
      if (r.tmr) chips.push("TMR <b>" + r.tmr + "</b>");
      if (r.resolucao_ia_pct) chips.push("Resolução IA <b>" + fmt(num(r.resolucao_ia_pct),0) + "%</b>");
      item.innerHTML =
        '<div class="tl-left"><div class="tl-week">Semana ' + r.semana + "</div>" +
        '<div class="tl-period">' + (r.periodo || "") + "</div></div>" +
        '<div class="tl-right"><div class="tl-dot"></div>' +
          '<div class="tl-text">' + r.narrativa + "</div>" +
          (chips.length ? '<div class="tl-chips">' + chips.map(c => '<span class="tl-chip">' + c + "</span>").join("") + "</div>" : "") +
        "</div>";
      box.appendChild(item);
    });
  }

  /* ---------- Chart.js helpers ---------- */
  function baseOpts(extra) {
    return Object.assign({
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        tooltip: {
          backgroundColor: "#16233B", padding: 11, cornerRadius: 9,
          titleFont: { size: 12.5, weight: "600" }, bodyFont: { size: 12 },
          displayColors: true, boxPadding: 4
        }
      }
    }, extra);
  }
  function legendBottom(size) {
    return { display: true, position: "bottom", labels: { boxWidth: 9, boxHeight: 9, usePointStyle: true, pointStyle: "circle", padding: 14, font: { size: size || 11 } } };
  }
  function axisTitle(text) { return { display: true, text: text, font: { size: 10 }, color: C.muted }; }

  function mkChart(id, cfg) {
    const canvas = document.getElementById(id);
    if (!canvas) return;
    if (S.charts[id]) S.charts[id].destroy();
    S.charts[id] = new Chart(canvas, cfg);
  }

  /* ---------- init ---------- */
  async function init() {
    Chart.defaults.font.family = "'Blinker', system-ui, sans-serif";
    Chart.defaults.font.size = 11.5;
    Chart.defaults.color = C.muted;

    await loadAll();

    setupNav();
    renderTopbar();

    renderHero();
    renderHistorico(false);
    renderRadar();
    renderPerguntas();
    renderInsights();

    renderEspStats();
    renderEspBarlist();
    renderEspDetail();
    renderSatTable();

    renderSac();
    renderMetas();
    renderAlavancas();

    // toggles
    $$("#seg-hist button").forEach(b => b.addEventListener("click", () => {
      $$("#seg-hist button").forEach(x => x.classList.toggle("active", x === b));
      renderHistorico(b.dataset.series === "csat");
    }));
    $$("#seg-esp button").forEach(b => b.addEventListener("click", () => {
      $$("#seg-esp button").forEach(x => x.classList.toggle("active", x === b));
      S.espSort = b.dataset.sort;
      renderEspBarlist();
    }));
  }

  init().catch(err => {
    console.error(err);
    document.querySelector(".page-wrap").insertAdjacentHTML("afterbegin",
      '<div class="alert-bar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/></svg>' +
      "<span>Não foi possível carregar os dados do painel. Detalhes no console do navegador.</span></div>");
  });
})();
