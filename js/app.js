/* ==========================================================
   NPS dos ISAs — lógica do painel
   Fontes: data/nps.json (Databricks, automático)
           data/zendesk_semanal.csv (editado no GitHub)
           data/metas.json (metas do semestre)
   ========================================================== */

(function () {
  "use strict";

  /* Paleta — Design System ISA */
  const C = {
    blue: "#004474",
    blueFill: "rgba(0,68,116,.08)",
    teal: "#00C3C5",
    tealFill: "rgba(0,195,197,.12)",
    pink: "#ED1E79",
    amber: "#EDBB3B",
    positive: "#00C643",
    negative: "#E93B5A",
    grid: "#E8EAED",
    text: "#666E80"
  };

  const MESES = { "01":"Janeiro","02":"Fevereiro","03":"Março","04":"Abril","05":"Maio","06":"Junho",
                  "07":"Julho","08":"Agosto","09":"Setembro","10":"Outubro","11":"Novembro","12":"Dezembro" };
  const mesLabel = m => MESES[String(m).slice(5,7)] || m;
  const mesCurto = m => mesLabel(m).slice(0,3);

  const DIMENSOES = [
    { key: "pontualidade_pagamento", label: "Pontualidade Pagamento" },
    { key: "gestao_escalas",         label: "Gestão de Escalas" },
    { key: "experiencia_geral",      label: "Experiência Geral" },
    { key: "app_isa_atende",         label: "App Isa Atende" },
    { key: "comunicacao",            label: "Comunicação" },
    { key: "suporte_chat",           label: "Suporte Chat" }
  ];

  const MIN_AMOSTRA = 5;  // abaixo disso o número não sustenta uma decisão
  const MIN_SEMANA = 20;  // semana com menos que isso é amostra parcial, não tendência
  const MIN_DESTAQUE = 20; // piso para "melhor/pior especialidade" virar afirmação

  /* ---------- utilidades ---------- */
  const $  = s => document.querySelector(s);
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
  function classeNota(v) {
    if (v === null || v === undefined) return "";
    if (v >= 4.2) return "hi";
    if (v >= 3.5) return "mid";
    if (v >= 3) return "lo";
    return "bad";
  }
  function corNps(v) {
    if (v >= 75) return C.positive;
    if (v >= 50) return C.teal;
    if (v >= 0)  return C.amber;
    return C.negative;
  }
  /** Anima o número, mas nunca deixa um zero preso se a aba estiver oculta. */
  function conta(node, alvo, casas, sufixo) {
    if (alvo === null || alvo === undefined || Number.isNaN(alvo)) { node.textContent = "—"; return; }
    const fim = fmt(alvo, casas) + (sufixo || "");
    const parado = document.hidden ||
      (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (parado) { node.textContent = fim; return; }

    const dur = 800, t0 = performance.now();
    let pronto = false;
    const encerra = () => { if (!pronto) { pronto = true; node.textContent = fim; } };
    setTimeout(encerra, dur + 500);
    (function passo(agora) {
      if (pronto) return;
      const p = Math.min(1, (agora - t0) / dur);
      node.textContent = fmt(alvo * (1 - Math.pow(1 - p, 3)), casas) + (sufixo || "");
      p < 1 ? requestAnimationFrame(passo) : encerra();
    })(t0);
  }
  const aoPintar = fn => setTimeout(fn, 40);

  /* ---------- CSV ---------- */
  function parseCSV(text) {
    const linhas = []; let linha = [], campo = "", aspas = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (aspas) {
        if (c === '"') { if (text[i+1] === '"') { campo += '"'; i++; } else aspas = false; }
        else campo += c;
      } else if (c === '"') aspas = true;
      else if (c === ",") { linha.push(campo); campo = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i+1] === "\n") i++;
        linha.push(campo); campo = ""; linhas.push(linha); linha = [];
      } else campo += c;
    }
    if (campo.length || linha.length) { linha.push(campo); linhas.push(linha); }
    const limpas = linhas.filter(l => l.some(v => v !== ""));
    if (!limpas.length) return [];
    const cab = limpas.shift().map(h => h.trim());
    return limpas.map(l => { const o = {}; cab.forEach((h, i) => o[h] = (l[i] ?? "").trim()); return o; });
  }

  /* ---------- estado ---------- */
  const S = { nps: null, metas: null, zendesk: [], charts: {}, mes: null, semana: null, histCsat: false,
              espOrdem: "nps", espSel: null, satOrdem: { col: "experiencia_geral", dir: -1 } };

  const SEM_DADOS = {
    kpi: { nps_geral: null, nps_geral_variacao_pct: null, total_respostas: 0, promotores: 0, neutros: 0, detratores: 0 },
    media_por_pergunta: [], nps_por_especialidade: [], satisfacao_por_especialidade: []
  };

  /** Bloco bruto de NPS do mês — null quando o mês ainda não tem respostas. */
  function blocoDoMes(mes) {
    const m = mes || S.mes;
    if (S.nps.meses) return S.nps.meses[m] || null;
    // compatibilidade com o formato antigo (só o mês corrente no topo do JSON)
    return m === S.nps.current_month ? {
      kpi: S.nps.kpi,
      media_por_pergunta: S.nps.media_por_pergunta,
      nps_por_especialidade: S.nps.nps_por_especialidade,
      satisfacao_por_especialidade: S.nps.satisfacao_por_especialidade
    } : null;
  }
  const semanasNps = mes => (S.nps.semanas || {})[mes || S.mes] || [];
  /** A semana selecionada no topo, ou null quando o recorte é o mês inteiro. */
  const semanaAtual = () =>
    S.semana === null ? null : semanasNps().find(s => s.semana === S.semana) || null;

  /** Recorte em vigor: a semana escolhida, senão o mês. */
  function bloco(mes) {
    if (!mes && S.semana !== null) {
      const s = semanaAtual();
      // uma semana que sumiu (troca de mês) cai de volta pro mês inteiro
      if (s && s.kpi) return s;
    }
    return blocoDoMes(mes);
  }
  /** Sempre devolve uma estrutura utilizável, mesmo em recorte sem respostas. */
  const dados = mes => bloco(mes) || SEM_DADOS;
  const temNps = mes => bloco(mes) !== null;
  /** Como chamar o recorte atual em texto: "agosto de 2026" ou "semana 2". */
  function recorteLabel() {
    const s = semanaAtual();
    return s ? "semana " + s.semana + " (" + s.label + ")"
             : mesLabel(S.mes).toLowerCase() + " de " + S.mes.slice(0, 4);
  }

  /** Todos os meses que têm algum dado — de NPS ou de Zendesk. */
  function mesesDisponiveis() {
    const doNps = Object.keys(S.nps.meses || {});
    const doHist = (S.nps.historico_nps || []).map(h => h.mes);
    const doZen = S.zendesk.map(r => r.mes).filter(Boolean);
    return Array.from(new Set([...doNps, ...doHist, ...doZen])).sort();
  }

  async function carregar() {
    const [nps, metas, zen] = await Promise.all([
      fetch("data/nps.json", { cache: "no-store" }).then(r => r.json()),
      fetch("data/metas.json", { cache: "no-store" }).then(r => r.ok ? r.json() : { objetivos: [] }).catch(() => ({ objetivos: [] })),
      carregarZendesk()
    ]);
    S.nps = nps; S.metas = metas; S.zendesk = zen;
  }
  async function carregarZendesk() {
    const url = window.NPS_CONFIG && window.NPS_CONFIG.ZENDESK_CSV_URL;
    if (url) {
      try { const r = await fetch(url, { cache: "no-store" }); if (r.ok) return parseCSV(await r.text()); }
      catch (e) { console.warn("Fonte externa indisponível, usando o arquivo do repositório.", e); }
    }
    const r = await fetch("data/zendesk_semanal.csv", { cache: "no-store" });
    return r.ok ? parseCSV(await r.text()) : [];
  }

  const zenMensal  = () => S.zendesk.filter(r => (num(r.semana) ?? 0) === 0).sort((a,b) => a.mes.localeCompare(b.mes));
  const zenSemanal = mes => S.zendesk.filter(r => r.mes === mes && (num(r.semana) ?? 0) > 0).sort((a,b) => num(a.semana) - num(b.semana));
  const zenMes     = mes => zenMensal().find(r => r.mes === mes) || null;

  const objetivo = id => (S.metas.objetivos || []).find(o => o.id === id) || null;
  function metaDoMes(id, mes) { const o = objetivo(id); return o && o.metas ? (o.metas[mes] ?? null) : null; }
  function realizado(o, mes) {
    if (!o) return null;
    if (o.fonte_realizado === "nps") {
      const h = (S.nps.historico_nps || []).find(x => x.mes === mes);
      return h ? h.nps : null;
    }
    if (!o.fonte_realizado) return null;
    const campo = String(o.fonte_realizado || "").split(":")[1];
    const linha = zenMes(mes);
    return linha ? num(linha[campo]) : null;
  }
  /* Acima disso o atingimento deixa de informar: 458% não diz que o indicador
     vai bem, diz que a meta do mês está defasada. */
  const ATT_DEFASADA = 150;

  function status(o, mes) {
    const meta = metaDoMes(o.id, mes), real = realizado(o, mes);
    const att = (meta && real !== null) ? Math.round(real / meta * 100) : null;
    const defasada = att !== null && att >= ATT_DEFASADA;
    return {
      meta, real, att, defasada,
      cls: att === null ? "risco" : att >= 100 ? "ok" : att >= 85 ? "risco" : "off",
      // o que mostrar no lugar do número quando ele perde o sentido
      texto: att === null ? "—" : defasada ? (real / meta).toFixed(1).replace(".", ",") + "×" : att + "%",
      palavra: att === null ? "sem dado"
             : defasada ? "meta defasada"
             : att >= 100 ? "no alvo" : att >= 85 ? "atenção" : "atrasado"
    };
  }
  const unidade = o => (o.unidade === "%" ? "%" : "");

  /** Especialidades com amostra suficiente vs. as que não sustentam leitura. */
  function especialidades() {
    const n = {};
    (dados().satisfacao_por_especialidade || []).forEach(s => n[s.especialidade] = s.n);
    const todas = (dados().nps_por_especialidade || []).map(e => Object.assign({ n: n[e.especialidade] ?? null }, e));
    return {
      relevantes: todas.filter(e => (e.n ?? 0) >= MIN_AMOSTRA),
      pequenas:   todas.filter(e => (e.n ?? 0) < MIN_AMOSTRA)
    };
  }

  /* ---------- navegação ---------- */
  const PAGES = {
    resumo:         { t: "Resumo executivo",  s: "Onde estamos, qual o risco e o que está sendo feito" },
    visao:          { t: "NPS em detalhe",    s: "Composição e evolução do índice" },
    especialidades: { t: "Especialidades",    s: "Onde a experiência é melhor e pior" },
    sac:            { t: "SAC & Zendesk",     s: "Indicadores de atendimento e suporte" },
    metas:          { t: "Metas do semestre", s: "Atingimento dos objetivos até dezembro" },
    alavancas:      { t: "Alavancas",         s: "O que o time executou a cada semana" }
  };

  function navegacao() {
    $$(".nav-item").forEach(btn => btn.addEventListener("click", () => {
      const p = btn.dataset.page;
      $$(".nav-item").forEach(b => b.classList.toggle("active", b === btn));
      $$(".page").forEach(s => s.classList.toggle("active", s.id === "page-" + p));
      $("#page-title").textContent = PAGES[p].t;
      $("#page-sub").textContent = PAGES[p].s;
      $("#sidebar").classList.remove("open");
      window.scrollTo({ top: 0, behavior: "smooth" });
      Object.values(S.charts).forEach(c => c && c.resize());
    }));
    const mt = $("#menu-toggle");
    if (mt) mt.addEventListener("click", () => $("#sidebar").classList.toggle("open"));
    const va = $("#ver-alavancas");
    if (va) va.addEventListener("click", () => $('.nav-item[data-page="alavancas"]').click());
  }

  function topo() {
    const d = new Date(S.nps.generated_at);
    const txt = "Atualizado em " + d.toLocaleDateString("pt-BR") + " às " +
                d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    $("#updated-text").textContent = txt;
    $("#foot-updated").textContent = txt;

    const sel = $("#month-select");
    const meses = mesesDisponiveis().reverse();   // mais recente primeiro
    sel.innerHTML = "";
    meses.forEach(m => {
      const o = el("option");
      o.value = m;
      o.textContent = mesLabel(m) + " de " + m.slice(0, 4);
      if (m === S.mes) o.selected = true;
      sel.appendChild(o);
    });
    sel.disabled = meses.length <= 1;
    sel.addEventListener("change", () => {
      S.mes = sel.value;
      S.semana = null;      // semana 2 de agosto não é semana 2 de setembro
      S.espSel = null;
      seletorSemanas();
      desenharMes();
    });

    seletorSemanas();
    $("#week-select").addEventListener("change", e => {
      S.semana = e.target.value === "" ? null : Number(e.target.value);
      S.espSel = null;
      desenharMes();
    });
  }

  /** Preenche o seletor de semanas com as semanas do mês selecionado. */
  function seletorSemanas() {
    const sel = $("#week-select"), sem = semanasNps();
    sel.innerHTML = '<option value="">Mês inteiro</option>' +
      sem.map(s => '<option value="' + s.semana + '">S' + s.semana + " · " + s.label +
        (s.respostas < MIN_SEMANA ? " (parcial)" : "") + "</option>").join("");
    sel.value = S.semana === null ? "" : String(S.semana);
    sel.hidden = sem.length === 0;
  }

  function aviso(msg) {
    const slot = $("#alert-slot"); slot.innerHTML = "";
    const a = el("div", "notice",
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/></svg><span>' + msg + "</span>");
    slot.appendChild(a);
    setTimeout(() => a.remove(), 6000);
  }

  /* ---------- RESUMO EXECUTIVO ---------- */
  /** Redesenha tudo que depende do mês selecionado. */
  function desenharMes() {
    const slot = $("#alert-slot"), sem = semanaAtual();
    const cerca = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
                  '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/></svg>';
    slot.innerHTML =
      !temNps() ? '<div class="notice">' + cerca + "<span>Ainda não há respostas de NPS em " +
                  recorteLabel() + ". Os indicadores de Zendesk e as alavancas do mês continuam disponíveis.</span></div>"
      : sem ? '<div class="notice">' + cerca + "<span>Recorte da <b>semana " + sem.semana + "</b> (" +
              sem.label + ", " + sem.respostas + " respostas). As metas do semestre e os números de Zendesk " +
              "continuam mensais.</span></div>"
      : "";

    heroi(); farol(); alerta(); leitura(); acoes();
    grafHistorico(S.histCsat); composicao(); grafRadar(); grafPerguntas(); grafSemanas(); destaques();
    espIndicadores(); espLista(); espDetalhe(); tabelaSatisfacao();
    sac(); metas(); alavancas();
  }

  function heroi() {
    const k = dados().kpi, mes = S.mes, sem = semanaAtual();
    $("#hero-month").textContent = sem
      ? "Semana " + sem.semana + " · " + sem.label
      : mesLabel(mes) + " de " + mes.slice(0,4);
    conta($("#hero-nps"), k.nps_geral, 1);
    $("#hero-desc").textContent = temNps()
      ? "Calculado sobre " + k.total_respostas + " respostas. NPS é a diferença entre o percentual de promotores e o de detratores."
      : "Ainda não há respostas de NPS em " + recorteLabel() + ".";

    const tag = $("#hero-tag");
    if (typeof k.nps_geral_variacao_pct === "number") {
      const sobe = k.nps_geral_variacao_pct >= 0;
      tag.className = "hero-tag " + (sobe ? "up" : "down");
      tag.textContent = (sobe ? "+" : "−") + fmt(Math.abs(k.nps_geral_variacao_pct),1) +
                        "% vs. " + (sem ? "semana anterior" : "mês anterior");
    } else {
      tag.className = "hero-tag";
      tag.textContent = !temNps() ? "sem respostas ainda"
                      : sem ? "primeira semana do mês" : "primeiro mês da série";
    }

    const total = k.promotores + k.neutros + k.detratores || 1;
    $("#hero-facts").innerHTML = [
      ["Promotores", k.promotores, C.positive],
      ["Neutros", k.neutros, C.amber],
      ["Detratores", k.detratores, C.negative],
      ["Respostas", k.total_respostas, null]
    ].map(([rot, val, cor]) =>
      '<div><div class="fact-value tabular">' +
        (cor ? '<span class="dot" style="background:' + cor + '"></span>' : "") + (temNps() ? val : "—") +
      '</div><div class="fact-label">' + rot + "</div></div>").join("");

    // O medidor fica sempre no mês: a meta é mensal, comparar com uma semana
    // solta daria um atingimento que não quer dizer nada.
    const kMes = (blocoDoMes() || SEM_DADOS).kpi;
    const meta = metaDoMes("nps", mes);
    if (meta && blocoDoMes()) {
      const pct = Math.round(kMes.nps_geral / meta * 100);
      const CIRC = 2 * Math.PI * 55;
      const fill = $("#meter-fill");
      fill.style.stroke = pct >= 100 ? C.positive : pct >= 85 ? C.teal : C.negative;
      aoPintar(() => fill.setAttribute("stroke-dashoffset", CIRC * (1 - Math.min(1, pct / 100))));
      conta($("#meter-pct"), pct, 0, "%");
      const objNps = objetivo("nps") || {};
      $("#meter-list").innerHTML =
        "<div><span>Realizado" + (sem ? " no mês" : "") + "</span><b>" + fmt(kMes.nps_geral,1) + "</b></div>" +
        "<div><span>Meta do mês</span><b>" + fmt(meta,1) + "</b></div>" +
        "<div><span>Alvo de dezembro</span><b>" + fmt(objNps.alvo_final, 0) + "</b></div>";
    } else {
      const fill = $("#meter-fill");
      fill.setAttribute("stroke-dashoffset", 2 * Math.PI * 55);
      $("#meter-pct").textContent = "—";
      $("#meter-list").innerHTML = "<div><span>" +
        (meta ? "Aguardando respostas do mês" : "Sem meta cadastrada para o mês") + "</span></div>";
    }
  }

  function farol() {
    const mes = S.mes, box = $("#farol");
    box.innerHTML = "";
    (S.metas.objetivos || []).forEach(o => {
      const st = status(o, mes);
      box.appendChild(el("div", "farol-row",
        '<span class="dot ' + (st.defasada ? "stale" : st.cls) + '"></span>' +
        '<div><div class="farol-name">' + o.label + "</div>" +
          '<div class="farol-ctx">' + (st.defasada
            ? "Já passou o alvo de dezembro (" + fmt(o.alvo_final, 0) + unidade(o) + "). A meta precisa ser revista."
            : (o.contexto || "")) + "</div></div>" +
        '<div class="farol-nums"><div class="farol-real tabular">' + fmt(st.real, o.casas) + unidade(o) + "</div>" +
          '<div class="farol-meta">meta ' + fmt(st.meta, o.casas) + unidade(o) + "</div></div>" +
        '<div class="farol-status"><div class="farol-att tabular ' + (st.defasada ? "stale" : st.cls) + '">' +
          st.texto + "</div>" +
          '<div class="farol-word">' + st.palavra + "</div></div>"));
    });
  }

  function alerta() {
    const mes = S.mes;
    let pior = null;
    (S.metas.objetivos || []).forEach(o => {
      const st = status(o, mes);
      // meta defasada não disputa o pior atingimento: o problema ali é a meta
      if (st.att !== null && !st.defasada && (!pior || st.att < pior.st.att)) pior = { o, st };
    });
    if (!pior) {
      $("#alerta-text").textContent = "Sem metas cadastradas para comparar.";
      $("#alerta-trajeto").innerHTML = "";
      return;
    }

    const { o, st } = pior;
    $("#alerta-kicker").textContent = o.label + " · " + mesLabel(mes);
    conta($("#alerta-number"), st.att, 0, "%");
    $("#alerta-number").style.color = st.att >= 100 ? "#009131" : st.att >= 85 ? "#96700B" : C.negative;

    $("#alerta-text").innerHTML = st.att >= 100
      ? "Nenhum objetivo ficou abaixo da meta neste mês. O menor atingimento é <b>" + o.label +
        "</b>, ainda assim em " + st.att + "% do esperado."
      : "<b>" + o.label + "</b> fechou " + mesLabel(mes).toLowerCase() + " em <b>" + fmt(st.real, o.casas) + unidade(o) +
        "</b> contra meta de <b>" + fmt(st.meta, o.casas) + unidade(o) + "</b> — lacuna de " +
        fmt(st.meta - st.real, o.casas) + (o.unidade === "%" ? " pontos percentuais" : " pontos") + ". " +
        (o.contexto ? o.contexto + " " : "") +
        "Para chegar a " + fmt(o.alvo_final, 0) + unidade(o) + " até dezembro, é o indicador que depende de decisão agora.";

    // A escada que ainda falta subir — é o que a diretoria precisa aprovar.
    const futuros = Object.keys(o.metas || {}).filter(m => m > mes).sort();
    $("#alerta-trajeto").innerHTML = !futuros.length ? "" :
      '<div class="trajeto-label">O que falta subir</div>' +
      '<div class="trajeto">' + futuros.map(m => {
        const salto = o.metas[m] - (o.metas[futuros[futuros.indexOf(m) - 1]] ?? st.real);
        return '<div class="trajeto-passo"><div class="trajeto-mes">' + mesCurto(m) + "</div>" +
          '<div class="trajeto-meta tabular">' + fmt(o.metas[m], o.casas) + unidade(o) + "</div>" +
          '<div class="trajeto-delta">' + (salto > 0 ? "+" : "") + fmt(salto, o.casas) + "</div></div>";
      }).join("") + "</div>";
  }

  function leitura() {
    const box = $("#notes"); box.innerHTML = "";
    $("#notes-label").textContent = S.semana === null ? "Leitura do mês" : "Leitura da semana";
    const mes = S.mes, k = dados().kpi, itens = [];

    const stNps = status(objetivo("nps") || { id: "nps", casas: 1 }, mes);
    if (stNps.meta && temNps() && S.semana === null) {   // a meta é mensal
      const dif = k.nps_geral - stNps.meta;
      itens.push({ t: dif >= 0 ? "up" : "down",
        txt: "O NPS fechou <b>" + fmt(k.nps_geral,1) + "</b> contra meta de <b>" + fmt(stNps.meta,1) + "</b> — " +
             (dif >= 0 ? fmt(dif,1) + " pontos acima" : fmt(Math.abs(dif),1) + " pontos abaixo") +
             ", ou " + stNps.att + "% do esperado para " + mesLabel(mes).toLowerCase() + "." });
    }

    const sem = semanaAtual();
    if (sem) {
      const anteriores = semanasNps().filter(s => s.semana < sem.semana);
      const antes = anteriores[anteriores.length - 1];
      if (antes) {
        const dif = sem.nps - antes.nps;
        itens.push({ t: dif >= 0 ? "up" : "down",
          txt: "Da semana " + antes.semana + " para a " + sem.semana + " o NPS " +
               (dif >= 0 ? "subiu <b>" : "caiu <b>") + fmt(Math.abs(dif),1) + " pontos</b> (" +
               fmt(antes.nps,1) + " → " + fmt(sem.nps,1) + ")." });
      }
      if (sem.respostas < MIN_SEMANA) itens.push({ t: "down",
        txt: "São só <b>" + sem.respostas + " respostas</b> nesta semana — o número serve de sinal, não de conclusão." });
    }

    const objs = S.metas.objetivos || [];
    const sts = objs.map(o => ({ o, st: status(o, mes) }));
    const validos = sts.filter(x => !x.st.defasada);
    const noAlvo = validos.filter(x => (x.st.att || 0) >= 100).length;
    const defasados = sts.filter(x => x.st.defasada);
    itens.push({ t: noAlvo === validos.length ? "up" : noAlvo === 0 ? "down" : "",
      txt: "<b>" + noAlvo + " de " + validos.length + " objetivos</b> com meta vigente estão no alvo" +
           (defasados.length
             ? ". <b>" + defasados.map(x => x.o.label).join(" e ") + "</b> já " +
               (defasados.length > 1 ? "passaram" : "passou") + " o alvo de dezembro — a meta precisa ser revista."
             : ".") });

    const perg = [...(dados().media_por_pergunta || [])].sort((a,b) => b.media - a.media);
    if (perg.length) itens.push({ t: "",
      txt: "<b>" + perg[0].pergunta + "</b> sustenta a nota (" + fmt(perg[0].media,2) + ") e <b>" +
           perg[perg.length-1].pergunta + "</b> é o que mais puxa para baixo (" + fmt(perg[perg.length-1].media,2) + ")." });

    const maior = [...especialidades().relevantes].sort((a,b) => b.pct_amostra - a.pct_amostra)[0];
    if (maior) itens.push({ t: "",
      txt: "<b>" + maior.especialidade + "</b> concentra " + fmt(maior.pct_amostra,1) +
           "% das respostas — o índice geral se move principalmente com esse grupo." });

    itens.forEach(i => box.appendChild(el("li", i.t, i.txt)));
  }

  function acoes() {
    const box = $("#actions"); box.innerHTML = "";
    const ultimas = S.zendesk
      .filter(r => r.narrativa && (num(r.semana) ?? 0) > 0)
      .sort((a,b) => (a.mes + String(a.semana)).localeCompare(b.mes + String(b.semana)))
      .slice(-3).reverse();
    if (!ultimas.length) { box.appendChild(el("li", "", "Nenhuma ação registrada ainda.")); return; }
    ultimas.forEach(r => box.appendChild(el("li", "",
      '<span class="when">' + mesCurto(r.mes) + " · semana " + r.semana + "</span>" + r.narrativa)));
  }

  /* ---------- NPS EM DETALHE ---------- */
  function composicao() {
    const k = dados().kpi, total = k.promotores + k.neutros + k.detratores || 1;
    const barra = $("#stack");
    [["p", k.promotores], ["n", k.neutros], ["d", k.detratores]].forEach(([cls, val], i) => {
      const s = barra.children[i];
      s.style.width = "0%";
      aoPintar(() => s.style.width = (val / total * 100) + "%");
    });
    $("#stack-legend").innerHTML = [
      ["Promotores", k.promotores], ["Neutros", k.neutros], ["Detratores", k.detratores]
    ].map(([rot, v]) => "<div>" + rot + " <b>" + v + "</b> (" + fmt(v / total * 100, 1) + "%)</div>").join("");
  }

  function grafHistorico(comCsat) {
    const hist = S.nps.historico_nps || [];
    const objNps = objetivo("nps") || { metas: {} };
    const meses = Array.from(new Set([...hist.map(h => h.mes), ...Object.keys(objNps.metas || {})])).sort();
    const real = meses.map(m => { const h = hist.find(x => x.mes === m); return h ? h.nps : null; });
    const meta = meses.map(m => objNps.metas[m] ?? null);
    const csatMap = {}; zenMensal().forEach(r => csatMap[r.mes] = num(r.csat_humano));

    const ds = [
      { label: "Realizado", data: real, borderColor: C.blue, backgroundColor: C.blueFill,
        fill: true, tension: .3, borderWidth: 2.5, yAxisID: "y",
        // o mês que está sendo lido no painel ganha um ponto maior, em rosa
        pointRadius: meses.map(m => m === S.mes ? 7 : 4.5),
        pointBackgroundColor: meses.map(m => m === S.mes ? C.pink : C.blue),
        pointBorderColor: "#fff", pointBorderWidth: 2 },
      { label: "Meta", data: meta, borderColor: C.text, borderDash: [5,4], borderWidth: 1.6,
        backgroundColor: "transparent", tension: .3, pointRadius: 0, yAxisID: "y", spanGaps: true }
    ];
    if (comCsat) ds.push({ label: "CSAT humano", data: meses.map(m => csatMap[m] ?? null),
      borderColor: C.pink, backgroundColor: "transparent", borderWidth: 2, tension: .3,
      pointRadius: 3.5, pointBackgroundColor: C.pink, yAxisID: "y1", spanGaps: true });

    grafico("chart-historico", { type: "line", data: { labels: meses.map(mesCurto), datasets: ds },
      options: opcoes({ plugins: { legend: legenda() },
        scales: { y: { min: 0, max: 100, grid: { color: C.grid } },
                  y1: comCsat ? { min: 0, max: 5, position: "right", grid: { display: false } } : { display: false },
                  x: { grid: { display: false } } } }) });
  }

  function grafRadar() {
    const map = {}; (dados().media_por_pergunta || []).forEach(p => map[p.pergunta] = p.media);
    const rotulos = DIMENSOES.map(d => d.label);
    grafico("chart-radar", {
      type: "radar",
      data: { labels: rotulos.map(l => l.split(" ")[0]), datasets: [{
        data: rotulos.map(l => map[l] ?? null), borderColor: C.teal,
        backgroundColor: "rgba(0,195,197,.15)", borderWidth: 2, pointRadius: 3, pointBackgroundColor: C.teal }] },
      options: opcoes({ plugins: { legend: { display: false },
        tooltip: { callbacks: { title: i => rotulos[i[0].dataIndex], label: c => "Nota " + fmt(c.parsed.r, 2) } } },
        scales: { r: { min: 0, max: 5, ticks: { stepSize: 1, backdropColor: "transparent", font: { size: 9 } },
                       grid: { color: C.grid }, angleLines: { color: C.grid }, pointLabels: { font: { size: 10 } } } } }) });
  }

  function grafPerguntas() {
    const itens = [...(dados().media_por_pergunta || [])].sort((a,b) => b.media - a.media);
    grafico("chart-perguntas", {
      type: "bar",
      data: { labels: itens.map(i => i.pergunta), datasets: [{
        data: itens.map(i => i.media),
        backgroundColor: itens.map((_, i) => i === 0 ? C.teal : i === itens.length - 1 ? C.pink : C.blue),
        borderRadius: 4, maxBarThickness: 22 }] },
      options: opcoes({ indexAxis: "y",
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => "Nota " + fmt(c.parsed.x, 2) } } },
        scales: { x: { min: 0, max: 5, grid: { color: C.grid } }, y: { grid: { display: false } } } }) });
  }

  function grafSemanas() {
    const box = $("#semanas-wrap");
    const sem = semanasNps();
    if (!sem.length) {
      box.innerHTML = '<div class="empty">Sem quebra semanal para ' + mesLabel(S.mes).toLowerCase() +
        ". As semanas aparecem assim que houver respostas no mês.</div>";
      return;
    }
    box.innerHTML = '<div class="chart h240"><canvas id="chart-semanas"></canvas></div>' +
      '<div class="week-cards" id="week-cards"></div>';

    grafico("chart-semanas", {
      data: { labels: sem.map(s => s.label), datasets: [
        { type: "bar", label: "Respostas", data: sem.map(s => s.respostas), backgroundColor: "rgba(0,68,116,.16)",
          borderColor: "transparent", borderRadius: 4, maxBarThickness: 44, yAxisID: "y1", order: 2 },
        { type: "line", label: "NPS da semana", data: sem.map(s => s.nps), borderColor: C.teal,
          backgroundColor: "transparent", tension: .3, borderWidth: 2.6, yAxisID: "y", order: 1,
          // semana com poucas respostas fica com o ponto vazado, pra não passar por tendência
          pointRadius: sem.map(s => s.semana === S.semana ? 7 : s.respostas < MIN_SEMANA ? 4 : 4.5),
          pointBackgroundColor: sem.map(s => s.semana === S.semana ? C.pink
                                           : s.respostas < MIN_SEMANA ? "#fff" : C.teal),
          pointBorderColor: sem.map(s => s.respostas < MIN_SEMANA && s.semana !== S.semana ? C.teal : "#fff"),
          pointBorderWidth: 2, borderDash: [], segment: {
            borderDash: ctx => sem[ctx.p1DataIndex].respostas < MIN_SEMANA ? [5, 4] : undefined
          } } ] },
      options: opcoes({ plugins: { legend: legenda() },
        // sem semana negativa, a escala começa em zero — senão metade do gráfico ficaria vazia
        scales: { y: { min: sem.some(s => s.nps < 0) ? -100 : 0, max: 100, grid: { color: C.grid } },
                  y1: { position: "right", grid: { display: false }, beginAtZero: true,
                        title: { display: true, text: "respostas", font: { size: 10 } } },
                  x: { grid: { display: false } } } }) });

    $("#week-cards").innerHTML = sem.map(s => {
      const parcial = s.respostas < MIN_SEMANA;
      return '<button type="button" class="week' + (parcial ? " parcial" : "") +
        (s.semana === S.semana ? " ativa" : "") + '" data-semana="' + s.semana +
        '" title="Filtrar o painel por esta semana">' +
        '<div class="week-n">Semana ' + s.semana + (parcial ? ' <span class="week-tag">parcial</span>' : "") + "</div>" +
        '<div class="week-date">' + s.label + "</div>" +
        '<div class="week-nps tabular" style="color:' + (parcial ? "var(--gray-disabled)" : corNps(s.nps)) + '">' +
          fmt(s.nps, 1) + "</div>" +
        '<div class="week-meta">' + s.respostas + " respostas · " +
          s.promotores + "P " + s.neutros + "N " + s.detratores + "D</div>" +
        (parcial ? '<div class="week-meta">Amostra pequena demais para virar tendência.</div>' : "") +
      "</button>";
    }).join("");

    // clicar no cartão liga/desliga o filtro daquela semana
    $$("#week-cards .week").forEach(b => b.addEventListener("click", () => {
      const n = Number(b.dataset.semana);
      S.semana = S.semana === n ? null : n;
      S.espSel = null;
      $("#week-select").value = S.semana === null ? "" : String(S.semana);
      desenharMes();
    }));
  }

  function destaques() {
    const box = $("#insights"); box.innerHTML = "";
    if (!temNps()) {
      box.appendChild(el("li", "", "Sem respostas de NPS em " + recorteLabel() + " — nada a destacar ainda."));
      return;
    }
    const mes = S.mes, k = dados().kpi;
    const perg = [...(dados().media_por_pergunta || [])].sort((a,b) => b.media - a.media);
    const esp = especialidades().relevantes;
    const firmes = esp.filter(e => (e.n ?? 0) >= MIN_DESTAQUE);
    const melhor = [...firmes].sort((a,b) => b.nps - a.nps)[0];
    const pior = [...firmes].sort((a,b) => a.nps - b.nps)[0];
    const meta = metaDoMes("nps", mes);
    const itens = [];

    if (meta && S.semana === null) {   // a meta é do mês, não da semana
      const dif = k.nps_geral - meta;
      itens.push({ t: dif >= 0 ? "up" : "down",
        txt: dif >= 0
          ? "O índice está <b>" + fmt(dif,1) + " pontos acima</b> da meta do mês."
          : "O índice está <b>" + fmt(Math.abs(dif),1) + " pontos abaixo</b> da meta do mês." });
    }
    if (perg.length) itens.push({ t: "",
      txt: "A diferença entre a melhor e a pior dimensão é de <b>" +
           fmt(perg[0].media - perg[perg.length-1].media, 2) + " ponto</b>." });
    if (melhor && pior && melhor !== pior) itens.push({ t: "",
      txt: "<b>" + melhor.especialidade + "</b> lidera com NPS " + fmt(melhor.nps,1) +
           "; <b>" + pior.especialidade + "</b> fica em " + fmt(pior.nps,1) + "." });
    const pctDetr = k.detratores / (k.promotores + k.neutros + k.detratores) * 100;
    itens.push({ t: pctDetr > 15 ? "down" : "",
      txt: "Detratores são <b>" + fmt(pctDetr,1) + "%</b> da base — cada ponto percentual reduzido aqui vale cerca de um ponto de NPS." });

    itens.forEach(i => box.appendChild(el("li", i.t, i.txt)));
  }

  /* ---------- ESPECIALIDADES ---------- */
  function espIndicadores() {
    const { relevantes, pequenas } = especialidades();
    // "Melhor" e "pior" viram frase de diretoria — 100,0 tirado de 7 respostas
    // não sustenta isso. Os destaques exigem uma amostra bem maior que a lista.
    const firmes = relevantes.filter(e => (e.n ?? 0) >= MIN_DESTAQUE);
    const melhor = [...firmes].sort((a,b) => b.nps - a.nps)[0];
    const pior   = [...firmes].sort((a,b) => a.nps - b.nps)[0];
    const maior  = [...relevantes].sort((a,b) => b.pct_amostra - a.pct_amostra)[0];
    const comN = e => e.especialidade + " · " + e.n + " respostas";

    const cards = [
      { rot: "Na leitura", val: relevantes.length, casas: 0,
        nota: pequenas.length ? pequenas.length + " fora por amostra pequena" : "todas com amostra suficiente" },
      { rot: "Maior volume", val: maior ? maior.pct_amostra : null, casas: 1, suf: "%", nota: maior ? comN(maior) : "—" },
      { rot: "Melhor NPS", val: melhor ? melhor.nps : null, casas: 1,
        nota: melhor ? comN(melhor) : "sem amostra suficiente" },
      { rot: "Pior NPS", val: pior ? pior.nps : null, casas: 1,
        nota: pior ? comN(pior) : "sem amostra suficiente" }
    ];
    const box = $("#esp-stats"); box.innerHTML = "";
    cards.forEach(c => {
      const d = el("div", "metric",
        '<div class="metric-label">' + c.rot + '</div><div class="metric-value tabular">—</div>' +
        '<div class="metric-note">' + c.nota + "</div>");
      box.appendChild(d);
      conta(d.querySelector(".metric-value"), c.val, c.casas, c.suf);
    });
  }

  function espLista() {
    const { relevantes, pequenas } = especialidades();
    const lista = [...relevantes].sort((a,b) =>
      S.espOrdem === "nps" ? b.nps - a.nps : b.pct_amostra - a.pct_amostra);
    const box = $("#esp-ranks"); box.innerHTML = "";

    lista.forEach(item => {
      const row = el("div", "rank" + (S.espSel === item.especialidade ? " on" : ""),
        '<div class="rank-name">' + item.especialidade +
          "<span>" + item.n + " respostas · " + fmt(item.pct_amostra,1) + "% da amostra</span></div>" +
        '<div class="rank-track"><i class="rank-fill" style="display:block;width:0;background:' + corNps(item.nps) + '"></i></div>' +
        '<div class="rank-val" style="color:' + corNps(item.nps) + '">' + fmt(item.nps,1) + "</div>");
      row.addEventListener("click", () => selecionar(item.especialidade));
      box.appendChild(row);
      aoPintar(() => row.querySelector(".rank-fill").style.width = Math.max(0, (item.nps + 100) / 2) + "%");
    });

    if (pequenas.length) {
      box.appendChild(el("div", "excluded",
        '<div class="excluded-title">Amostra insuficiente (menos de ' + MIN_AMOSTRA + " respostas)</div>" +
        '<div class="excluded-list">' + pequenas.map(p =>
          "<span>" + p.especialidade + " <b>" + (p.n ?? "?") + "</b></span>").join("") + "</div>"));
    }
  }

  function selecionar(nome) {
    S.espSel = S.espSel === nome ? null : nome;
    espLista(); espDetalhe(); tabelaSatisfacao();
  }

  function espDetalhe() {
    const box = $("#esp-detail");
    if (!S.espSel) {
      // abre na especialidade que mais pesa no indice — card vazio nao informa nada
      const maior = [...especialidades().relevantes].sort((a,b) => b.pct_amostra - a.pct_amostra)[0];
      if (maior) S.espSel = maior.especialidade;
    }
    if (!S.espSel) {
      box.innerHTML = '<div class="empty">Selecione uma especialidade para ver as notas por dimensão.</div>';
      return;
    }
    const sat = (dados().satisfacao_por_especialidade || []).find(s => s.especialidade === S.espSel);
    const nps = (dados().nps_por_especialidade || []).find(s => s.especialidade === S.espSel);
    if (!sat) { box.innerHTML = '<div class="empty">Sem detalhamento para esta especialidade.</div>'; return; }

    box.innerHTML =
      '<div class="detail-name">' + sat.especialidade + "</div>" +
      '<div class="detail-meta">' + sat.n + " respostas · NPS " +
        '<b style="color:' + corNps(nps ? nps.nps : 0) + '">' + fmt(nps ? nps.nps : null, 1) + "</b></div>" +
      '<div class="detail-list">' + DIMENSOES.map(d => {
        const v = sat[d.key];
        const cor = v >= 4.2 ? C.positive : v >= 3.5 ? C.teal : v >= 3 ? C.amber : C.negative;
        return '<div class="detail-row"><div class="detail-top"><span>' + d.label + "</span>" +
          "<b>" + fmt(v, 2) + "</b></div>" +
          '<div class="detail-bar"><i style="width:' + ((v || 0) / 5 * 100) + '%;background:' + cor + '"></i></div></div>';
      }).join("") + "</div>";
  }

  function tabelaSatisfacao() {
    const head = $("#sat-head"), body = $("#tbl-satisfacao tbody");
    const cols = [{ k: "especialidade", l: "Especialidade", txt: true }, { k: "n", l: "Respostas", casas: 0 }]
      .concat(DIMENSOES.map(d => ({ k: d.key, l: d.label, casas: 2 })));

    head.innerHTML = cols.map(c => {
      const ord = S.satOrdem.col === c.k;
      return '<th class="sortable ' + (c.txt ? "" : "num ") + (ord ? "sorted" : "") + '" data-col="' + c.k + '">' +
        c.l + '<span class="arr">' + (ord ? (S.satOrdem.dir === 1 ? "▲" : "▼") : "▲") + "</span></th>";
    }).join("");
    head.querySelectorAll("th").forEach(th => th.addEventListener("click", () => {
      const col = th.dataset.col;
      if (S.satOrdem.col === col) S.satOrdem.dir *= -1;
      else { S.satOrdem.col = col; S.satOrdem.dir = col === "especialidade" ? 1 : -1; }
      tabelaSatisfacao();
    }));

    const linhas = [...(dados().satisfacao_por_especialidade || [])].sort((a,b) => {
      const va = a[S.satOrdem.col], vb = b[S.satOrdem.col];
      if (typeof va === "string") return S.satOrdem.dir * va.localeCompare(vb);
      return S.satOrdem.dir * ((va ?? -Infinity) - (vb ?? -Infinity));
    });

    body.innerHTML = "";
    linhas.forEach(r => {
      const tr = el("tr", S.espSel === r.especialidade ? "on" : "",
        '<td class="strong">' + r.especialidade + "</td>" +
        '<td class="num" style="color:var(--gray-body)">' + r.n + "</td>" +
        DIMENSOES.map(d => '<td class="num"><span class="score ' + classeNota(r[d.key]) + '">' +
          fmt(r[d.key], 2) + "</span></td>").join(""));
      tr.style.cursor = "pointer";
      tr.addEventListener("click", () => selecionar(r.especialidade));
      body.appendChild(tr);
    });
  }

  /* ---------- SAC ---------- */
  function sac() {
    const mensal = zenMensal();
    const preenchidos = mensal.filter(r =>
      ["csat_ia","csat_humano","fcr_pct","resolucao_ia_pct"].some(c => num(r[c]) !== null) ||
      (r.tma_primeira_resposta || "").trim() || (r.tmr || "").trim());
    // segue o mês escolhido no topo; se ele ainda não foi preenchido, mostra o último que foi
    const escolhido = preenchidos.findIndex(r => r.mes === S.mes);
    const pos = escolhido >= 0 ? escolhido : preenchidos.length - 1;
    const atual = preenchidos[pos];
    const anterior = pos > 0 ? preenchidos[pos - 1] : null;

    function variacao(campo, inverso) {
      if (!atual || !anterior) return "";
      const a = num(atual[campo]), b = num(anterior[campo]);
      if (a === null || b === null || b === 0) return "";
      const p = (a - b) / Math.abs(b) * 100;
      const bom = inverso ? p < 0 : p > 0;
      return '<span class="delta ' + (bom ? "up" : "down") + '">' + (p >= 0 ? "+" : "−") + fmt(Math.abs(p),1) + "%</span>";
    }

    $("#sac-ref").innerHTML = atual
      ? "Números de " + (atual.mes_label || mesLabel(atual.mes)) +
        (anterior ? " · variação contra " + (anterior.mes_label || mesLabel(anterior.mes)).toLowerCase() : "") +
        (escolhido < 0 ? " · " + mesLabel(S.mes).toLowerCase() + " ainda não foi preenchido" : "")
      : "Nenhum mês preenchido ainda";

    const cards = [
      { rot: "CSAT humano", val: atual ? num(atual.csat_humano) : null, casas: 2, nota: "Escala 0 a 5" + variacao("csat_humano") },
      { rot: "CSAT IA", val: atual ? num(atual.csat_ia) : null, casas: 2, nota: "Escala 0 a 5" + variacao("csat_ia") },
      { rot: "Resolução com IA", val: atual ? num(atual.resolucao_ia_pct) : null, casas: 0, suf: "%", nota: "Sem intervenção humana" + variacao("resolucao_ia_pct") },
      { rot: "FCR", val: atual ? num(atual.fcr_pct) : null, casas: 1, suf: "%", nota: "Resolvido no primeiro contato" + variacao("fcr_pct") },
      { rot: "TMA 1ª resposta", txt: (atual && atual.tma_primeira_resposta) || "—", nota: "Tempo médio de atendimento" },
      { rot: "TMR", txt: (atual && atual.tmr) || "—", nota: "Tempo médio de resolução" }
    ];
    const box = $("#sac-stats"); box.innerHTML = "";
    cards.forEach(c => {
      const d = el("div", "metric",
        '<div class="metric-label">' + c.rot + "</div>" +
        '<div class="metric-value tabular">' + (c.txt !== undefined ? c.txt : "—") + "</div>" +
        '<div class="metric-note">' + c.nota + "</div>");
      box.appendChild(d);
      if (c.txt === undefined) conta(d.querySelector(".metric-value"), c.val, c.casas, c.suf);
    });

    const meses = mensal.map(r => r.mes);
    grafico("chart-csat", { type: "line",
      data: { labels: meses.map(mesCurto), datasets: [
        { label: "Humano", data: mensal.map(r => num(r.csat_humano)), borderColor: C.blue, backgroundColor: C.blueFill,
          fill: true, tension: .3, borderWidth: 2.4, pointRadius: 4, pointBackgroundColor: C.blue, pointBorderColor: "#fff", pointBorderWidth: 2 },
        { label: "IA", data: mensal.map(r => num(r.csat_ia)), borderColor: C.teal, backgroundColor: "transparent",
          borderDash: [4,3], tension: .3, borderWidth: 2, pointRadius: 3.5, pointBackgroundColor: C.teal } ] },
      options: opcoes({ plugins: { legend: legenda() },
        scales: { y: { min: 0, max: 5, grid: { color: C.grid } }, x: { grid: { display: false } } } }) });

    grafico("chart-fcr", { type: "line",
      data: { labels: meses.map(mesCurto), datasets: [
        { label: "FCR", data: mensal.map(r => num(r.fcr_pct)), borderColor: C.teal, backgroundColor: C.tealFill,
          fill: true, tension: .3, borderWidth: 2.4, pointRadius: 4, pointBackgroundColor: C.teal, pointBorderColor: "#fff", pointBorderWidth: 2 },
        { label: "Resolução com IA", data: mensal.map(r => num(r.resolucao_ia_pct)), borderColor: C.pink,
          backgroundColor: "transparent", tension: .3, borderWidth: 2, pointRadius: 3.5, pointBackgroundColor: C.pink } ] },
      options: opcoes({ plugins: { legend: legenda(), tooltip: { callbacks: { label: c => c.dataset.label + ": " + fmt(c.parsed.y,1) + "%" } } },
        scales: { y: { min: 0, grid: { color: C.grid }, ticks: { callback: v => v + "%" } }, x: { grid: { display: false } } } }) });

    const sem = zenSemanal(S.mes);
    const subSem = $("#sac-sem-sub");
    if (subSem) subSem.textContent = "Semanas de " + mesLabel(S.mes).toLowerCase() + ", preenchidas à mão";
    grafico("chart-wow", { data: { labels: sem.map(r => "Semana " + r.semana), datasets: [
        { type: "bar", label: "FCR", data: sem.map(r => num(r.fcr_pct)), backgroundColor: C.tealFill,
          borderColor: C.teal, borderWidth: 1.5, borderRadius: 4, maxBarThickness: 38, yAxisID: "y" },
        { type: "line", label: "CSAT humano", data: sem.map(r => num(r.csat_humano)), borderColor: C.blue,
          backgroundColor: "transparent", tension: .3, borderWidth: 2.4, pointRadius: 4, pointBackgroundColor: C.blue, yAxisID: "y1" } ] },
      options: opcoes({ plugins: { legend: legenda() },
        scales: { y: { min: 0, max: 100, grid: { color: C.grid }, ticks: { callback: v => v + "%" } },
                  y1: { min: 0, max: 5, position: "right", grid: { display: false } },
                  x: { grid: { display: false } } } }) });

    const tb = $("#tbl-zendesk tbody"); tb.innerHTML = "";
    mensal.forEach(r => tb.appendChild(el("tr", "",
      '<td class="strong">' + (r.mes_label || mesLabel(r.mes)) + "</td>" +
      '<td class="num">' + fmt(num(r.csat_ia), 2) + "</td>" +
      '<td class="num">' + fmt(num(r.csat_humano), 2) + "</td>" +
      '<td class="num">' + (r.tma_primeira_resposta || "—") + "</td>" +
      '<td class="num">' + (r.tmr || "—") + "</td>" +
      '<td class="num">' + (r.fcr_pct ? fmt(num(r.fcr_pct),1) + "%" : "—") + "</td>" +
      '<td class="num">' + (r.resolucao_ia_pct ? fmt(num(r.resolucao_ia_pct),0) + "%" : "—") + "</td>")));

    const ts = $("#tbl-semanal tbody"); ts.innerHTML = "";
    if (!sem.length) ts.innerHTML = '<tr><td colspan="7" class="empty">Nenhuma semana preenchida para ' +
      mesLabel(S.mes).toLowerCase() + ".</td></tr>";
    sem.forEach(r => ts.appendChild(el("tr", "",
      '<td class="strong">Semana ' + r.semana + "</td><td>" + (r.periodo || "—") + "</td>" +
      '<td class="num">' + fmt(num(r.csat_ia), 2) + "</td>" +
      '<td class="num">' + fmt(num(r.csat_humano), 2) + "</td>" +
      '<td class="num">' + (r.tma_primeira_resposta || "—") + "</td>" +
      '<td class="num">' + (r.tmr || "—") + "</td>" +
      '<td class="num">' + (r.fcr_pct ? fmt(num(r.fcr_pct),1) + "%" : "—") + "</td>")));
  }

  /* ---------- METAS ---------- */
  function metas() {
    const mes = S.mes;
    const box = $("#goal-cards"); box.innerHTML = "";

    (S.metas.objetivos || []).forEach(o => {
      const st = status(o, mes);
      const ok = st.att !== null && st.att >= 100;
      box.appendChild(el("div", "card goal",
        '<div class="goal-tag">Meta ' + mesCurto(mes).toLowerCase() + ": " + fmt(st.meta, o.casas) + unidade(o) + "</div>" +
        '<div class="goal-desc">' + o.descricao + "</div>" +
        '<div class="goal-num tabular">' + fmt(st.real, o.casas) + unidade(o) + "</div>" +
        (st.defasada ? '<div class="goal-warn">Acima do alvo de dezembro — meta a revisar</div>' : "") +
        '<div class="goal-foot"><span>Real vs. meta</span>' +
          '<div class="goal-att tabular ' + (st.defasada ? "stale" : ok ? "ok" : "off") + '">' + st.texto + "</div></div>"));
    });

    const objs = S.metas.objetivos || [];
    const meses = Array.from(new Set(objs.flatMap(o => Object.keys(o.metas || {})))).sort();
    const cores = [C.blue, C.teal, C.pink, C.amber];
    const ds = [];
    objs.forEach((o, i) => {
      ds.push({ label: o.label, data: meses.map(m => { const r = realizado(o, m); return r === null ? null : Math.round(r / o.alvo_final * 100); }),
        borderColor: cores[i % 4], backgroundColor: "transparent", borderWidth: 2.4, tension: .3,
        pointRadius: 4, pointBackgroundColor: cores[i % 4] });
      ds.push({ label: o.label + " (meta)", data: meses.map(m => { const v = o.metas[m]; return v === undefined ? null : Math.round(v / o.alvo_final * 100); }),
        borderColor: cores[i % 4], backgroundColor: "transparent", borderWidth: 1.3, borderDash: [4,4],
        tension: .3, pointRadius: 0, spanGaps: true });
    });
    grafico("chart-meta", { type: "line", data: { labels: meses.map(mesCurto), datasets: ds },
      options: opcoes({ plugins: { legend: legenda(10, true), tooltip: { callbacks: { label: c => c.dataset.label + ": " + c.parsed.y + "% do alvo" } } },
        scales: { y: { min: 0, grid: { color: C.grid }, ticks: { callback: v => v + "%" } }, x: { grid: { display: false } } } }) });

    const gaps = $("#meta-gaps"); gaps.innerHTML = "";
    objs.forEach(o => {
      const real = realizado(o, mes);
      const pct = real === null ? null : Math.round(real / o.alvo_final * 100);
      const falta = real === null ? null : o.alvo_final - real;
      gaps.appendChild(el("div", "gap-row",
        '<div class="gap-top"><span class="gap-name">' + o.label + "</span>" +
          '<span class="gap-pct tabular" style="color:' + (pct >= 100 ? "#009131" : pct >= 80 ? C.blue : "#96700B") + '">' +
          (pct === null ? "—" : pct + "%") + "</span></div>" +
        '<div class="gap-note">' +
          (falta === null ? "sem dado no mês"
            : falta <= 0 ? "alvo de dezembro já atingido"
            : "faltam " + fmt(falta, o.casas) + (o.unidade === "%" ? " pontos percentuais" : " pontos") +
              " para o alvo de " + fmt(o.alvo_final, 0) + unidade(o)) + "</div>"));
    });
  }

  /* ---------- ALAVANCAS ---------- */
  const alavancas = () => timeline(S.mes);

  function timeline(mes) {
    const box = $("#timeline"); box.innerHTML = "";
    const semanas = zenSemanal(mes).filter(r => r.narrativa);
    if (!semanas.length) {
      box.innerHTML = '<li class="empty">Nenhuma alavanca registrada para ' + mesLabel(mes).toLowerCase() + ".</li>";
      return;
    }
    semanas.forEach((r, i) => {
      const tags = [];
      if (r.fcr_pct) tags.push("FCR <b>" + fmt(num(r.fcr_pct),1) + "%</b>");
      if (r.csat_humano) tags.push("CSAT <b>" + fmt(num(r.csat_humano),2) + "</b>");
      if (r.tmr) tags.push("TMR <b>" + r.tmr + "</b>");
      if (r.resolucao_ia_pct) tags.push("Resolução IA <b>" + fmt(num(r.resolucao_ia_pct),0) + "%</b>");
      box.appendChild(el("li", "tl" + (i === semanas.length - 1 ? " now" : ""),
        '<div class="tl-when"><div class="tl-week">Semana ' + r.semana + "</div>" +
          '<div class="tl-date">' + (r.periodo || "") + "</div></div>" +
        '<div class="tl-body"><div class="tl-text">' + r.narrativa + "</div>" +
          (tags.length ? '<div class="tl-tags">' + tags.map(t => "<span>" + t + "</span>").join("") + "</div>" : "") +
        "</div>"));
    });
  }

  /* ---------- Chart.js ---------- */
  function opcoes(extra) {
    return Object.assign({
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { tooltip: {
        backgroundColor: "#202020", padding: 11, cornerRadius: 8,
        titleFont: { family: "'Open Sans', sans-serif", size: 12, weight: "600" },
        bodyFont: { family: "'Open Sans', sans-serif", size: 12 },
        displayColors: true, boxPadding: 4
      } }
    }, extra);
  }
  function legenda(size, semMetas) {
    return { display: true, position: "bottom",
      labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true, pointStyle: "circle",
                padding: 14, font: { size: size || 11 },
                filter: semMetas ? item => !item.text.endsWith("(meta)") : undefined } };
  }
  function grafico(id, cfg) {
    const canvas = document.getElementById(id);
    if (!canvas) return;
    if (S.charts[id]) S.charts[id].destroy();
    S.charts[id] = new Chart(canvas, cfg);
  }

  /* ---------- init ---------- */
  async function init() {
    Chart.defaults.font.family = "'Open Sans', system-ui, sans-serif";
    Chart.defaults.font.size = 11.5;
    Chart.defaults.color = C.text;

    await carregar();
    S.mes = S.nps.current_month;
    navegacao();
    topo();

    desenharMes();

    $$("#seg-hist button").forEach(b => b.addEventListener("click", () => {
      $$("#seg-hist button").forEach(x => x.classList.toggle("active", x === b));
      S.histCsat = b.dataset.series === "csat";
      grafHistorico(S.histCsat);
    }));
    $$("#seg-esp button").forEach(b => b.addEventListener("click", () => {
      $$("#seg-esp button").forEach(x => x.classList.toggle("active", x === b));
      S.espOrdem = b.dataset.sort;
      espLista();
    }));
    const tSat = $("#toggle-sat"), wSat = $("#sat-wrap");
    if (tSat && wSat) tSat.addEventListener("click", () => {
      const aberto = !wSat.hidden;
      wSat.hidden = aberto;
      tSat.textContent = aberto ? "Ver tabela" : "Ocultar tabela";
    });
  }

  init().catch(err => {
    console.error(err);
    $(".page-wrap").insertAdjacentHTML("afterbegin",
      '<div class="notice"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/></svg>' +
      "<span>Não foi possível carregar os dados. Detalhes no console do navegador.</span></div>");
  });
})();
