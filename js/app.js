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
    chumbo: "#4A4A68",
    cinzaMeta: "#B9BFC9",
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
  const S = { nps: null, metas: null, zendesk: [], charts: {}, oc: null, onb: null, com: null, focos: null, zt: null,
              sacMes: null, ocMes: null, ocVista: "classe", tkMes: null, tkInd: null, comFiltro: null, mes: null, semana: null,   // semana segue nula: o painel e sempre mensal
             
              evoDim: null, evoEsp: null, pagina: "nps",
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

  /** Sempre devolve uma estrutura utilizável, mesmo em mês sem respostas. */
  const dados = mes => blocoDoMes(mes) || SEM_DADOS;
  const temNps = mes => blocoDoMes(mes) !== null;

  /** "notion" para os meses apurados à mão, "databricks" para os da tabela. */
  const origemDoMes = mes => (blocoDoMes(mes) || {}).origem || "databricks";
  const doNotion = mes => origemDoMes(mes) === "notion";

  /* Os dados chegam de dois jeitos, e o painel aceita os dois sem saber a
     diferença: servidos como arquivo (GitHub Pages, servidor local) ou já
     embutidos na página em window.DADOS (Apps Script, que não serve arquivo
     nenhum — não existe fetch de caminho relativo lá dentro). */
  const embutido = nome => (window.DADOS || {})[nome];

  async function buscarJson(nome, arquivo, padrao) {
    const pronto = embutido(nome);
    if (pronto !== undefined) return pronto;
    try {
      const r = await fetch(arquivo, { cache: "no-store" });
      return r.ok ? await r.json() : padrao;
    } catch (e) { return padrao; }
  }

  async function carregar() {
    const [nps, metas, zen, oc, onb, com, foc, zt] = await Promise.all([
      buscarJson("nps", "data/nps.json", null),
      buscarJson("metas", "data/metas.json", { objetivos: [] }),
      carregarZendesk(),
      buscarJson("ocorrencias", "data/ocorrencias.json", null),
      buscarJson("onboarding", "data/onboarding.json", null),
      buscarJson("comentarios", "data/comentarios.json", null),
      buscarJson("focos", "data/focos.json", null),
      buscarJson("zendesk_tickets", "data/zendesk_tickets.json", null)
    ]);
    if (!nps) throw new Error("Não consegui carregar os dados de NPS.");
    S.nps = nps; S.metas = metas; S.zendesk = zen; S.oc = oc;
    S.onb = onb; S.com = com; S.focos = foc; S.zt = zt;
  }

  async function carregarZendesk() {
    const pronto = embutido("zendesk");
    if (pronto !== undefined) return parseCSV(pronto);
    const url = window.NPS_CONFIG && window.NPS_CONFIG.ZENDESK_CSV_URL;
    if (url) {
      try { const r = await fetch(url, { cache: "no-store" }); if (r.ok) return parseCSV(await r.text()); }
      catch (e) { console.warn("Fonte externa indisponível, usando o arquivo do repositório.", e); }
    }
    try {
      const r = await fetch("data/zendesk_semanal.csv", { cache: "no-store" });
      return r.ok ? parseCSV(await r.text()) : [];
    } catch (e) { return []; }
  }

  const zenMensal  = () => S.zendesk.filter(r => (num(r.semana) ?? 0) === 0).sort((a,b) => a.mes.localeCompare(b.mes));
  const zenSemanal = mes => S.zendesk.filter(r => r.mes === mes && (num(r.semana) ?? 0) > 0).sort((a,b) => num(a.semana) - num(b.semana));
  const zenMes     = mes => zenMensal().find(r => r.mes === mes) || null;

  const objetivo = id => (S.metas.objetivos || []).find(o => o.id === id) || null;
  function metaDoMes(id, mes) {
    const o = objetivo(id);
    const bruto = o && o.metas ? (o.metas[mes] ?? null) : null;
    if (bruto === null) return null;
    return o.unidade === "tempo" ? minutosDeTempo(bruto) : bruto;
  }
  function realizado(o, mes) {
    if (!o) return null;
    if (o.fonte_realizado === "nps") {
      const h = (S.nps.historico_nps || []).find(x => x.mes === mes);
      return h ? h.nps : null;
    }
    if (!o.fonte_realizado) return null;
    const campo = String(o.fonte_realizado || "").split(":")[1];
    const linha = zenMes(mes);
    if (!linha) return null;
    // TMA e TMR sao texto ("10h", "12h48") — viram minutos para poder comparar
    return o.unidade === "tempo" ? minutosDeTempo(linha[campo]) : num(linha[campo]);
  }
  /* Acima disso o atingimento deixa de informar: 458% não diz que o indicador
     vai bem, diz que a meta do mês está defasada. */
  const ATT_DEFASADA = 150;

  function status(o, mes) {
    const meta = metaDoMes(o.id, mes), real = realizado(o, mes);
    // Em TMA e TMR a meta e um teto: cumprir e ficar ABAIXO dela. Usar
    // real/meta ali diria que demorar mais e "atingir mais".
    const menorMelhor = o.sentido === "menor_melhor";
    const att = (meta && real !== null && real !== 0)
      ? Math.round((menorMelhor ? meta / real : real / meta) * 100) : null;
    const defasada = att !== null && att >= ATT_DEFASADA;
    return {
      meta, real, att, defasada,
      cls: att === null ? "risco" : att >= 100 ? "ok" : att >= 85 ? "risco" : "off",
      // o que mostrar no lugar do número quando ele perde o sentido
      texto: att === null ? "—"
           : defasada ? (menorMelhor ? meta / real : real / meta).toFixed(1).replace(".", ",") + "×"
           : att + "%",
      palavra: att === null ? (meta === null && real !== null ? "sem meta no mês" : "sem dado")
             : defasada ? "meta defasada"
             : att >= 100 ? "no alvo" : att >= 85 ? "atenção" : "atrasado"
    };
  }
  const unidade = o => (o.unidade === "%" ? "%" : "");
  /** Formata o realizado/meta de um objetivo respeitando a unidade. */
  const mostrarObjetivo = (o, v) => o.unidade === "tempo" ? tempoDeMinutos(v) : fmt(v, o.casas) + unidade(o);

  /** Especialidades com amostra suficiente vs. as que não sustentam leitura. */
  function especialidades() {
    const n = {};
    (dados().satisfacao_por_especialidade || []).forEach(s => n[s.especialidade] = s.n);
    const todas = (dados().nps_por_especialidade || []).map(e => Object.assign({ n: n[e.especialidade] ?? null }, e));
    // Nos meses do Notion não guardamos o tamanho da amostra; a lista de lá já
    // vinha filtrada, então entra inteira em vez de sumir por falta do "n".
    if (doNotion()) return { relevantes: todas, pequenas: [] };
    return {
      relevantes: todas.filter(e => (e.n ?? 0) >= MIN_AMOSTRA),
      pequenas:   todas.filter(e => (e.n ?? 0) < MIN_AMOSTRA)
    };
  }

  /* ---------- navegação ---------- */
  const PAGES = {
    nps:         { t: "NPS" },
    sac:         { t: "Suporte" },
    tickets:     { t: "Análise de tickets" },
    ocorrencias: { t: "Ocorrências" },
    onboarding:  { t: "Onboarding" }
  };

  function navegacao() {
    $$(".nav-item").forEach(btn => btn.addEventListener("click", () => irPara(btn.dataset.page)));
    $$(".nav-sub-item").forEach(btn =>
      btn.addEventListener("click", () => irPara(btn.dataset.page)));
    const mt = $("#menu-toggle");
    if (mt) mt.addEventListener("click", () => $("#sidebar").classList.toggle("open"));
  }

  /* Troca de aba. Analise de tickets e uma aba como as outras — o que muda e
     que ela mora dentro do grupo do Suporte no menu, entao o grupo fica aberto
     enquanto qualquer uma das duas estiver em cima. */
  function irPara(p) {
    if (!PAGES[p]) return;
    $$(".nav-item, .nav-sub-item").forEach(b => b.classList.toggle("active", b.dataset.page === p));
    $$(".page").forEach(x => x.classList.toggle("active", x.id === "page-" + p));
    $("#page-title").textContent = PAGES[p].t;
    $("#sidebar").classList.remove("open");
    $$(".nav-grupo").forEach(g =>
      g.classList.toggle("aberto", !!g.querySelector('[data-page="' + p + '"]')));
    S.pagina = p;
    graficosDa(p);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* Rolando pela pagina de Suporte, o subitem acende sozinho quando a secao
     de tickets entra na tela — sem isso o menu mentiria sobre onde a pessoa
     esta depois do primeiro scroll.

     Uma comparacao de posicao, e nao IntersectionObserver: a secao tem 1.500px
     de altura e o que interessa nao e ela estar visivel, e sim a leitura ja
     ter chegado nela. */


  function aviso(msg) {
    const slot = $("#alert-slot"); slot.innerHTML = "";
    const a = el("div", "notice",
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/></svg><span>' + msg + "</span>");
    slot.appendChild(a);
    setTimeout(() => a.remove(), 6000);
  }

  /* ---------- RESUMO EXECUTIVO ---------- */
  /** Redesenha tudo que depende do mês selecionado. */
  /* O painel nao pergunta mais o mes: mostra sempre o mais recente que tem
     dado. Em vez do seletor, o que fica no topo e a idade do numero — e isso
     que diz se da para confiar nele agora. */
  function topo() {
    const d = new Date(S.nps.generated_at);
    const data = d.toLocaleDateString("pt-BR") + " às " +
                 d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    const horas = (Date.now() - d.getTime()) / 36e5;
    const idade = horas < 1 ? "agora há pouco"
                : horas < 24 ? "há " + Math.round(horas) + "h"
                : "há " + Math.round(horas / 24) + " dia" + (horas >= 48 ? "s" : "");

    const caixa = $("#updated-box");
    if (caixa) caixa.title = "Atualizado em " + data;
    $("#updated-text").textContent = "Atualizado " + idade;
    // acima de uma semana o dado ja passou da proxima coleta
    if (caixa) caixa.classList.toggle("velho", horas > 24 * 8);

    const rodape = $("#foot-updated");
    if (rodape) rodape.textContent = "Atualizado em " + data;
  }

  function desenharMes() {
    /* So um aviso sobrevive: o mes apurado a mao no Notion nao tem a mesma
       quebra que os do Databricks, e quem le precisa saber disso. */
    const slot = $("#alert-slot");
    slot.innerHTML = !temNps()
      ? '<div class="notice"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/></svg>' +
        "<span>Ainda não há respostas de NPS em " + mesLabel(S.mes).toLowerCase() + ".</span></div>"
      : doNotion()
      ? '<div class="notice"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/></svg>' +
        "<span><b>" + mesLabel(S.mes) + "</b> foi apurado à mão, antes de o NPS entrar no Databricks. " +
        "Só o índice geral, a nota por dimensão e o NPS por especialidade existem nesse mês.</span></div>"
      : "";

    heroi(); farol(); focos(); leitura();
    espLista(); espDetalhe(); cruzamento();
    graficosDa(S.pagina);
  }

  /* Chart.js grava o tamanho no canvas quando o gráfico nasce. Nascendo numa
     aba oculta ele fica 0x0 para sempre — resize() e update() não recuperam,
     porque o tamanho em cache continua zero. Por isso cada aba só desenha os
     próprios gráficos, e só quando está visível. */
  const GRAFICOS = {
    nps:         () => { grafHistorico(); grafEvolucaoDimensoes(); grafEvolucaoEspecialidades(); },
    sac:         () => { sac(); },
    tickets:     () => { tickets(); },
    ocorrencias: () => { ocorrencias(); },
    onboarding:  () => { onboarding(); }
  };
  function graficosDa(pagina) {
    const fn = GRAFICOS[pagina];
    if (fn) fn();
  }

  function heroi() {
    const k = dados().kpi, mes = S.mes;
    $("#hero-month").textContent = mesLabel(mes) + " de " + mes.slice(0, 4);
    conta($("#hero-nps"), k.nps_geral, 1);
    $("#hero-desc").textContent =
      !temNps() ? "Ainda não há respostas de NPS em " + mesLabel(mes).toLowerCase() + "."
      : k.total_respostas === null
        ? "Mês apurado à mão, antes do Databricks."
        : k.total_respostas + " respostas de " +
          (k.convites_enviados ? k.convites_enviados + " convites" : "campanha");

    const tag = $("#hero-tag");
    if (typeof k.nps_geral_variacao_pct === "number") {
      const sobe = k.nps_geral_variacao_pct >= 0;
      tag.className = "hero-tag " + (sobe ? "up" : "down");
      tag.textContent = (sobe ? "+" : "−") + fmt(Math.abs(k.nps_geral_variacao_pct), 1) +
                        "% vs. mês anterior";
    } else {
      tag.className = "hero-tag";
      tag.textContent = temNps() ? "primeiro mês da série" : "sem respostas ainda";
    }

    const total = k.promotores + k.neutros + k.detratores || 1;
    $("#hero-facts").innerHTML = [
      ["Promotores", k.promotores, C.positive],
      ["Neutros", k.neutros, C.amber],
      ["Detratores", k.detratores, C.negative],
      ["Respostas", k.total_respostas, null]
    ].map(([rot, val, cor]) =>
      '<div><div class="fact-value tabular">' +
        (cor ? '<span class="dot" style="background:' + cor + '"></span>' : "") +
        (temNps() && val !== null && val !== undefined ? val : "—") +
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
        "<div><span>Realizado</span><b>" + fmt(kMes.nps_geral,1) + "</b></div>" +
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
        '<div class="farol-nums"><div class="farol-real tabular">' + mostrarObjetivo(o, st.real) + "</div>" +
          '<div class="farol-meta">meta ' + mostrarObjetivo(o, st.meta) + "</div></div>" +
        '<div class="farol-status"><div class="farol-att tabular ' + (st.defasada ? "stale" : st.cls) + '">' +
          st.texto + "</div>" +
          '<div class="farol-word">' + st.palavra + "</div></div>"));
    });
  }

  function leitura() {
    const box = $("#notes"); box.innerHTML = "";
    $("#notes-label").textContent = "Destaques do mês";
    const mes = S.mes, k = dados().kpi, itens = [];

    const stNps = status(objetivo("nps") || { id: "nps", casas: 1 }, mes);
    if (stNps.meta && temNps()) {
      const dif = k.nps_geral - stNps.meta;
      itens.push({ t: dif >= 0 ? "up" : "down",
        txt: "O NPS fechou <b>" + fmt(k.nps_geral,1) + "</b> contra meta de <b>" + fmt(stNps.meta,1) + "</b> — " +
             (dif >= 0 ? fmt(dif,1) + " pontos acima" : fmt(Math.abs(dif),1) + " pontos abaixo") +
             ", ou " + stNps.att + "% do esperado para " + mesLabel(mes).toLowerCase() + "." });
    }

    /* Sem seletor de semana, a comparacao semanal e feita sozinha: as duas
       ultimas semanas do mes. E o movimento mais recente que existe. */
    const semanas = semanasNps();
    const ultima = semanas[semanas.length - 1], penultima = semanas[semanas.length - 2];
    if (ultima && penultima) {
      const dif = ultima.nps - penultima.nps;
      itens.push({ t: dif >= 0 ? "up" : "down",
        txt: "Da semana " + penultima.semana + " para a " + ultima.semana + " o NPS " +
             (dif >= 0 ? "subiu <b>" : "caiu <b>") + fmt(Math.abs(dif), 1) + " pontos</b> (" +
             fmt(penultima.nps, 1) + " → " + fmt(ultima.nps, 1) + ")." });
    }
    if (ultima && ultima.respostas < MIN_SEMANA) itens.push({ t: "down",
      txt: "A última semana teve só <b>" + ultima.respostas + " respostas</b> — serve de sinal, não de conclusão." });

    const objs = S.metas.objetivos || [];
    const sts = objs.map(o => ({ o, st: status(o, mes) }));
    const validos = sts.filter(x => !x.st.defasada && x.st.att !== null);
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

    const maior = [...especialidades().relevantes].sort((a,b) => (b.pct_amostra ?? 0) - (a.pct_amostra ?? 0))[0];
    if (maior && maior.pct_amostra !== null && maior.pct_amostra !== undefined) itens.push({ t: "",
      txt: "<b>" + maior.especialidade + "</b> concentra " + fmt(maior.pct_amostra,1) +
           "% das respostas" +
           (maior.taxa_resposta ? " (" + fmt(maior.taxa_resposta,1) + "% dos convites do grupo foram respondidos)" : "") +
           " — o índice geral se move principalmente com esse grupo." });

    itens.forEach(i => box.appendChild(el("li", i.t, i.txt)));
  }

  /* Evolucao do NPS: indice, promotores, neutros, detratores, meta e o volume
     de respostas — tudo num grafico so, como o board le.

     Duas escalas: o indice e a meta vao de 0 a 100 na esquerda; as contagens
     tem ordem de grandeza propria e vivem na direita. A meta e a unica linha
     tracejada do painel inteiro, porque e o unico indicador daqui com meta. */
  function grafHistorico() {
    const hist = S.nps.historico_nps || [];
    const objNps = objetivo("nps") || { metas: {} };
    const meses = Array.from(new Set([...hist.map(h => h.mes),
                                      ...Object.keys(objNps.metas || {})])).sort();
    const doMes = m => (S.nps.meses || {})[m];
    const contagem = campo => meses.map(m => {
      const b = doMes(m);
      return b && b.kpi && b.kpi[campo] !== null && b.kpi[campo] !== undefined ? b.kpi[campo] : null;
    });

    const real = meses.map(m => { const h = hist.find(x => x.mes === m); return h ? h.nps : null; });
    const meta = meses.map(m => objNps.metas[m] ?? null);

    const ds = [
      { label: "NPS", data: real, borderColor: C.blue, backgroundColor: C.blueFill,
        fill: true, tension: .3, borderWidth: 2.8, yAxisID: "y",
        // trecho apurado a mao fica tracejado: mesma serie, confiabilidade diferente
        segment: { borderDash: ctx => (S.nps.meses_do_notion || []).includes(meses[ctx.p1DataIndex])
                                      ? [6, 4] : undefined },
        pointRadius: meses.map(m => m === S.mes ? 7 : 4.5),
        pointBackgroundColor: meses.map(m => m === S.mes ? C.pink : C.blue),
        pointBorderColor: "#fff", pointBorderWidth: 2,
        rotulo: { casas: 1, cor: C.blue } },
      { label: "Meta", data: meta, borderColor: C.cinzaMeta, borderDash: [5, 4], borderWidth: 1.8,
        backgroundColor: "transparent", tension: .3, pointRadius: 0, yAxisID: "y", spanGaps: true,
        rotulo: { casas: 0, cor: C.cinzaMeta, soUltimo: true } }
    ];

    [["Promotores", "promotores", C.positive],
     ["Neutros", "neutros", C.amber],
     ["Detratores", "detratores", C.negative],
     ["Respostas", "total_respostas", C.chumbo]].forEach(([rot, campo, cor]) => {
      ds.push({ label: rot, data: contagem(campo), borderColor: cor,
        backgroundColor: "transparent", borderWidth: rot === "Respostas" ? 2.4 : 2,
        borderDash: rot === "Respostas" ? [3, 3] : undefined,
        tension: .3, pointRadius: 3.5, pointBackgroundColor: cor,
        yAxisID: "y1", spanGaps: true,
        rotulo: { casas: 0, cor: cor, soUltimo: true } });
    });

    grafico("chart-historico", { type: "line",
      data: { labels: meses.map(mesCurto), datasets: ds },
      options: opcoes({ layout: { padding: { right: 52 } },
        plugins: { legend: legenda(), tooltip: { callbacks: {
          afterBody: itens => {
            const m = meses[itens[0].dataIndex], alvo = objNps.metas[m];
            return alvo === undefined ? "" : "Meta de " + mesCurto(m).toLowerCase() + ": " + fmt(alvo, 1);
          } } } },
        scales: { y: { min: 0, max: 100, grid: { color: C.grid },
                       title: { display: true, text: "índice", font: { size: 10 } } },
                  y1: { min: 0, position: "right", grid: { display: false },
                        title: { display: true, text: "respostas", font: { size: 10 } } },
                  x: { grid: { display: false } } } }) });
  }

  /* ---------- Focos do mes ----------
     Sao escritos a mao em data/focos.json: nao ha metrica que diga em que a
     area escolheu mexer neste mes. O quadro de "Resolucao com IA" que morava
     aqui saiu — era um indicador solto, e indicador ja tem lugar no farol. */
  function focos() {
    const box = $("#focos");
    const cfg = S.focos || {};
    const doMes = (cfg.meses || {})[S.mes] || (cfg.meses || {})[cfg.padrao] || null;


    if (!doMes || !(doMes.itens || []).length) {
      box.innerHTML = '<li class="empty">Sem focos escritos para ' +
        mesLabel(S.mes).toLowerCase() + '. Edite <code>data/focos.json</code>.</li>';
      return;
    }
    box.innerHTML = doMes.itens.map(f => {
      const texto = typeof f === "string" ? f : f.texto;
      const dono = typeof f === "string" ? null : f.dono;
      const estado = (typeof f === "string" ? "" : f.estado || "").toLowerCase();
      return '<li class="foco ' + estado + '"><span class="foco-marca"></span>' +
        "<div><span>" + texto + "</span>" +
        (dono ? '<span class="foco-dono">' + dono + "</span>" : "") + "</div></li>";
    }).join("");
  }

  /* ---------- Especialidade x dimensao ----------
     Matriz de calor. A tabela que existia aqui pedia comparacao de cabeca
     entre 6 colunas de decimais; a cor resolve isso antes da leitura. */
  function cruzamento() {
    const box = $("#cruz"), sub = null;
    const linhas = (dados().satisfacao_por_especialidade || [])
      .filter(l => (l.n || 0) >= MIN_AMOSTRA)
      .sort((a, b) => (b.n || 0) - (a.n || 0));

    if (!linhas.length) {
      box.innerHTML = '<div class="empty">Sem especialidade com ' + MIN_AMOSTRA +
        " respostas ou mais em " + mesLabel(S.mes).toLowerCase() + ".</div>";
      if (sub) sub.textContent = "";
      return;
    }

    const cols = DIMENSOES.slice();
    const todos = [];
    linhas.forEach(l => cols.forEach(c => { const v = l[c.key]; if (v != null) todos.push(v); }));
    const menor = Math.min.apply(null, todos), maior = Math.max.apply(null, todos);

    if (sub) sub.innerHTML = "Nota media de cada dimensao dentro de cada especialidade, " +
      "de <b>" + fmt(menor, 2) + "</b> a <b>" + fmt(maior, 2) + "</b>. " +
      "Só entram especialidades com " + MIN_AMOSTRA + " respostas ou mais.";

    /* A cor vai do rosa ao teal da marca, esticada entre o menor e o maior do
       proprio mes: numa escala fixa de 0 a 5 tudo ficaria da mesma cor. */
    const tom = v => {
      if (v == null) return "background:var(--gray-inactive,#E8EAED)";
      const t = maior === menor ? .5 : (v - menor) / (maior - menor);
      const cor = t < .5
        ? "237,30,121"          // rosa: abaixo da media do mes
        : "0,195,197";          // teal: acima
      const forca = .12 + Math.abs(t - .5) * 1.5;
      return "background:rgba(" + cor + "," + forca.toFixed(2) + ")";
    };

    const cab = '<div class="cruz-linha cruz-cab"><div class="cruz-nome"></div>' +
      cols.map(c => '<div class="cruz-col">' + c.label.split(" ")[0] + "</div>").join("") +
      '<div class="cruz-col">n</div></div>';

    box.innerHTML = cab + linhas.map(l =>
      '<div class="cruz-linha"><div class="cruz-nome" title="' + l.especialidade + '">' +
      l.especialidade + "</div>" +
      cols.map(c => {
        const v = l[c.key];
        return '<div class="cruz-cel tabular" style="' + tom(v) + '" title="' +
          l.especialidade + " · " + c.label + '">' +
          (v == null ? "—" : fmt(v, 2)) + "</div>";
      }).join("") +
      '<div class="cruz-cel cruz-n tabular">' + (l.n || 0) + "</div></div>").join("");
  }

  function minutosDeTempo(txt) {
    const m = String(txt || "").trim().match(/^(\d+)h(\d+)?$/i);
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2] || 0);
  }
  function tempoDeMinutos(min) {
    if (min === null || min === undefined) return "—";
    const h = Math.floor(min / 60), mm = Math.round(min % 60);
    return mm ? h + "h" + String(mm).padStart(2, "0") : h + "h";
  }

  /* A ordem é a da tabela do Notion, que a diretoria já conhece de cor. */
  const INDICADORES = [
    { id: "nps",              label: "NPS",               casas: 1, suf: "",  fonte: "nps",     melhor: "cima"  },
    { id: "csat_ia",          label: "CSAT (IA)",         casas: 2, suf: "",  fonte: "zendesk", campo: "csat_ia",               melhor: "cima" },
    { id: "csat_humano",      label: "CSAT (Humano)",     casas: 2, suf: "",  fonte: "zendesk", campo: "csat_humano",           melhor: "cima" },
    { id: "tma",              label: "TMA (1ª resposta)", tempo: true,        fonte: "zendesk", campo: "tma_primeira_resposta", melhor: "baixo" },
    { id: "tmr",              label: "TMR",               tempo: true,        fonte: "zendesk", campo: "tmr",                   melhor: "baixo" },
    { id: "fcr_pct",          label: "FCR",               casas: 1, suf: "%", fonte: "zendesk", campo: "fcr_pct",               melhor: "cima" },
    { id: "resolucao_ia_pct", label: "Resolução com IA",  casas: 0, suf: "%", fonte: "zendesk", campo: "resolucao_ia_pct",      melhor: "cima" }
  ];

  const mostrar = (ind, v) =>
    v === null || v === undefined ? "—"
    : ind.tempo ? tempoDeMinutos(v)
    : fmt(v, ind.casas) + (ind.suf || "");

  /* ---------- Evolução no tempo ---------- */

  /** Pontos do eixo: as semanas do mês escolhido ou os meses da série. */
  function eixoTempo(modo) {
    if (modo === "meses") {
      return Object.keys(S.nps.meses || {}).sort()
        .map(m => ({ label: mesCurto(m), bloco: S.nps.meses[m], parcial: false }));
    }
    return semanasNps().map(sem => ({
      label: "S" + sem.semana, bloco: sem, parcial: sem.respostas < MIN_SEMANA
    }));
  }

  /** Qual eixo faz sentido por padrão: o que tiver mais de um ponto. */
  function eixoPadrao() {
    return Object.keys(S.nps.meses || {}).length > 1 && semanasNps().length < 2
      ? "meses" : "semanas";
  }

  /** Liga os botões Semanas/Meses e devolve o eixo em vigor. */
  function eixoDe(qual, idSeg) {
    const escolhido = S[qual] || eixoPadrao();
    $$("#" + idSeg + " button").forEach(b => b.classList.toggle("active", b.dataset.eixo === escolhido));
    return escolhido;
  }

  /* Linhas com poucos pontos ficam ilegíveis se todas levarem rótulo em cada
     ponto — o valor vai só no último, que é onde a leitura importa. */
  const CORES_SERIE = [C.blue, C.teal, C.pink, C.amber, "#7B3FF2", "#00913B", "#B8115C", "#0E7C86"];

  /* No Notion a "Leitura" de cada evolução era escrita à mão todo mês. Aqui
     ela sai dos próprios números: quem mais subiu, quem mais caiu e quem
     ainda está no fundo da lista. */
  function escreverLeitura(alvo, eixo, series, casas, sufixo) {
    const box = $(alvo);
    if (!box) return;

    // Semana parcial fica de fora: "de 61,9 para 0,0" tirado de uma resposta
    // não é leitura, é ruído com cara de conclusão.
    const usar = eixo.map((p, i) => p.parcial ? -1 : i).filter(i => i >= 0);
    if (usar.length < 2) {
      box.innerHTML = '<span class="rot">Leitura</span><span>Ainda não há dois períodos ' +
        "com amostra cheia para comparar.</span>";
      return;
    }
    const primeiro = eixo[usar[0]], ultimo = eixo[usar[usar.length - 1]];
    const movimentos = series.map(s => {
      const vals = usar.map(i => s.valores[i]);
      const ini = vals.find(v => v !== null && v !== undefined);
      const fimIdx = vals.reduce((ac, v, i) => (v === null || v === undefined) ? ac : i, -1);
      const fim = fimIdx >= 0 ? vals[fimIdx] : null;
      return (ini === undefined || fim === null) ? null
        : { nome: s.nome, ini, fim, delta: fim - ini };
    }).filter(Boolean);

    if (movimentos.length < 2) { box.innerHTML = ""; return; }
    const subiu = [...movimentos].sort((a, b) => b.delta - a.delta)[0];
    const caiu  = [...movimentos].sort((a, b) => a.delta - b.delta)[0];
    const fundo = [...movimentos].sort((a, b) => a.fim - b.fim)[0];
    const v = x => fmt(x, casas) + (sufixo || "");

    const partes = [];
    if (subiu.delta > 0)
      partes.push("<b>" + subiu.nome + "</b> foi quem mais avançou entre " + primeiro.label +
                  " e " + ultimo.label + " (" + v(subiu.ini) + " → " + v(subiu.fim) + ").");
    if (caiu.delta < 0 && caiu.nome !== subiu.nome)
      partes.push("<b>" + caiu.nome + "</b> " +
                  (partes.length ? "foi na direção oposta, de " : "foi quem mais caiu, de ") +
                  v(caiu.ini) + " para " + v(caiu.fim) + ".");
    if (fundo.nome !== caiu.nome)
      partes.push("<b>" + fundo.nome + "</b> segue como o mais baixo do período, em " + v(fundo.fim) + ".");
    else if (caiu.delta < 0)
      partes.push("É também o mais baixo do período.");

    box.innerHTML = partes.length
      ? '<span class="rot">Leitura</span><span>' + partes.join(" ") + "</span>" : "";
  }

  /** Escala colada nos dados: com faixa fixa as linhas se espremem num canto
      e os rótulos de fim de linha brigam por espaço. */
  function faixa(valores, folga, piso, teto) {
    const v = valores.flat().filter(x => x !== null && x !== undefined);
    if (!v.length) return { min: piso, max: teto };
    let min = Math.min(...v) - folga, max = Math.max(...v) + folga;
    if (piso !== undefined) min = Math.max(piso, min);
    if (teto !== undefined) max = Math.min(teto, max);
    if (max - min < folga) { min -= folga; max += folga; }
    return { min: Math.floor(min * 10) / 10, max: Math.ceil(max * 10) / 10 };
  }

  function grafEvolucaoDimensoes() {
    const eixo = eixoTempo(eixoDe("evoDim", "seg-evo-dim"));
    if (eixo.length < 2) {
      grafico("chart-evo-dim", { type: "line", data: { labels: [], datasets: [] }, options: opcoes({}) });
      $("#leitura-dim").innerHTML = "";
      return;
    }

    // o rotulo vai no ultimo periodo com amostra cheia — pendurar o numero
    // numa semana parcial daria destaque ao dado menos confiavel
    const ancora = eixo.reduce((ac, p, i) => p.parcial ? ac : i, 0);

    const datasets = DIMENSOES.map((d, i) => {
      const cor = CORES_SERIE[i % CORES_SERIE.length];
      return {
        label: d.label,
        data: eixo.map(p => {
          const achado = (p.bloco.media_por_pergunta || []).find(x => x.pergunta === d.label);
          return achado ? achado.media : null;
        }),
        borderColor: cor, backgroundColor: "transparent", borderWidth: 2.2, tension: .3,
        pointRadius: 4, pointBackgroundColor: cor, pointBorderColor: "#fff", pointBorderWidth: 1.5,
        spanGaps: true, rotulo: { casas: 2, cor: cor, soUltimo: true, indice: ancora },
        segment: { borderDash: ctx => eixo[ctx.p1DataIndex].parcial ? [5, 4] : undefined }
      };
    });

    grafico("chart-evo-dim", { type: "line",
      data: { labels: eixo.map(p => p.label), datasets },
      options: opcoes({ plugins: { legend: legenda(10) },
        layout: { padding: { right: 48 } },
        scales: { y: Object.assign(faixa(datasets.map(d => d.data), .12, 0, 5),
                    { grid: { color: C.grid } }),
                  x: { grid: { display: false } } } }) });

    escreverLeitura("#leitura-dim", eixo,
      datasets.map(d => ({ nome: d.label, valores: d.data })), 2, "");
  }

  function grafEvolucaoEspecialidades() {
    const eixo = eixoTempo(eixoDe("evoEsp", "seg-evo-esp"));
    if (eixo.length < 2) {
      grafico("chart-evo-esp", { type: "line", data: { labels: [], datasets: [] }, options: opcoes({}) });
      $("#leitura-esp").innerHTML = "";
      return;
    }

    // Onze linhas viram emaranhado: só as de maior volume no mês.
    const escolhidas = [...especialidades().relevantes]
      .sort((a, b) => b.pct_amostra - a.pct_amostra).slice(0, 5).map(e => e.especialidade);

    // o rotulo vai no ultimo periodo com amostra cheia — pendurar o numero
    // numa semana parcial daria destaque ao dado menos confiavel
    const ancora = eixo.reduce((ac, p, i) => p.parcial ? ac : i, 0);

    const datasets = escolhidas.map((nome, i) => {
      const cor = CORES_SERIE[i % CORES_SERIE.length];
      return {
        label: nome,
        data: eixo.map(p => {
          const achado = (p.bloco.nps_por_especialidade || []).find(x => x.especialidade === nome);
          return achado ? achado.nps : null;
        }),
        borderColor: cor, backgroundColor: "transparent", borderWidth: 2.2, tension: .3,
        pointRadius: 4, pointBackgroundColor: cor, pointBorderColor: "#fff", pointBorderWidth: 1.5,
        spanGaps: true, rotulo: { casas: 1, cor: cor, soUltimo: true, indice: ancora },
        segment: { borderDash: ctx => eixo[ctx.p1DataIndex].parcial ? [5, 4] : undefined }
      };
    });

    grafico("chart-evo-esp", { type: "line",
      data: { labels: eixo.map(p => p.label), datasets },
      options: opcoes({ plugins: { legend: legenda(10) },
        layout: { padding: { right: 48 } },
        scales: { y: Object.assign(faixa(datasets.map(d => d.data), 8, -100, 100),
                    { grid: { color: C.grid } }),
                  x: { grid: { display: false } } } }) });

    escreverLeitura("#leitura-esp", eixo,
      datasets.map(d => ({ nome: d.label, valores: d.data })), 1, "");
  }

  function espLista() {
    const { relevantes, pequenas } = especialidades();
    const lista = [...relevantes].sort((a,b) =>
      S.espOrdem === "nps" ? b.nps - a.nps : b.pct_amostra - a.pct_amostra);
    const box = $("#esp-ranks"); box.innerHTML = "";

    lista.forEach(item => {
      const row = el("div", "rank" + (S.espSel === item.especialidade ? " on" : ""),
        '<div class="rank-name">' + item.especialidade +
          "<span>" + (item.enviadas ? item.n + " de " + item.enviadas + " convites · " +
            fmt(item.taxa_resposta, 1) + "% responderam"
            : item.n ? item.n + " respostas" : "apuração manual, sem amostra registrada") +
          "</span></div>" +
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
    espLista(); espDetalhe(); cruzamento();
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

  /* A ordem e a da reuniao de area: primeiro os tempos, depois a satisfacao.
     `cor` sumiu de proposito — todas as linhas de cartao sao azuis. */
  const IND_SUPORTE = [
    { id: "tma",              campo: "tma_primeira_resposta", rotulo: "TMA",
      nota: "Tempo até a primeira resposta", tempo: true,      melhor: "baixo" },
    { id: "tmr",              campo: "tmr",                   rotulo: "TMR",
      nota: "Tempo até o encerramento", tempo: true,           melhor: "baixo" },
    { id: "fcr_pct",          campo: "fcr_pct",               rotulo: "FCR",
      nota: "Resolvido no primeiro contato", casas: 1, suf: "%", melhor: "cima" },
    { id: "csat_humano",      campo: "csat_humano",           rotulo: "CSAT humano",
      nota: "Escala de 1 a 5", casas: 2, suf: "", melhor: "cima" },
    { id: "csat_ia",          campo: "csat_ia",               rotulo: "CSAT IA",
      nota: "Escala de 1 a 5", casas: 2, suf: "", melhor: "cima" },
    { id: "resolucao_ia_pct", campo: "resolucao_ia_pct",      rotulo: "Resolução com IA",
      nota: "Sem intervenção humana", casas: 0, suf: "%", melhor: "cima" }
  ];

  /** Lê o valor de um indicador numa linha do CSV, já como número comparável. */
  function valorSup(ind, linha) {
    if (!linha) return null;
    return ind.tempo ? minutosDeTempo(linha[ind.campo]) : num(linha[ind.campo]);
  }
  /** Meta do indicador no mês, quando existe objetivo cadastrado. */
  function metaSup(ind, mes) {
    const o = objetivo(ind.id);
    if (!o || !o.metas) return null;
    const bruto = o.metas[mes];
    if (bruto === undefined || bruto === null) return null;
    return ind.tempo ? minutosDeTempo(bruto) : num(bruto);
  }

  const mostrarSup = (ind, v) =>
    v === null || v === undefined ? "—"
    : ind.tempo ? tempoDeMinutos(v)
    : fmt(v, ind.casas) + (ind.suf || "");

/* =====================================================================
     CARD FLUTUANTE DA SEMANA
     Todo grafico mensal do painel abre o mesmo card: clicou num mes, o
     detalhe daquele mes aparece por cima, com os botoes dos outros meses ao
     lado. Antes o semanal era um quadro fixo la embaixo e o clique so rolava
     a pagina ate ele — dava para perder de vista o que tinha sido clicado.
     ===================================================================== */

  let POP = null;   // { titulo, meses, mes, sub, nota, config }

  function abrirPop(cfg) {
    POP = cfg;
    if (!POP.mes || !POP.meses.includes(POP.mes)) {
      POP.mes = POP.meses.includes(S.mes) ? S.mes : POP.meses[POP.meses.length - 1];
    }
    const painel = $("#pop-semana");
    if (!painel) return;
    painel.classList.add("aberto");
    painel.setAttribute("aria-hidden", "false");
    document.body.classList.add("sem-rolagem");
    desenharPop();
  }

  function fecharPop() {
    const painel = $("#pop-semana");
    if (!painel) return;
    painel.classList.remove("aberto");
    painel.setAttribute("aria-hidden", "true");
    document.body.classList.remove("sem-rolagem");
  }

  function desenharPop() {
    if (!POP) return;
    $("#pop-titulo").textContent = POP.titulo;
    $("#pop-sub").innerHTML = POP.sub ? POP.sub(POP.mes) : "";
    $("#pop-nota").innerHTML = POP.nota ? POP.nota(POP.mes) : "";

    const seg = $("#pop-meses");
    seg.innerHTML = POP.meses.map(m =>
      '<button class="' + (m === POP.mes ? "active" : "") + '" data-mes="' + m + '">' +
      mesCurto(m) + "</button>").join("");
    $$("#pop-meses button").forEach(b => b.addEventListener("click", () => {
      POP.mes = b.dataset.mes;
      desenharPop();
    }));

    /* O canvas e recriado a cada abertura: o Chart.js guarda o tamanho de
       quando o grafico nasceu, e um card fechado tem altura zero. */
    const caixa = $("#chart-pop").parentElement;
    caixa.innerHTML = '<canvas id="chart-pop"></canvas>';
    delete S.charts["chart-pop"];
    grafico("chart-pop", POP.config(POP.mes));
  }

  function ligarPop() {
    const painel = $("#pop-semana");
    if (!painel) return;
    painel.querySelectorAll("[data-fechar-pop]").forEach(el =>
      el.addEventListener("click", fecharPop));
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && painel.classList.contains("aberto")) fecharPop();
    });
  }

  /* =====================================================================
     SUPORTE
     ===================================================================== */

  function sac() {
    const mensal = zenMensal();
    const preenchidos = mensal.filter(r => IND_SUPORTE.some(i => valorSup(i, r) !== null));
    const escolhido = preenchidos.findIndex(r => r.mes === S.mes);
    const pos = escolhido >= 0 ? escolhido : preenchidos.length - 1;
    const atual = preenchidos[pos], anterior = pos > 0 ? preenchidos[pos - 1] : null;


    cartoesSuporte(mensal, atual, anterior);
    grafCsat(mensal);
    grafFcr(mensal);
  }

  /** Meses que tem quebra semanal preenchida no CSV do Zendesk. */
  function mesesComSemana() {
    return Array.from(new Set(
      S.zendesk.filter(r => (num(r.semana) ?? 0) > 0).map(r => r.mes))).sort();
  }

  /* Os seis cartoes: numero grande e a evolucao logo abaixo.
     Todas as linhas em azul de propósito — a cor aqui nao carrega informacao,
     e seis cores diferentes so fariam o olho procurar um significado que nao
     existe. O que a cor marca e a meta: cinza claro, tracejada, igual em
     todos. */
  function cartoesSuporte(mensal, atual, anterior) {
    [["#sac-linha-1", 0, 3], ["#sac-linha-2", 3, 6]].forEach(([alvo, de, ate]) => {
      const box = $(alvo);
      box.innerHTML = IND_SUPORTE.slice(de, ate).map(ind => {
        const v = valorSup(ind, atual), ant = valorSup(ind, anterior);
        let delta = "";
        if (v !== null && ant !== null && ant !== 0) {
          const pct = (v - ant) / Math.abs(ant) * 100;
          const bom = ind.melhor === "baixo" ? pct < 0 : pct > 0;
          delta = '<span class="delta ' + (bom ? "up" : "down") + '">' +
                  (pct >= 0 ? "+" : "−") + fmt(Math.abs(pct), 1) + "%</span>";
        }
        const meta = atual ? metaSup(ind, atual.mes) : null;
        return '<div class="card sup-card" data-ind="' + ind.id + '">' +
          '<div class="metric-label">' + ind.rotulo + "</div>" +
          '<div class="sup-num tabular">' + mostrarSup(ind, v) + delta + "</div>" +
          '<div class="metric-note">' + ind.nota +
          (meta === null ? "" : " · meta " + mostrarSup(ind, meta)) + "</div>" +
          '<div class="sup-spark" title="Clique para ver as semanas">' +
          '<canvas id="spark-' + ind.id + '"></canvas></div>' +
          "</div>";
      }).join("");
    });

    IND_SUPORTE.forEach(ind => {
      const meses = mensal.map(r => r.mes);
      const serie = mensal.map(r => valorSup(ind, r));
      const meta = meses.map(m => metaSup(ind, m));
      grafico("spark-" + ind.id, {
        type: "line",
        data: { labels: meses.map(mesCurto), datasets: [
          { label: ind.rotulo, data: serie, borderColor: C.blue, backgroundColor: C.blueFill,
            fill: true, borderWidth: 2.2, tension: .35, spanGaps: true,
            pointRadius: meses.map(m => atual && m === atual.mes ? 4.5 : 3),
            pointBackgroundColor: meses.map(m => atual && m === atual.mes ? C.pink : C.blue),
            pointBorderColor: "#fff", pointBorderWidth: 1.5,
            rotulo: { casas: ind.casas ?? 1, cor: C.blue, tempo: !!ind.tempo, sufixo: ind.suf || "" } },
          { label: "Meta", data: meta, borderColor: C.cinzaMeta, borderDash: [4, 3],
            borderWidth: 1.5, backgroundColor: "transparent", tension: .35,
            pointRadius: 0, spanGaps: true,
            rotulo: { casas: ind.casas ?? 1, cor: C.cinzaMeta, tempo: !!ind.tempo,
                      sufixo: ind.suf || "", soUltimo: true } } ] },
        options: opcoes({
          onClick: () => popSuporte(ind),
          layout: { padding: { top: 14, right: 30, bottom: 2 } },
          plugins: { legend: { display: false }, tooltip: { callbacks: {
            label: c => c.dataset.label + ": " + mostrarSup(ind, c.parsed.y) } } },
          scales: { y: { display: false, grace: "26%" },
                    x: { grid: { display: false }, ticks: { font: { size: 9 }, color: C.text } } }
        })
      });
    });

    // o card inteiro e clicavel, nao so o grafico
    $$(".sup-card[data-ind]").forEach(card => card.addEventListener("click", () => {
      const ind = IND_SUPORTE.find(i => i.id === card.dataset.ind);
      if (ind) popSuporte(ind);
    }));
  }

  /** O semanal de um indicador de suporte, sem meta: semana nao tem meta. */
  function popSuporte(ind) {
    const meses = mesesComSemana();
    if (!meses.length) return;
    abrirPop({
      titulo: ind.rotulo + " semana a semana",
      meses: meses,
      mes: S.sacMes,
      sub: m => "Realizado de " + mesLabel(m).toLowerCase() + " · " + ind.nota +
        ". A meta é mensal, então não aparece aqui.",
      nota: m => {
        const sem = zenSemanal(m);
        const vals = sem.map(r => valorSup(ind, r)).filter(v => v !== null);
        if (vals.length < 2) return "";
        const dif = vals[vals.length - 1] - vals[0];
        const bom = ind.melhor === "baixo" ? dif < 0 : dif > 0;
        return "Da primeira à última semana: <b>" + mostrarSup(ind, vals[0]) + "</b> para <b>" +
          mostrarSup(ind, vals[vals.length - 1]) + "</b> — " +
          (bom ? "no sentido certo." : "no sentido contrário ao da meta.");
      },
      config: m => {
        const sem = zenSemanal(m);
        return { type: "line",
          data: { labels: sem.map(r => "S" + r.semana + (r.periodo ? " · " + r.periodo.replace(/ de \w+/i, "") : "")),
            datasets: [{ label: ind.rotulo, data: sem.map(r => valorSup(ind, r)),
              borderColor: C.blue, backgroundColor: C.blueFill, fill: true,
              borderWidth: 2.6, tension: .3, pointRadius: 5, pointBackgroundColor: C.blue,
              pointBorderColor: "#fff", pointBorderWidth: 2, spanGaps: true,
              rotulo: { casas: ind.casas ?? 1, cor: C.blue, tempo: !!ind.tempo, sufixo: ind.suf || "" } }] },
          options: opcoes({ layout: { padding: { top: 18 } },
            plugins: { legend: { display: false }, tooltip: { callbacks: {
              label: c => mostrarSup(ind, c.parsed.y) } } },
            scales: { y: { grace: "22%", grid: { color: C.grid },
                           ticks: { callback: v => ind.tempo ? tempoDeMinutos(v) : fmt(v, ind.casas ?? 1) + (ind.suf || "") } },
                      x: { grid: { display: false } } } }) };
      }
    });
  }

  /** CSAT: humano, IA, a media dos dois e a meta tracejada. Escala de 1 a 5. */
  function grafCsat(mensal) {
    const meses = mensal.map(r => r.mes);
    const humano = mensal.map(r => num(r.csat_humano));
    const ia = mensal.map(r => num(r.csat_ia));
    // "geral" so faz sentido onde os dois existem; com um lado so seria o
    // proprio numero disfarcado de media
    const geral = mensal.map((r, i) =>
      humano[i] !== null && ia[i] !== null ? Math.round((humano[i] + ia[i]) / 2 * 100) / 100 : null);
    const meta = meses.map(m => metaSup({ id: "csat_humano" }, m));

    grafico("chart-csat", { type: "line",
      data: { labels: meses.map(mesCurto), datasets: [
        { label: "Humano", data: humano, borderColor: C.blue, backgroundColor: "transparent",
          borderWidth: 2.4, tension: .3, pointRadius: 4, pointBackgroundColor: C.blue,
          pointBorderColor: "#fff", pointBorderWidth: 2, spanGaps: true,
          rotulo: { casas: 2, cor: C.blue, soUltimo: true } },
        { label: "IA", data: ia, borderColor: C.teal, backgroundColor: "transparent",
          borderWidth: 2.4, tension: .3, pointRadius: 4, pointBackgroundColor: C.teal,
          pointBorderColor: "#fff", pointBorderWidth: 2, spanGaps: true,
          rotulo: { casas: 2, cor: "#009193", soUltimo: true } },
        { label: "Geral", data: geral, borderColor: C.pink, backgroundColor: "transparent",
          borderWidth: 2.8, tension: .3, pointRadius: 5, pointBackgroundColor: C.pink,
          pointBorderColor: "#fff", pointBorderWidth: 2, spanGaps: true,
          rotulo: { casas: 2, cor: C.pink, soUltimo: true } },
        { label: "Meta", data: meta, borderColor: C.cinzaMeta, borderDash: [5, 4], borderWidth: 1.8,
          backgroundColor: "transparent", tension: .3, pointRadius: 0, spanGaps: true,
          rotulo: { casas: 2, cor: C.cinzaMeta, soUltimo: true } } ] },
      options: opcoes({
        onClick: (e, els) => popDoMes(els, meses, "csat_humano"),
        layout: { padding: { right: 52 } },
        plugins: { legend: legenda() },
        // escala de 1 a 5: e a escala da pergunta, e comecar em zero achata
        // toda a variacao que interessa no topo
        scales: { y: { min: 1, max: 5, grid: { color: C.grid }, ticks: { stepSize: 1 } },
                  x: { grid: { display: false } } }
      })
    });
  }

  /** FCR: realizado e meta tracejada, com o numero da meta na ponta. */
  function grafFcr(mensal) {
    const meses = mensal.map(r => r.mes);
    grafico("chart-fcr", { type: "line",
      data: { labels: meses.map(mesCurto), datasets: [
        { label: "Realizado", data: mensal.map(r => num(r.fcr_pct)),
          borderColor: C.blue, backgroundColor: C.blueFill, fill: true, borderWidth: 2.6,
          tension: .3, pointRadius: 4.5, pointBackgroundColor: C.blue,
          pointBorderColor: "#fff", pointBorderWidth: 2, spanGaps: true,
          rotulo: { casas: 1, sufixo: "%", cor: C.blue } },
        { label: "Meta", data: meses.map(m => metaSup({ id: "fcr_pct" }, m)),
          borderColor: C.cinzaMeta, borderDash: [5, 4], borderWidth: 1.8,
          backgroundColor: "transparent", tension: .3, pointRadius: 0, spanGaps: true,
          rotulo: { casas: 0, sufixo: "%", cor: C.cinzaMeta } } ] },
      options: opcoes({
        onClick: (e, els) => popDoMes(els, meses, "fcr_pct"),
        layout: { padding: { right: 20 } },
        plugins: { legend: legenda(), tooltip: { callbacks: {
          label: c => c.dataset.label + ": " + fmt(c.parsed.y, 1) + "%" } } },
        scales: { y: { min: 0, grid: { color: C.grid }, ticks: { callback: v => v + "%" } },
                  x: { grid: { display: false } } }
      })
    });
  }

  /** Clique num mes de um grafico grande do Suporte -> card flutuante. */
  function popDoMes(elementos, meses, idIndicador) {
    if (!elementos || !elementos.length) return;
    const mes = meses[elementos[0].index];
    const ind = IND_SUPORTE.find(i => i.id === idIndicador);
    if (!mes || !ind) return;
    S.sacMes = mes;
    popSuporte(ind);
  }

/* =====================================================================
     OCORRÊNCIAS
     Tudo em linha, mes a mes, e todo mes clicavel: o detalhe da semana abre
     no card flutuante. A evolucao mensal que existia aqui saiu — dizia o
     mesmo que estes graficos, com barras empilhadas que ninguem comparava.
     ===================================================================== */

  /** Horas viram "3,1 dias" quando passam de um dia — ninguém lê 175,3h. */
  const emDias = h => h === null || h === undefined ? "—"
    : h < 24 ? fmt(h, 1) + "h" : fmt(h / 24, 1) + " dias";

  /* Meses em que vale desenhar as duas classes: antes disso o campo motivo
     quase nao era preenchido e as linhas cairiam a zero sem motivo real. */
  function ocMesesClassificados() {
    const meses = Object.keys((S.oc && S.oc.meses) || {}).sort();
    return meses.filter(k => {
      const c = (S.oc.meses[k].por_classe) || {};
      const total = (c.total && c.total.total) || 0;
      const sem = (c.sem_classificacao && c.sem_classificacao.total) || 0;
      return total > 0 && (total - sem) / total >= 0.8;
    });
  }

  const OC_MESES = 12;   // um ano de serie; antes disso o volume era de outra operacao

  function ocMesesSerie() {
    return Object.keys((S.oc && S.oc.meses) || {}).sort().slice(-OC_MESES);
  }

  /** Os meses da aba de tickets — vazio enquanto o Zendesk nao estiver ligado. */
  function tkMesesSerie() {
    const base = baseTickets();
    return base ? Object.keys(base.meses).sort().slice(-OC_MESES) : [];
  }

  function ocorrencias() {
    if (!S.oc) return;
    const mes = (S.ocMes && S.oc.meses[S.ocMes]) ? S.ocMes : S.mes;
    const m = S.oc.meses[mes] || null, vazio = !m;

    $("#oc-mes").textContent = mesLabel(mes) + " de " + mes.slice(0, 4);
    conta($("#oc-total"), vazio ? null : m.total, 0);
    $("#oc-desc").textContent = vazio
      ? "Sem ocorrências registradas neste mês."
      : "Abertas na Comunidade, sem contar Captação.";

    $("#oc-fatos").innerHTML = vazio ? "" : [
      ["Finalizadas", m.finalizadas, C.positive],
      ["Em aberto", m.em_aberto, C.amber],
      ["Canceladas", m.canceladas, null]
    ].map(f => '<div><div class="fact-value tabular">' +
      (f[2] ? '<span class="dot" style="background:' + f[2] + '"></span>' : "") + f[1] +
      '</div><div class="fact-label">' + f[0] + "</div></div>").join("");

    $("#oc-sla").textContent = vazio ? "—" : emDias(m.sla_mediano_h);
    $("#oc-sla").style.color = vazio ? "" : m.sla_mediano_h > 168 ? C.negative
                                          : m.sla_mediano_h > 72 ? "#96700B" : "#009131";
    $("#oc-sla-cap").innerHTML = vazio ? "" :
      "mediano sobre as <b>" + m.finalizadas + " finalizadas</b> · média de <b>" +
      emDias(m.sla_medio_h) + "</b>" +
      (m.sla_max_h > m.sla_mediano_h * 2
        ? ", puxada por um caso de <b>" + emDias(m.sla_max_h) + "</b>" : "") +
      (m.em_aberto ? ". As <b>" + m.em_aberto + " em aberto</b> não entram: nelas ainda não há encerramento para medir." : "");

    seletorOcVista();
    grafOcClasse();
    grafOcPorChave("chart-oc-vol-dep", "por_departamento", "total", 5, false);
    grafOcPorChave("chart-oc-sla-dep", "por_departamento", "sla_mediano_dias", 5, true);
    grafOcPorChave("chart-oc-vol-tipo", "por_tipo", "total", 6, false);
    grafOcPorChave("chart-oc-sla-tipo", "por_tipo", "sla_mediano_dias", 6, true);
  }

  /* Comportamental, tecnica, a soma das duas e os tres estados do ticket.
     A soma nao e o total do mes: boa parte das ocorrencias vem de
     departamentos que nao preenchem motivo. Por isso "Soma" e uma linha
     propria, e o total aparece separado. */
  function seletorOcVista() {
    $$("#seg-oc-vista button").forEach(b => {
      b.classList.toggle("active", b.dataset.vista === S.ocVista);
      if (b.dataset.ligado) return;
      b.dataset.ligado = "1";
      b.addEventListener("click", () => {
        S.ocVista = b.dataset.vista;
        seletorOcVista();
        grafOcClasse();
      });
    });
  }

  function grafOcClasse() {
    const meses = ocMesesClassificados();
    const sub = null;
    if (!meses.length) {
      if (sub) sub.textContent = "Nenhum mês tem motivo preenchido o bastante para separar as classes.";
      grafico("chart-oc-classe", { type: "line", data: { labels: [], datasets: [] }, options: opcoes({}) });
      return;
    }

    const classe = (m, k) => {
      const c = (S.oc.meses[m].por_classe) || {};
      return c[k] ? c[k].total : null;
    };
    const soma = m => {
      const a = classe(m, "comportamental"), b = classe(m, "tecnica");
      return a === null && b === null ? null : (a || 0) + (b || 0);
    };
    const estado = (m, campo) => {
      const b = S.oc.meses[m];
      return b && b[campo] !== undefined ? b[campo] : null;
    };

    const linha = (rot, dados, cor, forte) => ({
      label: rot, data: dados, borderColor: cor, backgroundColor: "transparent",
      borderWidth: forte ? 2.8 : 2, tension: .3,
      pointRadius: meses.map(m => m === (S.ocMes || S.mes) ? 6 : 3.5),
      pointBackgroundColor: cor, pointBorderColor: "#fff", pointBorderWidth: 1.5,
      spanGaps: true, rotulo: { casas: 0, cor: cor, soUltimo: true }
    });

    /* Duas vistas no mesmo card em vez de seis linhas juntas: a soma das
       classes e o total de finalizadas costumam correr quase coladas, e
       sobrepostas nao dizem nada — separadas, cada uma responde a sua
       pergunta. */
    const vista = S.ocVista === "situacao" ? "situacao" : "classe";
    const series = vista === "classe"
      ? [linha("Comportamental", meses.map(m => classe(m, "comportamental")), C.pink),
         linha("Técnica", meses.map(m => classe(m, "tecnica")), C.teal),
         linha("Soma das duas", meses.map(soma), C.blue, true)]
      : [linha("Abertas no mês", meses.map(m => estado(m, "total")), C.blue, true),
         linha("Finalizadas", meses.map(m => estado(m, "finalizadas")), C.positive),
         linha("Em aberto", meses.map(m => estado(m, "em_aberto")), C.amber),
         linha("Canceladas", meses.map(m => estado(m, "canceladas")), C.cinzaMeta)];

    grafico("chart-oc-classe", { type: "line",
      data: { labels: meses.map(mesCurto), datasets: series },
      options: opcoes({ onClick: (e, el) => popOcorrencias(el, meses),
        layout: { padding: { right: 46 } },
        plugins: { legend: legenda(),
          tooltip: { callbacks: { afterBody: itens => {
            const m = meses[itens[0].dataIndex], c = (S.oc.meses[m].por_classe) || {};
            const sem = c.sem_classificacao ? c.sem_classificacao.total : 0;
            return sem ? sem + " sem motivo preenchido" : "";
          } } } },
        scales: { y: { beginAtZero: true, grid: { color: C.grid } },
                  x: { grid: { display: false } } } }) });

    const leg = $("#oc-classe-legenda");
    const cfg = (S.oc && S.oc.classificacao) || null;
    if (leg) leg.innerHTML = !cfg ? "" :
      '<p class="nota-p">' + (cfg.por_que_existe || "") + "</p>" +
      Object.keys(cfg.classes).map(k => {
        const b = cfg.classes[k];
        return '<div class="nota-classe"><b>' + b.rotulo + "</b> — " + b.definicao +
          '<div class="nota-motivos">' + b.motivos.join(" · ") + "</div></div>";
      }).join("") +
      '<p class="nota-p">Para mudar, edite <code>data/classificacao_ocorrencias.json</code>. ' +
      "Nada dessa divisão está escrito no código.</p>";
  }

  /** Uma linha por departamento (ou tipo), mes a mes — volume ou SLA. */
  function grafOcPorChave(idCanvas, chave, campo, quantos, ehSla) {
    const meses = ocMesesSerie();
    const bloco = m => (S.oc.meses[m] || {})[chave] || {};

    // ranking pelo volume acumulado: as linhas do grafico sao sempre as mesmas
    const soma = {};
    meses.forEach(m => Object.entries(bloco(m)).forEach(([nome, v]) => {
      soma[nome] = (soma[nome] || 0) + (v.total || 0);
    }));
    const nomes = Object.keys(soma).sort((a, b) => soma[b] - soma[a]).slice(0, quantos);

    const curto = n => n.replace("Comunidade - ", "").replace("Comunidade", "Geral");
    grafico(idCanvas, { type: "line",
      data: { labels: meses.map(mesCurto), datasets: nomes.map((nome, i) => ({
        label: curto(nome),
        data: meses.map(m => { const v = bloco(m)[nome]; return v ? (v[campo] ?? null) : null; }),
        borderColor: CORES_SERIE[i % CORES_SERIE.length], backgroundColor: "transparent",
        borderWidth: 2.2, tension: .3,
        pointRadius: meses.map(m => m === (S.ocMes || S.mes) ? 5 : 3),
        pointBackgroundColor: CORES_SERIE[i % CORES_SERIE.length],
        pointBorderColor: "#fff", pointBorderWidth: 1.5, spanGaps: true,
        rotulo: { casas: ehSla ? 1 : 0, cor: CORES_SERIE[i % CORES_SERIE.length], soUltimo: true }
      })) },
      options: opcoes({ onClick: (e, el) => popOcorrencias(el, meses),
        layout: { padding: { right: 46 } },
        plugins: { legend: legenda(10), tooltip: { callbacks: {
          label: c => c.dataset.label + ": " + (c.parsed.y === null ? "—"
                    : ehSla ? fmt(c.parsed.y, 1) + " dias" : fmt(c.parsed.y, 0)) } } },
        scales: { y: { beginAtZero: true, grid: { color: C.grid },
                       title: ehSla ? { display: true, text: "dias", font: { size: 10 } } : undefined },
                  x: { grid: { display: false } } } }) });
  }

  /** Clique num mes de qualquer grafico de ocorrencia -> semanas daquele mes.
      Chamado das duas abas que leem essa base, entao so redesenha a que esta
      na tela: redesenhar a oculta criaria graficos de tamanho zero. */
  function popOcorrencias(elementos, meses) {
    if (!elementos || !elementos.length) return;
    const mes = meses[elementos[0].index];
    const base = S.pagina === "tickets" ? baseTickets()
               : { meses: (S.oc && S.oc.meses) || {}, fonte: "comunidade" };
    if (!base || !mes || !base.meses[mes]) return;
    if (S.pagina === "tickets") { S.tkMes = mes; tickets(); }
    else { S.ocMes = mes; ocorrencias(); }
    const comSemanas = meses.filter(m => ((base.meses[m] || {}).semanas || []).length);
    // as duas bases nao contam a mesma coisa, entao nem o nome nem as linhas
    // podem ser os mesmos: o Zendesk sabe quem atendeu, a Comunidade sabe a
    // classe da ocorrencia
    const zendesk = base.fonte === "zendesk";
    const nome = zendesk ? "tickets" : "ocorrências";
    abrirPop({
      titulo: (zendesk ? "Tickets" : "Ocorrências") + " semana a semana",
      meses: comSemanas,
      mes: mes,
      sub: m => "Semanas de " + mesLabel(m).toLowerCase(),
      nota: m => {
        const sem = (base.meses[m] || {}).semanas || [];
        const abertas = sem.reduce((a, x) => a + x.em_aberto, 0);
        return abertas ? "<b>" + abertas + "</b> " + nome + " do mês seguem em aberto — não entram no SLA."
                       : "";
      },
      config: m => {
        const sem = (base.meses[m] || {}).semanas || [];
        const classe = (x, k) => (x.por_classe && x.por_classe[k]) ? x.por_classe[k].total : null;
        return { data: { labels: sem.map(x => x.label), datasets: [
            { type: "bar", label: "Finalizadas", data: sem.map(x => x.finalizadas),
              backgroundColor: C.blue, borderRadius: 4, maxBarThickness: 44, stack: "oc", yAxisID: "y",
              rotulo: { casas: 0, cor: "#fff", abaixo: true } },
            { type: "bar", label: "Em aberto", data: sem.map(x => x.em_aberto),
              backgroundColor: C.amber, borderRadius: 4, maxBarThickness: 44, stack: "oc", yAxisID: "y" },
            { type: "bar", label: "Canceladas", data: sem.map(x => x.canceladas),
              backgroundColor: C.cinzaMeta, borderRadius: 4, maxBarThickness: 44, stack: "oc", yAxisID: "y" },
            ...(zendesk
              ? [{ type: "line", label: "Humano", data: sem.map(x => x.humano ?? null),
                   borderColor: C.pink, backgroundColor: "transparent", borderWidth: 2, tension: .3,
                   pointRadius: 4, pointBackgroundColor: C.pink, spanGaps: true, yAxisID: "y",
                   rotulo: { casas: 0, cor: C.pink } },
                 { type: "line", label: "IA", data: sem.map(x => x.ia ?? null),
                   borderColor: C.teal, backgroundColor: "transparent", borderWidth: 2, tension: .3,
                   pointRadius: 4, pointBackgroundColor: C.teal, spanGaps: true, yAxisID: "y",
                   rotulo: { casas: 0, cor: "#009193", abaixo: true } }]
              : [{ type: "line", label: "Comportamental", data: sem.map(x => classe(x, "comportamental")),
                   borderColor: C.pink, backgroundColor: "transparent", borderWidth: 2, tension: .3,
                   pointRadius: 4, pointBackgroundColor: C.pink, spanGaps: true, yAxisID: "y",
                   rotulo: { casas: 0, cor: C.pink } },
                 { type: "line", label: "Técnica", data: sem.map(x => classe(x, "tecnica")),
                   borderColor: C.teal, backgroundColor: "transparent", borderWidth: 2, tension: .3,
                   pointRadius: 4, pointBackgroundColor: C.teal, spanGaps: true, yAxisID: "y",
                   rotulo: { casas: 0, cor: "#009193", abaixo: true } }]),
            { type: "line", label: "SLA mediano (dias)",
              data: sem.map(x => x.sla_mediano_dias === undefined ? null : x.sla_mediano_dias),
              borderColor: C.chumbo, backgroundColor: "transparent", borderWidth: 2.4, tension: .3,
              pointRadius: 4, pointBackgroundColor: C.chumbo, pointBorderColor: "#fff",
              pointBorderWidth: 2, spanGaps: true, yAxisID: "y1",
              rotulo: { casas: 1, cor: C.chumbo } } ] },
          options: opcoes({ layout: { padding: { top: 18 } },
            plugins: { legend: legenda(10) },
            scales: { y: { beginAtZero: true, stacked: true, grid: { color: C.grid } },
                      y1: { beginAtZero: true, position: "right", grid: { display: false },
                            title: { display: true, text: "dias", font: { size: 10 } } },
                      x: { stacked: true, grid: { display: false } } } }) };
      }
    });
  }

  /* =====================================================================
     ANÁLISE DE TICKETS  (subtópico de Suporte)
     Os mesmos tickets das Ocorrencias, lidos como fila: cartoes no formato
     dos de FCR e CSAT, e a distribuicao por assunto em linha.
     ===================================================================== */

  /* ---------- De onde a Analise de tickets le ----------
     So do Zendesk. Ocorrencia da Comunidade e ticket de suporte sao
     populacoes diferentes — uma e operacao de cuidado (alteracao de PAD, furo
     de escala), a outra e o ISA pedindo ajuda no chat. Ja emprestei os numeros
     de uma para a outra enquanto o Zendesk nao vinha; era numero certo com
     rotulo errado, que e pior do que numero nenhum. */
  function baseTickets() {
    const zen = S.zt && S.zt.meses && Object.keys(S.zt.meses).length ? S.zt : null;
    return zen
      ? { meses: zen.meses, fonte: "zendesk", chaveAssunto: "por_assunto", info: zen }
      : null;
  }

  const IND_TICKET = [
    { id: "tk_total",  rotulo: "Tickets abertos", nota: "Volume do mês na Comunidade",
      melhor: "baixo", casas: 0, valor: m => m.total },
    { id: "tk_fin",    rotulo: "Finalizados", nota: "Encerrados de fato",
      melhor: "cima", casas: 0, valor: m => m.finalizadas },
    { id: "tk_aberto", rotulo: "Em aberto", nota: "Criados ou em progresso, ainda na fila",
      melhor: "baixo", casas: 0, valor: m => m.em_aberto },
    { id: "tk_taxa",   rotulo: "Taxa de finalização", nota: "Finalizados sobre o total do mês",
      melhor: "cima", casas: 1, suf: "%", valor: m => m.total ? 100 * m.finalizadas / m.total : null },
    { id: "tk_sla",    rotulo: "SLA mediano", nota: "Dias entre abertura e encerramento",
      melhor: "baixo", casas: 1, suf: " d", valor: m => m.sla_mediano_dias ?? null },
    { id: "tk_pico",   rotulo: "Caso mais longo", nota: "Maior tempo até encerrar no mês",
      melhor: "baixo", casas: 1, suf: " d", valor: m => m.sla_max_h === undefined ? null : m.sla_max_h / 24 }
  ];

  // qual numero a distribuicao por assunto mostra
  const IND_ASSUNTO = [
    { id: "total", rotulo: "Abertos", campo: "total", casas: 0 },
    { id: "finalizadas", rotulo: "Finalizados", campo: "finalizadas", casas: 0 },
    { id: "em_aberto", rotulo: "Em aberto", campo: "em_aberto", casas: 0 },
    { id: "sla", rotulo: "SLA (dias)", campo: "sla_mediano_dias", casas: 1 }
  ];

  function tickets() {
    const base = baseTickets();
    const meses = tkMesesSerie();

    filaDeTickets(base);

    // o mes de referencia e o mesmo para os dois blocos da aba: sem isso o
    // volume mostraria setembro enquanto a fila mostra agosto
    const atual = !meses.length ? null
                : base.meses[S.tkMes] ? S.tkMes
                : (meses.includes(S.mes) ? S.mes : meses[meses.length - 1]);
    if (atual) S.tkMes = atual;

    // o volume vem do Zendesk nos dois casos: contado pela API, ou digitado
    // no CSV enquanto a API nao existe
    if (base && atual) cartoesVolumeZendesk(meses, atual, base);
    else if (!base) {
      const mensal = zenMensal();
      const mesVol = mensal.some(r => r.mes === S.mes) ? S.mes
                   : (mensal.length ? mensal[mensal.length - 1].mes : null);
      cartoesVolume(mensal, mesVol);
    }

    if (!base || !atual) return;


    cartoesTicket(meses, atual, base);
    seletorIndAssunto();
    grafTkAssunto();
  }

/* ---------- Volume atendido: humano, IA e o total ----------
     Vem do CSV do Zendesk, preenchido a mao — o ticket de suporte nao esta no
     Metabase, so os da Comunidade estao. Enquanto as colunas estiverem vazias
     os cartoes dizem isso em vez de mostrar zero, que seria uma afirmacao
     errada sobre a operacao. */
  const IND_VOLUME = [
    { id: "vol_humano", rotulo: "Total humano", campo: "tickets_humano",
      nota: "Conversas que um atendente tocou" },
    { id: "vol_ia", rotulo: "Total IA", campo: "tickets_ia",
      nota: "Conversas atendidas pela IA" },
    { id: "vol_geral", rotulo: "Total geral", campo: null,
      nota: "Humano + IA" }
  ];

  const volumeDe = (ind, linha) => {
    if (!linha) return null;
    if (ind.campo) return num(linha[ind.campo]);
    const h = num(linha.tickets_humano), i = num(linha.tickets_ia);
    return h === null && i === null ? null : (h || 0) + (i || 0);
  };

  function cartoesVolume(mensal, atual) {
    const box = $("#tk-volume");
    if (!box) return;
    const meses = mensal.map(r => r.mes);
    const idx = meses.indexOf(atual);
    const anterior = idx > 0 ? mensal[idx - 1] : null;
    const linha = mensal[idx] || null;
    const temDado = mensal.some(r => volumeDe(IND_VOLUME[2], r) !== null);


    box.innerHTML = IND_VOLUME.map(ind => {
      const v = volumeDe(ind, linha), ant = volumeDe(ind, anterior);
      let delta = "";
      if (v !== null && ant !== null && ant !== 0) {
        const pct = (v - ant) / Math.abs(ant) * 100;
        delta = '<span class="delta ' + (pct >= 0 ? "up" : "down") + '">' +
                (pct >= 0 ? "+" : "−") + fmt(Math.abs(pct), 1) + "%</span>";
      }
      // no total, a nota vira a fatia da IA — que e a leitura que interessa
      let nota = ind.nota;
      if (ind.id === "vol_geral" && v) {
        const ia = volumeDe(IND_VOLUME[1], linha);
        if (ia !== null) nota = fmt(100 * ia / v, 1) + "% resolvido pela IA";
      }
      return '<div class="card sup-card" data-vol="' + ind.id + '">' +
        '<div class="metric-label">' + ind.rotulo + "</div>" +
        '<div class="sup-num tabular">' + (v === null ? "—" : fmt(v, 0)) + delta + "</div>" +
        '<div class="metric-note">' + nota + "</div>" +
        '<div class="sup-spark" title="Clique para ver as semanas">' +
        '<canvas id="spark-' + ind.id + '"></canvas></div></div>';
    }).join("");

    IND_VOLUME.forEach(ind => {
      grafico("spark-" + ind.id, { type: "line",
        data: { labels: meses.map(mesCurto), datasets: [{
          label: ind.rotulo, data: mensal.map(r => volumeDe(ind, r)),
          borderColor: C.blue, backgroundColor: C.blueFill, fill: true,
          borderWidth: 2.2, tension: .35, spanGaps: true,
          pointRadius: meses.map(m => m === atual ? 4.5 : 3),
          pointBackgroundColor: meses.map(m => m === atual ? C.pink : C.blue),
          pointBorderColor: "#fff", pointBorderWidth: 1.5,
          rotulo: { casas: 0, cor: C.blue } }] },
        options: opcoes({ onClick: () => popVolume(ind),
          layout: { padding: { top: 14, bottom: 2 } },
          plugins: { legend: { display: false },
            tooltip: { callbacks: { label: c => c.parsed.y === null ? "sem dado"
                                     : fmt(c.parsed.y, 0) + " conversas" } } },
          scales: { y: { display: false, grace: "26%" },
                    x: { grid: { display: false }, ticks: { font: { size: 9 }, color: C.text } } } }) });
    });

    $$(".sup-card[data-vol]").forEach(card => card.addEventListener("click", () => {
      const ind = IND_VOLUME.find(i => i.id === card.dataset.vol);
      if (ind) popVolume(ind);
    }));
  }

/* Com o Zendesk ligado, humano e IA sao contagem de ticket, nao numero
     digitado: cada ticket ja chega marcado pela regra de
     data/classificacao_zendesk.json. */
  function cartoesVolumeZendesk(meses, atual, base) {
    const box = $("#tk-volume");
    if (!box) return;
    const bloco = m => base.meses[m] || {};
    const idx = meses.indexOf(atual);
    const antes = idx > 0 ? bloco(meses[idx - 1]) : null;
    const b = bloco(atual);

    const linhas = [
      { id: "vol_humano", rotulo: "Total humano", valor: m => m.humano ?? null,
        nota: "Conversas que um atendente tocou" },
      { id: "vol_ia", rotulo: "Total IA", valor: m => m.ia ?? null,
        nota: "Conversas resolvidas pelo agente automático" },
      { id: "vol_geral", rotulo: "Total geral", valor: m => m.total ?? null,
        nota: "Humano + IA" }
    ];

    box.innerHTML = linhas.map(ind => {
      const v = ind.valor(b), ant = antes ? ind.valor(antes) : null;
      let delta = "";
      if (v !== null && ant !== null && ant !== 0) {
        const pct = (v - ant) / Math.abs(ant) * 100;
        delta = '<span class="delta ' + (pct >= 0 ? "up" : "down") + '">' +
                (pct >= 0 ? "+" : "−") + fmt(Math.abs(pct), 1) + "%</span>";
      }
      let nota = ind.nota;
      if (ind.id === "vol_geral" && v) nota = fmt(100 * (b.ia || 0) / v, 1) + "% resolvido pela IA";
      return '<div class="card sup-card" data-volz="' + ind.id + '">' +
        '<div class="metric-label">' + ind.rotulo + "</div>" +
        '<div class="sup-num tabular">' + (v === null ? "—" : fmt(v, 0)) + delta + "</div>" +
        '<div class="metric-note">' + nota + "</div>" +
        '<div class="sup-spark"><canvas id="spark-' + ind.id + '"></canvas></div></div>';
    }).join("");

    linhas.forEach(ind => {
      grafico("spark-" + ind.id, { type: "line",
        data: { labels: meses.map(mesCurto), datasets: [{
          label: ind.rotulo, data: meses.map(m => ind.valor(bloco(m))),
          borderColor: C.blue, backgroundColor: C.blueFill, fill: true,
          borderWidth: 2.2, tension: .35, spanGaps: true,
          pointRadius: meses.map(m => m === atual ? 4.5 : 3),
          pointBackgroundColor: meses.map(m => m === atual ? C.pink : C.blue),
          pointBorderColor: "#fff", pointBorderWidth: 1.5,
          rotulo: { casas: 0, cor: C.blue } }] },
        options: opcoes({ onClick: (e, el) => popOcorrencias(el, meses),
          layout: { padding: { top: 14, bottom: 2 } },
          plugins: { legend: { display: false },
            tooltip: { callbacks: { label: c => c.parsed.y === null ? "sem dado"
                                     : fmt(c.parsed.y, 0) + " conversas" } } },
          scales: { y: { display: false, grace: "26%" },
                    x: { grid: { display: false }, ticks: { font: { size: 9 }, color: C.text } } } }) });
    });
  }

  /** Semana a semana do volume, no mesmo card flutuante do resto do painel. */
  function popVolume(ind) {
    const meses = mesesComSemana();
    if (!meses.length) return;
    abrirPop({
      titulo: ind.rotulo + " semana a semana",
      meses: meses,
      mes: S.sacMes,
      sub: m => ind.nota + " · semanas de " + mesLabel(m).toLowerCase(),
      nota: m => {
        const sem = zenSemanal(m);
        const total = sem.reduce((a, r) => a + (volumeDe(ind, r) || 0), 0);
        return total ? "Somando as semanas: <b>" + fmt(total, 0) + "</b> conversas." : "";
      },
      config: m => {
        const sem = zenSemanal(m);
        return { type: "bar",
          data: { labels: sem.map(r => "S" + r.semana + (r.periodo ? " · " + r.periodo.replace(/ de \w+/i, "") : "")),
            datasets: [{ label: ind.rotulo, data: sem.map(r => volumeDe(ind, r)),
              backgroundColor: C.blue, borderRadius: 4, maxBarThickness: 46,
              rotulo: { casas: 0, cor: C.blue } }] },
          options: opcoes({ layout: { padding: { top: 18 } },
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true, grid: { color: C.grid } },
                      x: { grid: { display: false } } } }) };
      }
    });
  }

/* Sem Zendesk nao ha fila para mostrar. O quadro diz o que falta em vez de
     deixar a secao em branco — e em vez de preenche-la com outra coisa. */
  function filaDeTickets(base) {
    const vazio = $("#tk-vazio"), corpo = $("#tk-fila");
    if (!vazio || !corpo) return;
    if (base) {
      vazio.innerHTML = "";
      corpo.hidden = false;
      return;
    }
    corpo.hidden = true;
    vazio.innerHTML =
      '<div class="card aguardando">' +
      '<div class="card-title">Esperando a conexão com o Zendesk</div>' +
      '<p>Volume aberto, tempo de resolução e distribuição por assunto saem do ' +
      'Zendesk, que é onde o ticket de suporte nasce. Enquanto a API não estiver ' +
      'ligada, esta parte fica vazia de propósito: os tickets da Comunidade que ' +
      'aparecem na aba <b>Ocorrências</b> são outra coisa — operação de cuidado, ' +
      'não atendimento ao ISA — e mostrá-los aqui seria número certo com rótulo ' +
      'errado.</p>' +
      '<p class="passo">Para ligar: <code>powershell -File scripts\\salvar_chave_zendesk.ps1</code>' +
      '<br>O token precisa ser gerado por alguém com papel de admin no Zendesk.</p>' +
      "</div>";
  }

  function cartoesTicket(meses, atual, base) {
    const bloco = m => base.meses[m];
    const idx = meses.indexOf(atual);
    const anterior = idx > 0 ? bloco(meses[idx - 1]) : null;

    [["#tk-linha-1", 0, 3], ["#tk-linha-2", 3, 6]].forEach(([alvo, ini, fim]) => {
      const box = $(alvo);
      if (!box) return;
      box.innerHTML = IND_TICKET.slice(ini, fim).map(ind => {
        const v = ind.valor(bloco(atual));
        const ant = anterior ? ind.valor(anterior) : null;
        let delta = "";
        if (v !== null && ant !== null && ant !== 0) {
          const pct = (v - ant) / Math.abs(ant) * 100;
          const bom = ind.melhor === "baixo" ? pct < 0 : pct > 0;
          delta = '<span class="delta ' + (bom ? "up" : "down") + '">' +
                  (pct >= 0 ? "+" : "−") + fmt(Math.abs(pct), 1) + "%</span>";
        }
        return '<div class="card sup-card">' +
          '<div class="metric-label">' + ind.rotulo + "</div>" +
          '<div class="sup-num tabular">' +
          (v === null ? "—" : fmt(v, ind.casas) + (ind.suf || "")) + delta + "</div>" +
          '<div class="metric-note">' + ind.nota + "</div>" +
          '<div class="sup-spark" title="Clique para ver as semanas">' +
          '<canvas id="spark-' + ind.id + '"></canvas></div></div>';
      }).join("");
    });

    IND_TICKET.forEach(ind => {
      const serie = meses.map(m => ind.valor(bloco(m)));
      grafico("spark-" + ind.id, { type: "line",
        data: { labels: meses.map(mesCurto), datasets: [{
          data: serie, borderColor: C.blue, backgroundColor: C.blueFill, fill: true,
          borderWidth: 2.2, tension: .3, spanGaps: true,
          pointRadius: meses.map(m => m === atual ? 4.5 : 3),
          pointBackgroundColor: meses.map(m => m === atual ? C.pink : C.blue),
          pointBorderColor: "#fff", pointBorderWidth: 1.5,
          rotulo: { casas: ind.casas, cor: C.blue, sufixo: ind.suf || "" } }] },
        options: opcoes({ onClick: (e, el) => popOcorrencias(el, meses),
          layout: { padding: { top: 14, bottom: 2 } },
          plugins: { legend: { display: false },
            tooltip: { callbacks: { label: c => c.parsed.y === null ? "sem dado"
                                     : fmt(c.parsed.y, ind.casas) + (ind.suf || "") } } },
          scales: { y: { display: false, grace: "26%" },
                    x: { grid: { display: false }, ticks: { font: { size: 9 }, color: C.text } } } }) });
    });
  }

  function seletorIndAssunto() {
    const seg = $("#seg-tk-ind");
    if (!seg) return;
    if (!S.tkInd) S.tkInd = "total";
    seg.innerHTML = IND_ASSUNTO.map(i =>
      '<button class="' + (i.id === S.tkInd ? "active" : "") + '" data-ind="' + i.id + '">' +
      i.rotulo + "</button>").join("");
    $$("#seg-tk-ind button").forEach(b => b.addEventListener("click", () => {
      S.tkInd = b.dataset.ind;
      seletorIndAssunto();
      grafTkAssunto();
    }));
  }

  /** Distribuicao por assunto: uma linha por tipo de ticket, mes a mes. */
  function grafTkAssunto() {
    const base = baseTickets();
    if (!base) return;
    const meses = tkMesesSerie();
    const ind = IND_ASSUNTO.find(i => i.id === S.tkInd) || IND_ASSUNTO[0];
    const bloco = m => (base.meses[m] || {})[base.chaveAssunto] || {};

    const soma = {};
    meses.forEach(m => Object.entries(bloco(m)).forEach(([nome, v]) =>
      soma[nome] = (soma[nome] || 0) + (v.total || 0)));
    const nomes = Object.keys(soma).sort((a, b) => soma[b] - soma[a]).slice(0, 7);


    grafico("chart-tk-assunto", { type: "line",
      data: { labels: meses.map(mesCurto), datasets: nomes.map((nome, i) => ({
        label: nome,
        data: meses.map(m => { const v = bloco(m)[nome]; return v ? (v[ind.campo] ?? null) : null; }),
        borderColor: CORES_SERIE[i % CORES_SERIE.length], backgroundColor: "transparent",
        borderWidth: 2.2, tension: .3,
        pointRadius: meses.map(m => m === S.tkMes ? 5 : 3),
        pointBackgroundColor: CORES_SERIE[i % CORES_SERIE.length],
        pointBorderColor: "#fff", pointBorderWidth: 1.5, spanGaps: true,
        rotulo: { casas: ind.casas, cor: CORES_SERIE[i % CORES_SERIE.length], soUltimo: true }
      })) },
      options: opcoes({ onClick: (e, el) => popOcorrencias(el, meses),
        layout: { padding: { right: 46 } },
        plugins: { legend: legenda(10) },
        scales: { y: { beginAtZero: true, grid: { color: C.grid } },
                  x: { grid: { display: false } } } }) });
  }

  const ONB_SEMANAS = 12;   // um trimestre — mais que isso e o eixo vira risco

  function onbSemanas() {
    const todas = (S.onb && S.onb.semanas) || [];
    return todas.slice(-ONB_SEMANAS);
  }

  /** Semanas cuja turma ainda pode ativar — a taxa delas sobe depois. */
  function onbParciais(lista) {
    return lista.filter(s => !s.coorte_fechada).length;
  }

  /** Título do tooltip: aí sim a semana inteira, que é o que se lê devagar. */
  function onbTitulo(lista) {
    return itens => { const s = lista[itens[0].dataIndex]; return s ? "Semana de " + s.label : ""; };
  }

  /* Metas do funil, lidas de data/metas.json (bloco `onboarding`) e repetidas
     em onboarding.json por quem coletou — se as duas discordarem, vale a do
     arquivo de metas, que e o que alguem edita. */
  function metaOnb(chave, padrao) {
    const doPainel = ((S.metas || {}).onboarding || {})[chave];
    if (doPainel !== undefined && doPainel !== null) return doPainel;
    const doArquivo = ((S.onb || {}).metas || {})[chave];
    return doArquivo === undefined || doArquivo === null ? padrao : doArquivo;
  }

  function onboarding() {
    if (!S.onb) return;
    const lista = onbSemanas();
    cartoesOnb(lista);
    grafOnbTempo(lista);
    grafOnbAtivacao(lista);
    grafOnbTemporarios(lista);
    grafOnbAssistido(lista);
  }

  /* Cartao no formato do Farol: numero grande, meta embaixo, barra de quanto
     do caminho foi feito e a variacao contra a semana anterior. */
  function cartaoFarol(c) {
    const pct = c.pct === null ? null : Math.max(0, Math.min(100, c.pct));
    const cls = pct === null ? "" : pct >= 100 ? "ok" : pct >= 85 ? "risco" : "off";
    return '<div class="card onb-card">' +
      '<div class="metric-label">' + c.rotulo + "</div>" +
      '<div class="sup-num tabular">' + c.valor +
      (c.delta || "") + "</div>" +
      '<div class="onb-meta">meta: ' + c.meta + "</div>" +
      '<div class="onb-barra"><i class="' + cls + '" style="width:' +
      (pct === null ? 0 : pct) + '%"></i></div>' +
      '<div class="onb-rodape ' + cls + '">' + (c.rodape || "") + "</div>" +
      (c.nota ? '<div class="onb-nota">' + c.nota + "</div>" : "") +
      "</div>";
  }

  function cartoesOnb(lista) {
    const hoje = S.onb.hoje || {};
    const ultima = lista[lista.length - 1] || {};
    const antes = lista[lista.length - 2] || {};

    const alvoTempo = metaOnb("tempo_ativacao_dias", 2);
    const alvoTaxa = metaOnb("taxa_ativacao_pct", 40);
    const alvoTemp = metaOnb("temporarios", 0);

    /* Variacao contra a semana anterior. `melhor` diz para que lado e bom:
       em tempo e temporarios, cair e ganhar. */
    const variacao = (agora, antes_, melhor) => {
      if (agora === null || agora === undefined || antes_ === null ||
          antes_ === undefined || antes_ === 0) return "";
      const pct = (agora - antes_) / Math.abs(antes_) * 100;
      const bom = melhor === "baixo" ? pct < 0 : pct > 0;
      return '<span class="delta ' + (bom ? "up" : "down") + '">' +
        (pct >= 0 ? "+" : "−") + fmt(Math.abs(pct), 0) + "%</span>";
    };

    const t = ultima.tempo_medio_ativacao;
    const taxa = ultima.taxa_ativacao;
    const temp = ultima.temporarios;
    const assistido = hoje.em_onboarding_assistido;

    const cartoes = [
      cartaoFarol({
        rotulo: "Tempo médio de ativação · semana",
        valor: t === null || t === undefined ? "—" : fmt(t, 1) + " dias",
        delta: variacao(t, antes.tempo_medio_ativacao, "baixo"),
        meta: "≤ " + fmt(alvoTempo, 0) + " dias",
        // meta e teto: o caminho feito e quanto do limite sobrou
        pct: t === null || t === undefined || t === 0 ? null : alvoTempo / t * 100,
        rodape: t === null || t === undefined ? "sem ativação nesta turma"
          : (t <= alvoTempo ? "✓ dentro da meta" : "▲ " + fmt(t - alvoTempo, 1) + " dia(s) acima da meta"),
        nota: ultima.pct_na_meta === null || ultima.pct_na_meta === undefined ? ""
          : fmt(ultima.pct_na_meta, 0) + "% na meta · " + ultima.ativados_da_coorte + " ativados"
      }),
      cartaoFarol({
        rotulo: "Taxa de ativação · semana",
        valor: taxa === null || taxa === undefined ? "—" : fmt(taxa, 1) + "%",
        delta: variacao(taxa, antes.taxa_ativacao, "cima"),
        meta: fmt(alvoTaxa, 0) + "%",
        pct: taxa === null || taxa === undefined ? null : taxa / alvoTaxa * 100,
        rodape: taxa === null || taxa === undefined ? "sem cadastro na semana"
          : taxa >= alvoTaxa ? "✓ dentro da meta"
          : "faltam " + fmt(alvoTaxa - taxa, 1) + " p.p.",
        nota: ultima.coorte_fechada ? ultima.cadastros + " cadastros na turma"
          : ultima.cadastros + " cadastros · turma ainda dentro da janela de " +
            (S.onb.janela_ativacao_dias || 30) + " dias"
      }),
      cartaoFarol({
        rotulo: "Temporários · turma da semana",
        valor: temp === null || temp === undefined ? "—" : fmt(temp, 0),
        delta: variacao(temp, antes.temporarios, "baixo"),
        meta: "perto de " + fmt(alvoTemp, 0),
        // sem alvo positivo nao ha fracao de caminho: a barra vira participacao
        pct: ultima.cadastros ? 100 - (temp / ultima.cadastros * 100) : null,
        rodape: !ultima.cadastros ? "" :
          fmt(temp / ultima.cadastros * 100, 1) + "% dos cadastros da semana",
        nota: "hoje são <b>" + (hoje.temporarios ?? 0) + "</b> em toda a base"
      }),
      cartaoFarol({
        rotulo: "Em onboarding assistido",
        valor: assistido === null || assistido === undefined ? "—" : fmt(assistido, 0),
        meta: "sem meta definida",
        pct: null,
        rodape: "cadastros parados aguardando a operação",
        nota: '<span class="pendente">Aproximação — o número oficial virá da planilha do Gabi.</span>'
      })
    ];
    $("#onb-cartoes").innerHTML = cartoes.join("");
  }

  /** Eixo x comum aos quatro gráficos, para as semanas baterem entre eles. */
  function onbEixoCurto(lista) { return lista.map(s => s.label.split(" a ")[0]); }

  /** Linha de meta: cinza claro e tracejada, igual à do resto do painel. */
  function linhaMeta(valor, lista, rotuloCasas) {
    return { type: "line", label: "Meta", data: lista.map(() => valor), borderColor: C.cinzaMeta,
      borderDash: [5, 4], borderWidth: 1.8, backgroundColor: "transparent",
      pointRadius: 0, tension: 0, spanGaps: true,
      rotulo: { casas: rotuloCasas ?? 0, cor: C.cinzaMeta, soUltimo: true } };
  }

  function grafOnbTempo(lista) {
    const alvo = metaOnb("tempo_ativacao_dias", 2);

    grafico("chart-onb-tempo", { type: "line",
      data: { labels: onbEixoCurto(lista), datasets: [
        { label: "Dias até ativar", data: lista.map(s => s.tempo_medio_ativacao),
          borderColor: C.blue, backgroundColor: C.blueFill, fill: true, tension: .3,
          borderWidth: 2.5, pointRadius: 4.5, pointBackgroundColor: C.blue,
          pointBorderColor: "#fff", pointBorderWidth: 2, spanGaps: true,
          rotulo: { casas: 1, cor: C.blue } },
        linhaMeta(alvo, lista, 0) ] },
      options: opcoes({ layout: { padding: { top: 18, right: 34 } },
        plugins: { legend: legenda(),
          tooltip: { callbacks: { title: onbTitulo(lista), afterBody: itens => {
            const s = lista[itens[0].dataIndex];
            if (!s || s.pct_na_meta === null || s.pct_na_meta === undefined) return "";
            return fmt(s.pct_na_meta, 0) + "% ativaram em até " + fmt(alvo, 0) + " dias" +
                   " · " + s.ativados_da_coorte + " de " + s.cadastros + " cadastros";
          } } } },
        scales: { y: { beginAtZero: true, grid: { color: C.grid },
                       title: { display: true, text: "dias", font: { size: 10 } } },
                  x: { grid: { display: false } } } }) });
  }

  function grafOnbAtivacao(lista) {
    const alvo = metaOnb("taxa_ativacao_pct", 40);

    /* A taxa das semanas ainda abertas fica pontilhada: elas nao cairam, so
       nao tiveram tempo de ativar todo mundo. */
    grafico("chart-onb-ativacao", { type: "bar",
      data: { labels: onbEixoCurto(lista), datasets: [
        { type: "bar", label: "Ativados", data: lista.map(s => s.ativados_da_coorte),
          backgroundColor: C.teal, borderRadius: 4, maxBarThickness: 30, yAxisID: "y",
          rotulo: { casas: 0, cor: C.blue } },
        { type: "line", label: "Taxa de ativação (%)", data: lista.map(s => s.taxa_ativacao),
          borderColor: C.pink, backgroundColor: "transparent", tension: .3, borderWidth: 2.4,
          pointRadius: lista.map(s => s.coorte_fechada ? 4.5 : 3),
          pointStyle: lista.map(s => s.coorte_fechada ? "circle" : "triangle"),
          pointBackgroundColor: C.pink, spanGaps: true, yAxisID: "y1",
          segment: { borderDash: ctx => lista[ctx.p1DataIndex] && !lista[ctx.p1DataIndex].coorte_fechada
                                        ? [5, 4] : undefined },
          rotulo: { casas: 1, sufixo: "%", cor: C.pink, soUltimo: true } },
        Object.assign(linhaMeta(alvo, lista, 0), { yAxisID: "y1", label: "Meta" }) ] },
      options: opcoes({ layout: { padding: { top: 18, right: 40 } },
        plugins: { legend: legenda(),
          tooltip: { callbacks: { title: onbTitulo(lista), afterBody: itens => {
            const s = lista[itens[0].dataIndex];
            if (!s) return "";
            const base = s.cadastros + " cadastros na semana · " +
              s.ativacoes_na_semana + " ativações aconteceram nesta semana";
            return s.coorte_fechada ? base
              : base + " — turma ainda dentro da janela de " +
                (S.onb.janela_ativacao_dias || 30) + " dias, a taxa ainda sobe";
          } } } },
        scales: { y: { beginAtZero: true, grid: { color: C.grid },
                       title: { display: true, text: "pessoas", font: { size: 10 } } },
                  y1: { beginAtZero: true, max: 100, position: "right", grid: { display: false },
                        ticks: { callback: v => v + "%" } },
                  x: { grid: { display: false } } } }) });

    const box = $("#onb-leitura");
    if (!box) return;
    const fechadas = lista.filter(s => s.coorte_fechada && s.taxa_ativacao !== null);
    if (fechadas.length < 2) { box.innerHTML = ""; return; }
    const ini = fechadas[0], fim = fechadas[fechadas.length - 1];
    const dif = fim.taxa_ativacao - ini.taxa_ativacao;
    const abertas = onbParciais(lista);
    box.innerHTML = '<span class="rot">Leitura</span><span>' +
      "Entre as turmas já fechadas, a taxa de ativação saiu de <b>" + fmt(ini.taxa_ativacao, 1) +
      "%</b> na semana de " + ini.label + " para <b>" + fmt(fim.taxa_ativacao, 1) + "%</b> em " +
      fim.label + (dif >= 0 ? " — subiu " : " — caiu ") + fmt(Math.abs(dif), 1) + " ponto" +
      (Math.abs(dif) >= 2 ? "s" : "") + ", contra uma meta de " + fmt(alvo, 0) + "%." +
      (abertas ? " As <b>" + abertas + " semanas mais recentes</b> aparecem pontilhadas porque a turma ainda está dentro da janela de ativação." : "") +
      "</span>";
  }

  function grafOnbTemporarios(lista) {
    const alvo = metaOnb("temporarios", 0);

    grafico("chart-onb-temporarios", { type: "bar",
      data: { labels: onbEixoCurto(lista), datasets: [
        { type: "bar", label: "Temporários hoje", data: lista.map(s => s.temporarios),
          backgroundColor: C.amber, borderRadius: 4, maxBarThickness: 30,
          rotulo: { casas: 0, cor: C.featured || "#202020" } },
        linhaMeta(alvo, lista, 0) ] },
      options: opcoes({ layout: { padding: { top: 18, right: 34 } },
        plugins: { legend: legenda(),
          tooltip: { callbacks: { title: onbTitulo(lista), afterBody: itens => {
            const s = lista[itens[0].dataIndex];
            return s && s.cadastros ? "de " + s.cadastros + " cadastros dessa semana (" +
              fmt(100 * s.temporarios / s.cadastros, 1) + "%)" : "";
          } } } },
        scales: { y: { beginAtZero: true, grid: { color: C.grid } },
                  x: { grid: { display: false } } } }) });
  }

  function grafOnbAssistido(lista) {
    const hoje = S.onb.hoje || {}, det = hoje.detalhe_assistido || {};
    const sub = $("#onb-assistido-sub");
    /* Nao existe marcador de "onboarding assistido" no cadastro. O que da para
       medir e quem esta parado num status que so anda com alguem da operacao.
       O numero definitivo vem da planilha do Gabi, ainda nao conectada. */
    if (sub) sub.innerHTML = "Cadastros parados num status que só anda com alguém da operação — hoje são <b>" +
      (hoje.em_onboarding_assistido ?? 0) + "</b>: " +
      [["Em validação", det.UNDER_REVIEW], ["Em revisão manual", det.PENDING_REVIEW],
       ["Incompleto", det.INCOMPLETE]].filter(x => x[1]).map(x => x[1] + " " + x[0].toLowerCase()).join(", ") +
      '. <span class="pendente">Aproximação — o número oficial virá da planilha do Gabi.</span>';

    grafico("chart-onb-assistido", { type: "bar",
      data: { labels: onbEixoCurto(lista), datasets: [{
        label: "Aguardando a operação", data: lista.map(s => s.assistido),
        backgroundColor: C.blue, borderRadius: 4, maxBarThickness: 30,
        rotulo: { casas: 0, cor: C.blue } }] },
      options: opcoes({ layout: { padding: { top: 18 } },
        plugins: { legend: { display: false },
          tooltip: { callbacks: { title: onbTitulo(lista), afterBody: itens => {
            const s = lista[itens[0].dataIndex];
            return s && s.cadastros ? fmt(100 * s.assistido / s.cadastros, 0) +
              "% dos " + s.cadastros + " cadastros da semana" : "";
          } } } },
        scales: { y: { beginAtZero: true, grid: { color: C.grid } },
                  x: { grid: { display: false } } } }) });
  }

  /* =====================================================================
     COMENTÁRIOS DO NPS
     Uma tela sobre o painel, organizada por mês. Cada gráfico abre a sua
     fatia: o de dimensões abre o tema escolhido, os outros abrem tudo.
     ===================================================================== */

  function comentariosDe(filtro) {
    const f = filtro || {};
    return ((S.com && S.com.comentarios) || []).filter(c =>
      (!f.tema || c.tema === f.tema) && (!f.classe || c.classe === f.classe));
  }

  function abrirComentarios(filtro) {
    S.comFiltro = Object.assign({ classe: "" }, filtro || {});
    montarFiltrosCom();
    desenharComentarios();

    const painel = $("#com-painel");
    painel.classList.add("aberto");
    painel.setAttribute("aria-hidden", "false");
    document.body.classList.add("sem-rolagem");
    $("#com-corpo").scrollTop = 0;
  }

  /** O seletor de tema só oferece temas que existem nos dados coletados. */
  function montarFiltrosCom() {
    const temas = (S.com && S.com.temas) || [];
    const sel = $("#com-tema");
    if (sel && sel.options.length !== temas.length + 1) {
      sel.innerHTML = '<option value="">Todos os temas</option>' +
        temas.map(t => '<option value="' + t + '">' + t + "</option>").join("");
    }
    if (sel) sel.value = S.comFiltro.tema || "";
    $$("#seg-com-classe button").forEach(b =>
      b.classList.toggle("active", (b.dataset.classe || "") === (S.comFiltro.classe || "")));
  }

  function desenharComentarios() {
    const lista = comentariosDe(S.comFiltro);
    const caixa = $("#com-corpo");
    $("#com-titulo").textContent = S.comFiltro.tema
      ? "Comentários · " + S.comFiltro.tema : "Comentários do NPS";

    if (!S.com) {
      caixa.innerHTML = '<div class="empty">Os comentários ainda não foram coletados. ' +
        "Rode <code>py scripts/fetch_comentarios.py</code>.</div>";
    } else if (!lista.length) {
      caixa.innerHTML = '<div class="empty">Nenhum comentário para este recorte.</div>';
    } else {
      const meses = {};
      lista.forEach(c => (meses[c.mes] = meses[c.mes] || []).push(c));
      caixa.innerHTML = Object.keys(meses).sort().reverse().map(mes => {
        const doMes = meses[mes];
        const cont = { promotor: 0, neutro: 0, detrator: 0 };
        doMes.forEach(c => { if (cont[c.classe] !== undefined) cont[c.classe]++; });
        return '<div class="com-mes"><div class="com-mes-cab">' +
          "<b>" + mesLabel(mes) + " de " + mes.slice(0, 4) + "</b>" +
          '<span class="com-cont">' + doMes.length + " comentários · " +
          cont.promotor + " promotores, " + cont.neutro + " neutros, " +
          cont.detrator + " detratores</span></div>" +
          doMes.map(c =>
            '<div class="com-item ' + (c.classe || "") + '">' +
            '<div class="com-meta"><span class="com-tag">' + c.tema + "</span>" +
            (c.nps === null ? "" : '<span class="com-nota tabular">NPS ' + c.nps + "</span>") +
            (c.nota_tema === null || c.nota_tema === undefined ? ""
              : '<span class="com-nota tabular">nota ' + c.nota_tema + "</span>") +
            "</div><p>" + escapar(c.texto) + "</p></div>").join("") +
          "</div>";
      }).join("");
    }
  }

  function fecharComentarios() {
    const painel = $("#com-painel");
    painel.classList.remove("aberto");
    painel.setAttribute("aria-hidden", "true");
    document.body.classList.remove("sem-rolagem");
  }

  /** Texto do respondente vai para o HTML como texto, nunca como marcação. */
  function escapar(txt) {
    return String(txt).replace(/[&<>"]/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }

  /** Prende um botão "Exibir os comentários" embaixo de cada gráfico do NPS. */
  function botoesDeComentario() {
    const quantos = (S.com && S.com.comentarios || []).length;
    ALVOS_COMENTARIO.forEach(([id, tema]) => {
      const canvas = document.getElementById(id);
      if (!canvas) return;
      const card = canvas.closest(".card");
      if (!card || card.querySelector(".btn-com")) return;
      const b = document.createElement("button");
      b.className = "btn-com";
      b.type = "button";
      b.textContent = "Exibir os comentários";
      b.title = quantos ? quantos + " comentários coletados" : "Comentários ainda não coletados";
      b.addEventListener("click", () => abrirComentarios(tema ? { tema } : null));
      card.appendChild(b);
    });
  }

  const ALVOS_COMENTARIO = [
    ["chart-historico", null],
    ["chart-evo-dim", null],
    ["chart-evo-esp", null]
  ];

  function painelDeComentarios() {
    const painel = $("#com-painel");
    if (!painel) return;
    painel.querySelectorAll("[data-fechar]").forEach(el =>
      el.addEventListener("click", fecharComentarios));
    $$("#seg-com-classe button").forEach(b => b.addEventListener("click", () => {
      S.comFiltro.classe = b.dataset.classe || "";
      montarFiltrosCom();
      desenharComentarios();
      $("#com-corpo").scrollTop = 0;
    }));
    const sel = $("#com-tema");
    if (sel) sel.addEventListener("change", () => {
      S.comFiltro.tema = sel.value || null;
      desenharComentarios();
      $("#com-corpo").scrollTop = 0;
    });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && painel.classList.contains("aberto")) fecharComentarios();
    });
  }

  const ROTULOS = {
    id: "rotulos",
    afterDatasetsDraw(chart) {
      const ctx = chart.ctx;
      const r = chart.scales.r;   // existe só no radar
      const ancorados = [];       // rótulos de fim de linha, colocados depois

      ctx.save();
      ctx.font = "600 11px 'Open Sans', sans-serif";
      ctx.textBaseline = "middle";

      chart.data.datasets.forEach((ds, i) => {
        const cfg = ds.rotulo;
        if (!cfg || !chart.isDatasetVisible(i)) return;
        const meta = chart.getDatasetMeta(i);
        const barraH = meta.type === "bar" && chart.options.indexAxis === "y";
        const barraV = meta.type === "bar" && !barraH;
        const cor = cfg.cor || C.text;
        const ultimo = cfg.indice ?? ds.data.reduce((ac, v, k) => (v === null || v === undefined) ? ac : k, -1);

        meta.data.forEach((ponto, j) => {
          const v = ds.data[j];
          if (v === null || v === undefined) return;
          if (cfg.soUltimo && j !== ultimo) return;
          const txt = cfg.tempo ? tempoDeMinutos(v)
                    : fmt(v, cfg.casas ?? 1) + (cfg.sufixo || "");
          ctx.fillStyle = cor;

          if (cfg.soUltimo) {
            // guardado para posicionar junto com os outros, mais abaixo
            ancorados.push({ txt, cor, x: ponto.x + 10, y: ponto.y, py: ponto.y, px: ponto.x });
          } else if (barraH) {
            ctx.textAlign = "left"; ctx.fillText(txt, ponto.x + 7, ponto.y);
          } else if (barraV) {
            ctx.textAlign = "center"; ctx.fillText(txt, ponto.x, ponto.y + (cfg.abaixo ? 15 : -11));
          } else if (r) {
            // fora do ponto, na direção do centro, senão encosta no nome da dimensão
            const dx = ponto.x - r.xCenter, dy = ponto.y - r.yCenter;
            const d = Math.hypot(dx, dy) || 1;
            ctx.textAlign = "center";
            ctx.fillText(txt, ponto.x + dx / d * 13, ponto.y + dy / d * 13);
          } else {
            ctx.textAlign = "center";
            ctx.fillText(txt, ponto.x, ponto.y + (cfg.abaixo ? 14 : -13));
          }
        });
      });

      /* Rótulos de fim de linha: empurrar um por um na ordem dos datasets
         invertia a ordem vertical — "60,0" saía embaixo de "54,1" mesmo com a
         linha do 60,0 por cima. Aqui eles são ordenados pela altura real do
         ponto e só então espaçados, então a sequência na tela é a mesma das
         linhas. Quem sai do lugar ganha um fio ligando ao seu ponto. */
      if (ancorados.length) {
        const ALTURA = 13, area = chart.chartArea;
        ancorados.sort((a, b) => a.py - b.py);
        for (let i = 1; i < ancorados.length; i++) {
          if (ancorados[i].y - ancorados[i - 1].y < ALTURA)
            ancorados[i].y = ancorados[i - 1].y + ALTURA;
        }
        const sobra = ancorados[ancorados.length - 1].y - (area.bottom - 4);
        if (sobra > 0) {
          ancorados.forEach(a => a.y -= sobra);
          const falta = area.top + 4 - ancorados[0].y;
          if (falta > 0) ancorados.forEach(a => a.y += falta);
        }

        ancorados.forEach(a => {
          if (Math.abs(a.y - a.py) > 2) {
            ctx.strokeStyle = a.cor;
            ctx.globalAlpha = .5;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(a.px + 4, a.py);
            ctx.lineTo(a.x - 2, a.y);
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
          ctx.fillStyle = a.cor;
          ctx.textAlign = "left";
          ctx.fillText(a.txt, a.x, a.y);
        });
      }
      ctx.restore();
    }
  };
  Chart.register(ROTULOS);

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
    botoesDeComentario();
    painelDeComentarios();
    ligarPop();

    $$("#seg-esp button").forEach(b => b.addEventListener("click", () => {
      $$("#seg-esp button").forEach(x => x.classList.toggle("active", x === b));
      S.espOrdem = b.dataset.sort;
      espLista();
    }));
    $$("#seg-evo-dim button").forEach(b => b.addEventListener("click", () => {
      S.evoDim = b.dataset.eixo;
      grafEvolucaoDimensoes();
    }));
    $$("#seg-evo-esp button").forEach(b => b.addEventListener("click", () => {
      S.evoEsp = b.dataset.eixo;
      grafEvolucaoEspecialidades();
    }));
  }

  init().catch(err => {
    console.error(err);
    $(".page-wrap").insertAdjacentHTML("afterbegin",
      '<div class="notice"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/></svg>' +
      "<span>Não foi possível carregar os dados. Detalhes no console do navegador.</span></div>");
  });
})();
