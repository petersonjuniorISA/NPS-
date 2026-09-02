"""Busca as respostas de NPS no Databricks e gera data/nps.json.

Executado automaticamente pelo workflow .github/workflows/update-nps-data.yml
(toda semana), mas também pode ser rodado manualmente:

    pip install -r requirements.txt
    export DATABRICKS_HOST=dbc-xxxxxxxx-xxxx.cloud.databricks.com
    export DATABRICKS_HTTP_PATH=/sql/1.0/warehouses/xxxxxxxxxxxxxxxx
    export DATABRICKS_TOKEN=dapiXXXXXXXXXXXXXXXXXXXXXXXXXXXX
    export DATABRICKS_TABLE=catalogo.esquema.tabela
    python scripts/fetch_databricks.py

Onde encontrar cada variável:
- DATABRICKS_HOST / DATABRICKS_HTTP_PATH: no Databricks, vá em
  "SQL Warehouses" > escolha o warehouse > aba "Connection details".
- DATABRICKS_TOKEN: no Databricks, "User Settings" > "Developer" >
  "Access tokens" > "Generate new token".
- DATABRICKS_TABLE: nome completo (catalog.schema.tabela) da tabela que
  alimenta o dashboard "NPS ISAs" — peça ao time de dados se não souber.
"""

import json
import os
from datetime import datetime, timezone

import pandas as pd
from databricks import sql

DATABRICKS_HOST = os.environ["DATABRICKS_HOST"]
DATABRICKS_HTTP_PATH = os.environ["DATABRICKS_HTTP_PATH"]
DATABRICKS_TOKEN = os.environ["DATABRICKS_TOKEN"]
DATABRICKS_TABLE = os.environ["DATABRICKS_TABLE"]

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


def fetch_dataframe() -> pd.DataFrame:
    with sql.connect(
        server_hostname=DATABRICKS_HOST,
        http_path=DATABRICKS_HTTP_PATH,
        access_token=DATABRICKS_TOKEN,
    ) as conn:
        with conn.cursor() as cursor:
            cursor.execute(f"SELECT * FROM {DATABRICKS_TABLE}")
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


def build_payload(df: pd.DataFrame) -> dict:
    df = df.copy()
    df["reference_month"] = pd.to_datetime(df["reference_month"]).dt.to_period("M")

    months_sorted = sorted(df["reference_month"].dropna().unique())
    current_month_period = months_sorted[-1]
    current_month = str(current_month_period)
    cur = df[df["reference_month"] == current_month_period]

    promotores, neutros, detratores = bucket_counts(cur)
    total_respostas = len(cur)
    nps_geral = nps_from_bucket_counts(promotores, neutros, detratores)

    variacao_pct = None
    if len(months_sorted) >= 2:
        prev = df[df["reference_month"] == months_sorted[-2]]
        prev_nps = nps_from_bucket_counts(*bucket_counts(prev))
        if prev_nps:
            variacao_pct = round((nps_geral - prev_nps) / abs(prev_nps) * 100, 1)

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

    historico_nps = []
    for mes, grupo in df.groupby("reference_month"):
        if pd.isna(mes):
            continue
        historico_nps.append({
            "mes": str(mes),
            "label": MONTH_LABELS_PT[mes.to_timestamp().month],
            "nps": nps_from_bucket_counts(*bucket_counts(grupo)),
        })
    historico_nps.sort(key=lambda x: x["mes"])

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "databricks",
        "current_month": current_month,
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
        "historico_nps": historico_nps,
    }


def main():
    df = fetch_dataframe()
    payload = build_payload(df)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"OK: {payload['kpi']['total_respostas']} respostas em {payload['current_month']} escritas em {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
