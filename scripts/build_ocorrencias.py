# -*- coding: utf-8 -*-
"""Transforma o export de ocorrências do Metabase em data/ocorrencias.json.

De onde vem o CSV
-----------------
De scripts/fetch_metabase.py, que monta a consulta em MBQL e chama o
/api/dataset/csv do Metabase. Uma linha por ocorrência da Comunidade, com
departamento, tipo, status, abertura (CreatedAt) e encerramento (UpdatedAt).

    py scripts/build_ocorrencias.py "<caminho do csv exportado>"

Status
------
Vêm todos: Finalizado, Criado, Em Progresso e Cancelado. "Em aberto" é
Criado + Em Progresso — o que ainda consome fila.

O SLA só é calculado sobre as finalizadas, porque só nelas o UpdatedAt marca
de fato o encerramento. Numa ocorrência aberta esse campo é a última mexida,
que não quer dizer nada como tempo de resolução.
"""

import csv
import io
import json
import os
import statistics
import sys
from datetime import datetime, timedelta, timezone

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAIDA = os.path.join(RAIZ, "data", "ocorrencias.json")

# A área é "Comunidade". Captação é uma frente própria e o painel não a cobre.
PREFIXOS = ("Comunidade", "Treinamento")
EXCLUIR = ("capta",)

MESES_PT = {1: "Janeiro", 2: "Fevereiro", 3: "Março", 4: "Abril", 5: "Maio", 6: "Junho",
            7: "Julho", 8: "Agosto", 9: "Setembro", 10: "Outubro", 11: "Novembro", 12: "Dezembro"}


def ler(caminho):
    csv.field_size_limit(10 ** 7)
    with io.open(caminho, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def momento(txt):
    return datetime.strptime(txt[:19], "%Y-%m-%dT%H:%M:%S") if txt else None


def da_comunidade(dep):
    d = (dep or "").strip()
    return d.startswith(PREFIXOS) and not any(x in d.lower() for x in EXCLUIR)


ABERTOS = ("criado", "em progresso")


def resumo(itens):
    """Contagem por status e SLA do recorte.

    Mediana ao lado da média de propósito: uma ocorrência parada 18 dias puxa a
    média e some na mediana."""
    finalizadas = [i for i in itens if i["status"] == "Finalizado"]
    horas = sorted(i["horas"] for i in finalizadas if i["horas"] is not None)
    dados = {
        "total": len(itens),
        "finalizadas": len(finalizadas),
        "em_aberto": len([i for i in itens if i["status"].lower() in ABERTOS]),
        "canceladas": len([i for i in itens if i["status"] == "Cancelado"]),
    }
    if horas:
        dados["sla_medio_h"] = round(statistics.mean(horas), 1)
        dados["sla_mediano_h"] = round(statistics.median(horas), 1)
        dados["sla_medio_dias"] = round(statistics.mean(horas) / 24, 1)
        dados["sla_mediano_dias"] = round(statistics.median(horas) / 24, 1)
        dados["sla_max_h"] = round(horas[-1], 1)
    return dados


def por_chave(itens, chave):
    saida = {}
    for i in itens:
        saida.setdefault(i[chave], []).append(i)
    return {k: resumo(v) for k, v in sorted(saida.items(), key=lambda x: -len(x[1]))}


def main():
    if len(sys.argv) < 2:
        sys.exit("uso: py scripts/build_ocorrencias.py <export.csv>")

    brutos = ler(sys.argv[1])
    itens = []
    for l in brutos:
        if not da_comunidade(l.get("Department: Description")):
            continue
        abriu = momento(l.get("CreatedAt"))
        if not abriu:
            continue
        status = (l.get("Status: Description") or "—").strip()
        fechou = momento(l.get("UpdatedAt"))
        # so a finalizada tem tempo de resolucao; nas outras o UpdatedAt e
        # apenas a ultima mexida no ticket
        horas = None
        if status == "Finalizado" and fechou and fechou >= abriu:
            horas = (fechou - abriu).total_seconds() / 3600.0
        itens.append({
            "departamento": l["Department: Description"].strip(),
            "tipo": (l.get("Type: Description") or "—").strip(),
            "status": status,
            "mes": abriu.strftime("%Y-%m"),
            "inicio_semana": (abriu - timedelta(days=abriu.weekday())).strftime("%Y-%m-%d"),
            "horas": horas,
        })

    meses = {}
    for i in itens:
        meses.setdefault(i["mes"], []).append(i)

    saida_meses = {}
    for mes, doMes in sorted(meses.items()):
        semanas = {}
        for i in doMes:
            semanas.setdefault(i["inicio_semana"], []).append(i)
        saida_meses[mes] = dict(
            resumo(doMes),
            label=MESES_PT[int(mes[5:7])],
            por_departamento=por_chave(doMes, "departamento"),
            por_tipo=por_chave(doMes, "tipo"),
            semanas=[
                dict(resumo(v), inicio=k,
                     label=datetime.strptime(k, "%Y-%m-%d").strftime("%d/%m"))
                for k, v in sorted(semanas.items())
            ],
        )

    payload = {
        "gerado_em": datetime.now(timezone.utc).isoformat(),
        "fonte": "Metabase · consulta própria sobre a coleção tickets (report.isalab.com.br)",
        "recorte": "Departamentos da Comunidade, exceto Captação",
        "somente_finalizadas": False,
        "observacao": ("Todos os status entram na contagem. O SLA é calculado só "
                       "sobre as finalizadas, porque só nelas o encerramento é real."),
        "meses": saida_meses,
    }
    with io.open(SAIDA, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print("OK: %d ocorrências em %d meses -> %s" % (len(itens), len(saida_meses), SAIDA))


if __name__ == "__main__":
    main()
