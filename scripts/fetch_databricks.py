"""Busca as respostas de NPS no Databricks e gera data/nps.json.

Executado automaticamente toda semana pelo Agendador de Tarefas do Windows
(veja scripts/weekly_update.ps1), usando o login OAuth salvo localmente
(rode `databricks auth login --host https://dbc-0fbb1123-410c.cloud.databricks.com`
uma vez, na máquina que vai rodar a tarefa agendada).

Também pode ser rodado manualmente:

    pip install -r requirements.txt
    python scripts/fetch_databricks.py

HOST, HTTP_PATH e TABLE já vêm com valor padrão (o warehouse e a tabela do
dashboard "NPS ISAs"). Só é preciso definir variáveis de ambiente se algo
mudar:
    DATABRICKS_HOST, DATABRICKS_HTTP_PATH, DATABRICKS_TABLE

Se a variável DATABRICKS_TOKEN estiver definida, o script usa um Personal
Access Token (ex.: no GitHub Actions) em vez do login OAuth local — útil se
no futuro o time de dados liberar tokens e a automação for movida pra nuvem.
"""

import json
import os
import shutil
from datetime import datetime, timezone

import pandas as pd
from databricks import sql

DATABRICKS_HOST = os.environ.get("DATABRICKS_HOST", "dbc-0fbb1123-410c.cloud.databricks.com")
DATABRICKS_HTTP_PATH = os.environ.get("DATABRICKS_HTTP_PATH", "/sql/1.0/warehouses/8cd8e339bbea1ffd")
DATABRICKS_TOKEN = os.environ.get("DATABRICKS_TOKEN")  # se ausente, usa login OAuth (databricks auth login)
DATABRICKS_TABLE = os.environ.get("DATABRICKS_TABLE", "isa_experience_dev.gold.fact_inps_response")

OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "nps.json")

SCORE_COLUMNS = {
    "app_isa_atende": "score_app_isa_atende",
    "comunicacao": "score_comunicacao",
    "experiencia_geral": "score_experiencia_geral",
    "gestao_escalas": "score_gestao_escalas",
    "pontualidade_pagamento": "score_pontualidade_pagamento",
    "suporte_chat": "score_suporte_chat",
}

QUESTION_LABELS = {
    "score_pontualidade_pagamento": "Pontualidade Pagamento",
    "score_gestao_escalas": "Gestão de Escalas",
    "score_experiencia_geral": "Experiência Geral",
    "score_app_isa_atende": "App Isa Atende",
    "score_comunicacao": "Comunicação",
    "score_suporte_chat": "Suporte Chat",
}

MONTH_LABELS_PT = {
    1: "Janeiro", 2: "Fevereiro", 3: "Março", 4: "Abril",
    5: "Maio", 6: "Junho", 7: "Julho", 8: "Agosto",
    9: "Setembro", 10: "Outubro", 11: "Novembro", 12: "Dezembro",
}


CLI_DIR_WINGET = os.path.join(
    os.environ.get("LOCALAPPDATA", ""),
    "Microsoft", "WinGet", "Packages",
    "Databricks.DatabricksCLI_Microsoft.Winget.Source_8wekyb3d8bbwe",
)


def garantir_cli_no_path() -> bool:
    """A CLI do Databricks guarda o token OAuth com refresh automático.

    O PATH nem sempre chega até aqui (shell aberto antes da instalação, por
    exemplo), então procuramos a instalação do winget antes de desistir.
    """
    if shutil.which("databricks"):
        return True
    if os.path.exists(os.path.join(CLI_DIR_WINGET, "databricks.exe")):
        os.environ["PATH"] = CLI_DIR_WINGET + os.pathsep + os.environ.get("PATH", "")
        return True
    return False


def fetch_dataframe() -> pd.DataFrame:
    connect_kwargs = dict(server_hostname=DATABRICKS_HOST, http_path=DATABRICKS_HTTP_PATH)
    if DATABRICKS_TOKEN:
        connect_kwargs["access_token"] = DATABRICKS_TOKEN
    elif garantir_cli_no_path():
        # Reaproveita o login já feito (`databricks auth login`): a CLI guarda o
        # token no Gerenciador de Credenciais do Windows e o renova sozinha.
        # Precisa ir pelo Config do SDK — passar auth_type="databricks-cli"
        # direto pro connector não funciona: ele cai no fluxo de navegador e
        # trava esperando alguém clicar, que foi o que quebrou a automação.
        from databricks.sdk.core import Config
        cfg = Config(host="https://" + DATABRICKS_HOST, auth_type="databricks-cli")
        connect_kwargs["credentials_provider"] = lambda: cfg.authenticate
    else:
        # Sem a CLI, cada execução abre o navegador pedindo login — só serve
        # rodando à mão, nunca na tarefa agendada.
        print("AVISO: CLI do Databricks não encontrada. Vai abrir o navegador "
              "pedindo login; instale a CLI para a automação rodar sozinha.")
        connect_kwargs["auth_type"] = "databricks-oauth"

    with sql.connect(**connect_kwargs) as conn:
        with conn.cursor() as cursor:
            cursor.execute(f"SELECT * FROM {DATABRICKS_TABLE} WHERE is_answered")
            rows = cursor.fetchall()
            return pd.DataFrame([r.asDict() for r in rows])


def nps_from_bucket_counts(promotores: int, neutros: int, detratores: int) -> float:
    total = promotores + neutros + detratores
    if total == 0:
        return 0.0
    return round((promotores - detratores) / total * 100, 1)


def bucket_counts(frame: pd.DataFrame):
    bucket = frame["nps_bucket"].str.lower()
    return (
        int((bucket == "promotor").sum()),
        int((bucket == "neutro").sum()),
        int((bucket == "detrator").sum()),
    )


def resumo_do_mes(cur: pd.DataFrame, nps_mes_anterior=None) -> dict:
    """Calcula o bloco completo de indicadores de um único mês."""
    promotores, neutros, detratores = bucket_counts(cur)
    total_respostas = len(cur)
    nps_geral = nps_from_bucket_counts(promotores, neutros, detratores)

    variacao_pct = None
    if nps_mes_anterior:
        variacao_pct = round((nps_geral - nps_mes_anterior) / abs(nps_mes_anterior) * 100, 1)

    media_por_pergunta = sorted(
        (
            {"pergunta": label, "media": round(float(cur[col].dropna().mean()), 2)}
            for col, label in QUESTION_LABELS.items() if col in cur.columns
        ),
        key=lambda x: x["media"], reverse=True,
    )

    nps_por_especialidade = []
    satisfacao_por_especialidade = []
    for especialidade, grupo in cur.groupby("specialty_name"):
        if pd.isna(especialidade):
            continue
        p, n, d = bucket_counts(grupo)
        nps_por_especialidade.append({
            "especialidade": especialidade,
            "pct_amostra": round(len(grupo) / total_respostas * 100, 1) if total_respostas else 0,
            "nps": nps_from_bucket_counts(p, n, d),
        })
        row = {"especialidade": especialidade, "n": int(len(grupo))}
        for key, col in SCORE_COLUMNS.items():
            if col in grupo.columns:
                row[key] = round(float(grupo[col].dropna().mean()), 2)
        satisfacao_por_especialidade.append(row)

    nps_por_especialidade.sort(key=lambda x: x["nps"], reverse=True)
    satisfacao_por_especialidade.sort(key=lambda x: x.get("experiencia_geral", 0), reverse=True)

    return {
        "kpi": {
            "nps_geral": nps_geral,
            "nps_geral_variacao_pct": variacao_pct,
            "total_respostas": total_respostas,
            "promotores": promotores,
            "neutros": neutros,
            "detratores": detratores,
        },
        "media_por_pergunta": media_por_pergunta,
        "nps_por_especialidade": nps_por_especialidade,
        "satisfacao_por_especialidade": satisfacao_por_especialidade,
    }


def semanas_do_mes(cur: pd.DataFrame) -> list:
    """Quebra o mês em semanas (segunda a domingo) com o NPS de cada uma."""
    if "answered_at" not in cur.columns:
        return []
    frame = cur.dropna(subset=["answered_at"]).copy()
    if frame.empty:
        return []

    momento = pd.to_datetime(frame["answered_at"])
    if getattr(momento.dt, "tz", None) is not None:
        momento = momento.dt.tz_localize(None)
    frame["_semana"] = momento.dt.to_period("W-SUN")

    semanas = []
    for i, (periodo, grupo) in enumerate(sorted(frame.groupby("_semana"), key=lambda x: x[0]), start=1):
        p, n, d = bucket_counts(grupo)
        inicio, fim = periodo.start_time, periodo.end_time
        semanas.append({
            "semana": i,
            "inicio": inicio.strftime("%Y-%m-%d"),
            "fim": fim.strftime("%Y-%m-%d"),
            "label": f"{inicio.day}/{inicio.month} a {fim.day}/{fim.month}",
            "respostas": int(len(grupo)),
            "promotores": p,
            "neutros": n,
            "detratores": d,
            "nps": nps_from_bucket_counts(p, n, d),
        })
    return semanas


def build_payload(df: pd.DataFrame) -> dict:
    df = df.copy()
    df["reference_month"] = pd.to_datetime(df["reference_month"]).dt.to_period("M")

    months_sorted = sorted(df["reference_month"].dropna().unique())
    current_month = str(months_sorted[-1])

    # NPS de cada mês (usado no histórico e para calcular a variação mês a mês)
    nps_por_mes = {}
    for mes in months_sorted:
        nps_por_mes[str(mes)] = nps_from_bucket_counts(*bucket_counts(df[df["reference_month"] == mes]))

    historico_nps = [
        {"mes": str(mes), "label": MONTH_LABELS_PT[mes.to_timestamp().month], "nps": nps_por_mes[str(mes)]}
        for mes in months_sorted
    ]

    # Detalhamento completo de todos os meses, para o painel poder voltar no tempo
    meses = {}
    semanas = {}
    for i, mes in enumerate(months_sorted):
        chave = str(mes)
        anterior = nps_por_mes[str(months_sorted[i - 1])] if i > 0 else None
        recorte = df[df["reference_month"] == mes]
        meses[chave] = resumo_do_mes(recorte, anterior)
        semanas[chave] = semanas_do_mes(recorte)

    atual = meses[current_month]
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "databricks",
        "current_month": current_month,
        "historico_nps": historico_nps,
        "meses": meses,
        "semanas": semanas,
        # Campos do mês corrente também no topo, para compatibilidade
        "kpi": atual["kpi"],
        "media_por_pergunta": atual["media_por_pergunta"],
        "nps_por_especialidade": atual["nps_por_especialidade"],
        "satisfacao_por_especialidade": atual["satisfacao_por_especialidade"],
    }


def main():
    df = fetch_dataframe()
    payload = build_payload(df)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"OK: {payload['kpi']['total_respostas']} respostas em {payload['current_month']} escritas em {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
