// NPS dos ISAs — renderização do painel
// Dados de NPS vêm de data/nps.json (gerado automaticamente via GitHub Actions
// a partir do Databricks). Dados de Zendesk e a narrativa semanal vêm de uma
// planilha do Google Sheets publicada como CSV (ver js/config.js).

(function () {
  "use strict";

  const CHART_COLORS = {
    teal: "#00C3C5",
    tealSoft: "rgba(0,195,197,0.15)",
    blue: "#004474",
    blueSoft: "rgba(0,68,116,0.12)",
    pink: "#ED1E79",
    grayGrid: "#E8EAED",
    grayText: "#666E80"
  };

  Chart.defaults.font.family = "'Open Sans', sans-serif";
  Chart.defaults.color = CHART_COLORS.grayText;

  function parseCSV(text) {
    const rows = [];
    let row = [], field = "", inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else { inQuotes = false; }
        } else field += c;
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(field); field = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        rows.push(row); row = [];
      } else {
        field += c;
      }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }

    const cleanRows = rows.filter(r => r.some(v => v !== ""));
    if (!cleanRows.length) return [];
    const header = cleanRows.shift().map(h => h.trim());
    return cleanRows.map(r => {
      const obj = {};
      header.forEach((h, idx) => { obj[h] = (r[idx] ?? "").trim(); });
      return obj;
    });
  }

  function num(v) {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(String(v).replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }

  function fmt(n, casas) {
    if (n === null || n === undefined) return "—";
    return n.toLocaleString("pt-BR", { minimumFractionDigits: casas ?? 1, maximumFractionDigits: casas ?? 1 });
  }

  function scoreBadgeClass(v) {
    if (v === null) return "badge-neutral";
    if (v >= 4.2) return "badge-positive";
    if (v >= 3.5) return "badge-neutral";
    return "badge-negative";
  }

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  async function loadNpsData() {
    const res = await fetch("data/nps.json", { cache: "no-store" });
    return res.json();
  }

  async function loadZendeskRows() {
    const url = window.NPS_CONFIG && window.NPS_CONFIG.ZENDESK_CSV_URL;
    if (url) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (res.ok) return { rows: parseCSV(await res.text()), fromRemote: true };
      } catch (e) {
        console.warn("Falha ao buscar a planilha do Zendesk, usando o modelo local.", e);
      }
    }
    const res = await fetch("data/zendesk_semanal_template.csv", { cache: "no-store" });
    return { rows: parseCSV(await res.text()), fromRemote: false };
  }

  function renderUpdatedBadge(data) {
    const badge = document.getElementById("updated-text");
    const footer = document.getElementById("footer-updated");
    try {
      const d = new Date(data.generated_at);
      const txt = "Atualizado em " + d.toLocaleDateString("pt-BR") + " às " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      badge.textContent = txt;
      footer.textContent = txt;
    } catch (e) {
      badge.textContent = "Data indisponível";
    }
  }

  function populateMonthSelect(data) {
    const select = document.getElementById("month-select");
    select.innerHTML = "";
    data.historico_nps.forEach(h => {
      const opt = el("option");
      opt.value = h.mes;
      opt.textContent = h.label;
      if (h.mes === data.current_month) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener("change", () => {
      if (select.value !== data.current_month) {
        alert("O detalhamento completo (perguntas, especialidades, Zendesk) está disponível apenas para o mês vigente (" + data.current_month + "). O histórico de NPS por mês pode ser visto no gráfico \"Histórico do NPS\".");
        select.value = data.current_month;
      }
    });
  }

  function renderKpis(data) {
    document.getElementById("kpi-nps").textContent = fmt(data.kpi.nps_geral, 1);
    document.getElementById("kpi-total").textContent = data.kpi.total_respostas;

    const trendEl = document.getElementById("kpi-nps-trend");
    if (typeof data.kpi.nps_geral_variacao_pct === "number") {
      const up = data.kpi.nps_geral_variacao_pct >= 0;
      trendEl.className = "kpi-trend " + (up ? "up" : "down");
      trendEl.textContent = (up ? "↑ " : "↓ ") + fmt(Math.abs(data.kpi.nps_geral_variacao_pct), 1) + "% vs. mês anterior";
    } else {
      trendEl.textContent = "";
    }

    const total = data.kpi.promotores + data.kpi.neutros + data.kpi.detratores;
    const distBar = document.getElementById("dist-bar");
    distBar.innerHTML = "";
    [
      ["dist-promotores", data.kpi.promotores],
      ["dist-neutros", data.kpi.neutros],
      ["dist-detratores", data.kpi.detratores]
    ].forEach(([cls, val]) => {
      const span = el("span", cls);
      span.style.width = (total ? (val / total * 100) : 0) + "%";
      distBar.appendChild(span);
    });
    document.getElementById("dist-promotores").textContent = data.kpi.promotores;
    document.getElementById("dist-neutros").textContent = data.kpi.neutros;
    document.getElementById("dist-detratores").textContent = data.kpi.detratores;
  }

  function renderPerguntasChart(data) {
    const ctx = document.getElementById("chart-perguntas");
    const items = [...data.media_por_pergunta].sort((a, b) => b.media - a.media);
    new Chart(ctx, {
      type: "bar",
      data: {
        labels: items.map(i => i.pergunta),
        datasets: [{
          data: items.map(i => i.media),
          backgroundColor: CHART_COLORS.teal,
          borderRadius: 6,
          maxBarThickness: 28
        }]
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { min: 0, max: 5, grid: { color: CHART_COLORS.grayGrid } },
          y: { grid: { display: false } }
        }
      }
    });
  }

  function renderEspecialidadeChart(data) {
    const ctx = document.getElementById("chart-especialidade");
    const items = [...data.nps_por_especialidade].sort((a, b) => b.nps - a.nps);
    new Chart(ctx, {
      type: "bar",
      data: {
        labels: items.map(i => i.especialidade + " (" + fmt(i.pct_amostra, 1) + "%)"),
        datasets: [{
          data: items.map(i => i.nps),
          backgroundColor: CHART_COLORS.blue,
          borderRadius: 6,
          maxBarThickness: 22
        }]
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { min: 0, max: 100, grid: { color: CHART_COLORS.grayGrid } },
          y: { grid: { display: false } }
        }
      }
    });
  }

  function renderHistoricoChart(data, zendeskRows) {
    const ctx = document.getElementById("chart-historico");
    const labels = data.historico_nps.map(h => h.label);
    const npsSeries = data.historico_nps.map(h => h.nps);

    const csatByMonth = {};
    zendeskRows.filter(r => (num(r.semana) ?? 0) === 0).forEach(r => { csatByMonth[r.mes] = num(r.csat_humano); });
    const csatSeries = data.historico_nps.map(h => csatByMonth[h.mes] ?? null);

    new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "NPS",
            data: npsSeries,
            borderColor: CHART_COLORS.blue,
            backgroundColor: CHART_COLORS.blueSoft,
            fill: true,
            tension: 0.3,
            yAxisID: "y",
            pointRadius: 4
          },
          {
            label: "CSAT Humano (Zendesk)",
            data: csatSeries,
            borderColor: CHART_COLORS.pink,
            borderDash: [6, 4],
            backgroundColor: "transparent",
            tension: 0.3,
            yAxisID: "y1",
            pointRadius: 3
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom", labels: { boxWidth: 10 } } },
        scales: {
          y: { min: 0, max: 100, grid: { color: CHART_COLORS.grayGrid }, title: { display: true, text: "NPS" } },
          y1: { min: 0, max: 5, position: "right", grid: { display: false }, title: { display: true, text: "CSAT (0-5)" } }
        }
      }
    });
  }

  function renderSatisfacaoTable(data) {
    const tbody = document.querySelector("#table-satisfacao tbody");
    tbody.innerHTML = "";
    const cols = ["app_isa_atende", "comunicacao", "experiencia_geral", "gestao_escalas", "pontualidade_pagamento", "suporte_chat"];
    [...data.satisfacao_por_especialidade].sort((a, b) => b.experiencia_geral - a.experiencia_geral).forEach(row => {
      const tr = el("tr");
      tr.appendChild(el("td", "cell-strong", row.especialidade + " <span style='color:var(--gray-body);font-weight:400;'>(" + row.n + ")</span>"));
      cols.forEach(c => {
        const v = row[c];
        const td = el("td");
        td.innerHTML = "<span class='badge " + scoreBadgeClass(v) + "'>" + fmt(v, 2) + "</span>";
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  }

  function renderZendeskMensalTable(zendeskRows) {
    const tbody = document.querySelector("#table-zendesk-mensal tbody");
    tbody.innerHTML = "";
    zendeskRows
      .filter(r => (num(r.semana) ?? 0) === 0)
      .sort((a, b) => a.mes.localeCompare(b.mes))
      .forEach(r => {
        const tr = el("tr");
        tr.appendChild(el("td", "cell-strong", r.mes_label || r.mes));
        tr.appendChild(el("td", null, fmt(num(r.csat_ia), 2)));
        tr.appendChild(el("td", null, fmt(num(r.csat_humano), 2)));
        tr.appendChild(el("td", null, r.tma_primeira_resposta || "—"));
        tr.appendChild(el("td", null, r.tmr || "—"));
        tr.appendChild(el("td", null, r.fcr_pct ? fmt(num(r.fcr_pct), 1) + "%" : "—"));
        tr.appendChild(el("td", null, r.resolucao_ia_pct ? fmt(num(r.resolucao_ia_pct), 0) + "%" : "—"));
        tbody.appendChild(tr);
      });
  }

  function currentMonthWeeklyRows(zendeskRows, currentMonth) {
    return zendeskRows
      .filter(r => r.mes === currentMonth && (num(r.semana) ?? 0) > 0)
      .sort((a, b) => num(a.semana) - num(b.semana));
  }

  function renderZendeskSemanalTable(zendeskRows, currentMonth) {
    const tbody = document.querySelector("#table-zendesk-semanal tbody");
    tbody.innerHTML = "";
    currentMonthWeeklyRows(zendeskRows, currentMonth).forEach(r => {
      const tr = el("tr");
      tr.appendChild(el("td", "cell-strong", "Semana " + r.semana));
      tr.appendChild(el("td", null, r.periodo || "—"));
      tr.appendChild(el("td", null, fmt(num(r.csat_ia), 2)));
      tr.appendChild(el("td", null, fmt(num(r.csat_humano), 2)));
      tr.appendChild(el("td", null, r.tma_primeira_resposta || "—"));
      tr.appendChild(el("td", null, r.tmr || "—"));
      tr.appendChild(el("td", null, r.fcr_pct ? fmt(num(r.fcr_pct), 1) + "%" : "—"));
      tbody.appendChild(tr);
    });
  }

  function renderTimeline(zendeskRows, currentMonth) {
    const container = document.getElementById("timeline");
    container.innerHTML = "";
    const weeks = currentMonthWeeklyRows(zendeskRows, currentMonth).filter(r => r.narrativa);
    if (!weeks.length) {
      container.appendChild(el("p", "skeleton", "Nenhuma narrativa cadastrada para este mês ainda."));
      return;
    }
    weeks.forEach(r => {
      const item = el("div", "timeline-item");
      const left = el("div");
      left.appendChild(el("div", "timeline-week", "Semana " + r.semana));
      left.appendChild(el("div", "timeline-period", r.periodo || ""));
      const right = el("div");
      right.appendChild(el("div", "timeline-text", r.narrativa));
      const chips = el("div", "timeline-metrics");
      if (r.fcr_pct) chips.appendChild(el("span", "metric-chip", "FCR <b>" + fmt(num(r.fcr_pct), 1) + "%</b>"));
      if (r.tmr) chips.appendChild(el("span", "metric-chip", "TMR <b>" + r.tmr + "</b>"));
      if (r.resolucao_ia_pct) chips.appendChild(el("span", "metric-chip", "Resolução IA <b>" + fmt(num(r.resolucao_ia_pct), 0) + "%</b>"));
      right.appendChild(chips);
      item.appendChild(left);
      item.appendChild(right);
      container.appendChild(item);
    });
  }

  async function init() {
    const [data, zendesk] = await Promise.all([loadNpsData(), loadZendeskRows()]);

    if (!zendesk.fromRemote) {
      document.getElementById("stale-alert").style.display = "flex";
    }

    renderUpdatedBadge(data);
    populateMonthSelect(data);
    renderKpis(data);
    renderPerguntasChart(data);
    renderEspecialidadeChart(data);
    renderHistoricoChart(data, zendesk.rows);
    renderSatisfacaoTable(data);
    renderZendeskMensalTable(zendesk.rows);
    renderZendeskSemanalTable(zendesk.rows, data.current_month);
    renderTimeline(zendesk.rows, data.current_month);

    if (window.lucide) window.lucide.createIcons();
  }

  init().catch(err => {
    console.error(err);
    document.body.insertAdjacentHTML("afterbegin", "<div class='alert alert-warning' style='margin:16px;'>Erro ao carregar os dados do painel. Veja o console para detalhes.</div>");
  });
})();
