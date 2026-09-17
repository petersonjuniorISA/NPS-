# -*- coding: utf-8 -*-
"""Le a Aba padrao do Zendesk Explore e gera data/zendesk_explore.json.

O que ela tem, e o que nao tem
------------------------------
Esta aba traz volume total, CSAT geral e a contagem por categoria — mas tudo
como total do periodo filtrado, sem quebra por mes nem por semana. Nao da para
montar serie com isso, e fingir que da seria desenhar uma linha de um ponto so.

Entao o que sai daqui e um retrato: quantos tickets, de que assunto, naquela
janela. A "Distribuicao por assunto" da aba de tickets passa a mostrar isso em
barras, que e a forma honesta de desenhar um total.

Para virar serie, basta adicionar "Criacao do ticket - Semana do ano" em Linhas
nas consultas do Explore, como ja existe na aba "Tempo de resolucao". Quando
isso acontecer, este script avisa que achou a coluna e para — melhor recusar do
que jogar fora a quebra semanal em silencio.

    py scripts/importar_explore_assunto.py                  # o .zip mais novo
    py scripts/importar_explore_assunto.py caminho.zip
    py scripts/importar_explore_assunto.py --janela "últimos 30 dias"

O CSAT daqui nao e o do painel
------------------------------
No Explore o CSAT e "% de score de satisfacao" — a fatia de avaliacoes boas.
Na coluna csat_humano do CSV o numero e de 1 a 5, de outra pesquisa. Sao
medidas diferentes, entao esta guardado a parte, como `csat_pct`, e nenhuma das
duas e convertida na outra.

Dados por agente
----------------
A exportacao traz volume e CSAT por pessoa, com nome. Isso nao entra no JSON:
painel de diretoria com desempenho individual e decisao de gestao de pessoas,
nao de dados. Se um dia for para entrar, sera de proposito.
"""
import argparse
import csv
import datetime
import glob
import io
import json
import os
import sys
import zipfile

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.dirname(AQUI)
DESTINO = os.path.join(RAIZ, "data", "zendesk_explore.json")
ENTRADA = os.path.join(RAIZ, "data", "explore")
DOWNLOADS = os.path.join(os.path.expanduser("~"), "Downloads")


def achar(dado):
    if dado:
        return dado
    for pasta in (ENTRADA, DOWNLOADS):
        achados = glob.glob(os.path.join(pasta, "*Aba-padr*.zip"))
        if achados:
            return max(achados, key=os.path.getmtime)
    raise SystemExit(
        "ERRO: nao achei a exportacao da Aba padrao.\n"
        "      Baixe-a no Explore e rode de novo, ou passe o caminho do arquivo.")



def avisar_se_velho(caminho, dias=10):
    """Exportacao parada e o modo silencioso de o painel envelhecer.

    O importador reimporta o mesmo arquivo toda semana sem reclamar: a conta da
    certo, o script sai com zero, e o numero da tela continua o de duas semanas
    atras. O aviso e o que separa "rodou sem erro" de "o dado e desta semana".
    """
    idade = (datetime.datetime.now()
             - datetime.datetime.fromtimestamp(os.path.getmtime(caminho))).days
    if idade >= dias:
        print()
        print("AVISO: esta exportacao tem %d dias." % idade)
        print("       Os numeros abaixo sao os de %s — nao os de hoje."
              % datetime.date.fromtimestamp(os.path.getmtime(caminho)).strftime("%d/%m"))
    return idade

def texto(bruto):
    for cod in ("utf-8-sig", "utf-16", "latin-1"):
        try:
            t = bruto.decode(cod)
        except (UnicodeDecodeError, UnicodeError):
            continue
        if t.count("\x00") > len(t) // 4:
            continue
        return t
    raise SystemExit("ERRO: nao consegui ler o arquivo em nenhuma codificacao conhecida.")


def planilhas(caminho):
    """Cada CSV do .zip, pelo nome."""
    fora = {}
    with zipfile.ZipFile(caminho) as z:
        for nome in z.namelist():
            if not nome.lower().endswith(".csv"):
                continue
            linhas = list(csv.reader(io.StringIO(texto(z.read(nome)))))
            fora[os.path.splitext(os.path.basename(nome))[0]] = linhas
    return fora


def acha(folhas, *pedacos):
    for nome, linhas in folhas.items():
        n = nome.lower()
        if all(p in n for p in pedacos):
            return nome, linhas
    return None, None


def numero(txt):
    if txt is None or str(txt).strip() == "":
        return None
    try:
        return float(str(txt).strip().replace(",", "."))
    except ValueError:
        return None


def tem_quebra_de_tempo(linhas):
    """A consulta ganhou agrupamento por semana ou mes?"""
    cab = [c.lower() for c in (linhas[0] if linhas else [])]
    return any("semana" in c or "mês" in c or "mes" in c for c in cab)


def main():
    p = argparse.ArgumentParser(description="Importa a Aba padrao do Zendesk Explore.")
    p.add_argument("arquivo", nargs="?")
    p.add_argument("--janela", default="últimos 30 dias",
                   help="como descrever o periodo filtrado no Explore")
    p.add_argument("--simular", action="store_true")
    args = p.parse_args()

    caminho = achar(args.arquivo)
    print("Lendo %s" % os.path.basename(caminho))
    avisar_se_velho(caminho)
    folhas = planilhas(caminho)

    nome_cat, cat = acha(folhas, "categoria")
    if cat is None:
        raise SystemExit(
            "ERRO: o .zip nao tem a planilha de categoria.\n"
            "      Ele traz: %s" % ", ".join(folhas))

    if tem_quebra_de_tempo(cat):
        raise SystemExit(
            "A exportacao agora tem quebra por tempo — otimo, mas este script nao a usa.\n"
            "Ele guarda um total de periodo, e jogar fora a semana em silencio seria pior\n"
            "do que parar. Me avise para eu ligar a serie semanal no lugar do retrato.")

    por_categoria = {}
    for linha in cat[1:]:
        if len(linha) < 2:
            continue
        rotulo = (linha[0] or "").strip()
        n = numero(linha[1])
        if rotulo and rotulo != "—" and n:
            por_categoria[rotulo] = int(n)

    _, vol = acha(folhas, "volume")
    total = None
    if vol and len(vol) > 1:
        total = numero(vol[1][0]) if vol[1] else None
    if total is None:
        total = sum(por_categoria.values())

    _, csat = acha(folhas, "csat", "geral")
    csat_pct = None
    if csat and len(csat) > 1 and csat[1]:
        v = numero(csat[1][0])
        csat_pct = round(v * 100, 1) if v is not None else None

    saida = {
        "gerado_em": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "exportado_em": datetime.datetime.fromtimestamp(
            os.path.getmtime(caminho)).date().isoformat(),
        "janela": args.janela,
        "total": int(total),
        "csat_pct": csat_pct,
        "por_categoria": dict(sorted(por_categoria.items(), key=lambda x: -x[1])),
    }

    print()
    print("janela: %s (exportado em %s)" % (saida["janela"], saida["exportado_em"]))
    print("total: %d tickets" % saida["total"])
    print("CSAT geral: %s" % ("—" if csat_pct is None else "%.1f%%" % csat_pct))
    print("categorias (%d):" % len(por_categoria))
    for nome, n in saida["por_categoria"].items():
        print("   %-34s %6d  %5.1f%%" % (nome, n, 100.0 * n / saida["total"]))

    somado = sum(por_categoria.values())
    if somado != saida["total"]:
        print()
        print("AVISO: as categorias somam %d, e o volume total diz %d." % (somado, saida["total"]))
        print("       A diferenca sao tickets sem categoria; o painel mostra o total do card.")

    if args.simular:
        print()
        print("--simular: nada foi gravado.")
        return 0

    with io.open(DESTINO, "w", encoding="utf-8") as f:
        json.dump(saida, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print()
    print("OK: %s" % os.path.relpath(DESTINO, RAIZ))
    print("Agora: py scripts/build_appscript.py  e republique no Apps Script.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
