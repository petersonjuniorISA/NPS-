# -*- coding: utf-8 -*-
"""Le a exportacao do Zendesk Explore e preenche data/zendesk_semanal.csv.

Por que existe
--------------
Os tickets do suporte nao chegam por API: gerar um token exige papel de admin,
e a conta do painel entra por SSO, entao nao ha senha local para a API usar.
O Explore, porem, qualquer agente abre — e a exportacao dele traz por semana do
ano exatamente os tres numeros que se digitava a mao toda segunda.

    py scripts/importar_explore.py                 # pega o .zip mais novo do Downloads
    py scripts/importar_explore.py caminho.zip     # ou um arquivo especifico
    py scripts/importar_explore.py --simular       # mostra o que faria, sem gravar

O que le
--------
A planilha "TMA - TMR - FCR - Semana", com estas colunas:

    Criacao do ticket - Mes
    Criacao do ticket - Semana do ano
    Tempo da primeira resposta (h)     -> tma_primeira_resposta
    Tempo total de resolucao (h)       -> tmr
    % de tickets resolvidos em um contato -> fcr_pct

O que NAO le, e continua a mao
------------------------------
CSAT humano, CSAT IA, resolucao com IA e a contagem humano x IA. Esses nao
estao nesta aba do Explore. As colunas deles sao preservadas linha a linha:
o importador so encosta nas tres que sabe preencher.

A semana partida no fim do mes
------------------------------
Agrupado por mes E por semana, o Explore quebra em duas linhas a semana que
cruza a virada — a 31 aparece como Julho e como Agosto. Sao duas medias
parciais, e media de media sem peso e conta errada.

Aqui a semana fica com a linha do mes que contem a segunda-feira que a abre, e
o pedaco do outro mes e descartado com aviso. Para nao perder nada, tire o
agrupamento por "Mes" no Explore e deixe so "Semana do ano": cada semana passa
a vir uma vez so, com a media do periodo inteiro.
"""
import argparse
import csv
import glob
import io
import os
import sys
import zipfile
from datetime import date

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.dirname(AQUI)
DESTINO = os.path.join(RAIZ, "data", "zendesk_semanal.csv")
DOWNLOADS = os.path.join(os.path.expanduser("~"), "Downloads")
# onde o Apps Script larga a exportacao que chegou por e-mail. Fica versionada
# de proposito: a atualizacao semanal a encontra depois de um git pull, sem
# depender de nada sincronizado na maquina.
ENTRADA = os.path.join(RAIZ, "data", "explore")
PLANILHA = "TMA - TMR - FCR - Semana"

MESES = {"janeiro": 1, "fevereiro": 2, "março": 3, "marco": 3, "abril": 4,
         "maio": 5, "junho": 6, "julho": 7, "agosto": 8, "setembro": 9,
         "outubro": 10, "novembro": 11, "dezembro": 12}
NOME_MES = {v: k.capitalize() for k, v in MESES.items() if len(k) > 4 or k == "maio"}
NOME_MES[3] = "Março"


# ------------------------------------------------------------------ leitura ---
def achar_arquivo(dado):
    """O caminho passado; senao o que o e-mail trouxe; senao o do Downloads.

    A ordem importa: data/explore/ e o que chega sozinho pelo Apps Script toda
    semana, e tem de ganhar do arquivo que alguem baixou a mao meses atras e
    esqueceu na pasta de Downloads."""
    if dado:
        return dado
    for pasta, padroes in ((ENTRADA, ("*.csv", "*.zip")),
                           (DOWNLOADS, ("*Tempo-de-resolu*.zip", "*TMA*TMR*FCR*.csv"))):
        achados = []
        for p in padroes:
            achados += glob.glob(os.path.join(pasta, p))
        if achados:
            return max(achados, key=os.path.getmtime)
    raise SystemExit(
        "ERRO: nao achei exportacao do Explore em %s nem em %s.\n"
        "      Baixe o dashboard e rode de novo, ou passe o caminho do arquivo."
        % (os.path.relpath(ENTRADA, RAIZ), DOWNLOADS))


def texto_do_csv(bruto):
    """A exportacao vem com BOM; as vezes em UTF-16. Tenta o provavel primeiro."""
    for cod in ("utf-8-sig", "utf-16", "latin-1"):
        try:
            txt = bruto.decode(cod)
        except (UnicodeDecodeError, UnicodeError):
            continue
        # UTF-8 lido como latin-1 nao falha, so fica errado; o NUL denuncia UTF-16
        if txt.count("\x00") > len(txt) // 4:
            continue
        return txt
    raise SystemExit("ERRO: nao consegui ler o arquivo em nenhuma codificacao conhecida.")


def linhas_da_exportacao(caminho):
    if caminho.lower().endswith(".zip"):
        with zipfile.ZipFile(caminho) as z:
            nomes = [n for n in z.namelist() if PLANILHA.lower() in n.lower()]
            if not nomes:
                raise SystemExit(
                    "ERRO: o .zip nao tem a planilha '%s'.\n"
                    "      Ele traz: %s" % (PLANILHA, ", ".join(z.namelist())))
            bruto = z.read(nomes[0])
    else:
        with open(caminho, "rb") as f:
            bruto = f.read()
    return list(csv.DictReader(io.StringIO(texto_do_csv(bruto))))


def coluna(linha, *pedacos):
    """Acha a coluna pelo que o nome contem — o Explore muda acento e sufixo."""
    for chave in linha:
        k = (chave or "").lower()
        if all(p in k for p in pedacos):
            return linha[chave]
    return None


# --------------------------------------------------------------- conversoes ---
def horas_para_texto(h):
    """3.25 vira "3h15". O painel le esse formato em minutosDeTempo()."""
    if h is None:
        return ""
    total = int(round(float(h) * 60))
    horas, minutos = divmod(total, 60)
    return "%dh" % horas if minutos == 0 else "%dh%02d" % (horas, minutos)


def numero(txt):
    if txt is None or str(txt).strip() == "":
        return None
    try:
        return float(str(txt).strip().replace(",", "."))
    except ValueError:
        return None


def segunda_da_semana(ano, semana):
    """A segunda-feira que abre a semana ISO — a mesma regra do eixo do painel."""
    return date.fromisocalendar(ano, semana, 1)


def semana_no_mes(dia):
    """Qual segunda-feira do mes e esta: 1 para a primeira, 2 para a segunda..."""
    return (dia.day - 1) // 7 + 1


def periodo(inicio):
    """"3 a 9 de agosto", como as linhas ja escritas a mao."""
    fim = date.fromordinal(inicio.toordinal() + 6)
    mes_fim = NOME_MES[fim.month].lower()
    if inicio.month == fim.month:
        return "%d a %d de %s" % (inicio.day, fim.day, mes_fim)
    return "%d de %s a %d de %s" % (inicio.day, NOME_MES[inicio.month].lower(),
                                    fim.day, mes_fim)


# ------------------------------------------------------------------- juntar ---
def semanas_da_exportacao(linhas, ano):
    """Uma entrada por semana do ano, resolvendo a semana partida no fim do mes."""
    por_semana, descartadas = {}, []
    for ln in linhas:
        n = numero(coluna(ln, "semana"))
        rotulo = (coluna(ln, "mês") or coluna(ln, "mes") or "").strip().lower()
        if n is None or rotulo not in MESES:
            continue
        semana = int(n)
        inicio = segunda_da_semana(ano, semana)
        # a linha que vale e a do mes onde a semana comeca
        if inicio.month != MESES[rotulo]:
            descartadas.append((semana, rotulo.capitalize()))
            continue
        por_semana[semana] = {
            "inicio": inicio,
            "tma": horas_para_texto(numero(coluna(ln, "primeira", "resposta"))),
            "tmr": horas_para_texto(numero(coluna(ln, "resolu", "(h)"))),
            "fcr": numero(coluna(ln, "um contato")),
        }
    return por_semana, descartadas


def aplicar(por_semana):
    """Escreve so as tres colunas conhecidas; o resto da linha fica como esta."""
    with io.open(DESTINO, encoding="utf-8", newline="") as f:
        campos = csv.DictReader(f).fieldnames
        f.seek(0)
        atuais = list(csv.DictReader(f))

    porta = {ln["inicio"]: ln for ln in atuais if ln.get("inicio")}
    novas, mudadas = [], []

    for semana in sorted(por_semana):
        d = por_semana[semana]
        iso = d["inicio"].isoformat()
        linha = porta.get(iso)
        if linha is None:
            linha = {c: "" for c in campos}
            linha.update({
                "mes": "%04d-%02d" % (d["inicio"].year, d["inicio"].month),
                "mes_label": NOME_MES[d["inicio"].month],
                "semana": str(semana_no_mes(d["inicio"])),
                "periodo": periodo(d["inicio"]),
                "inicio": iso,
            })
            atuais.append(linha)
            novas.append((semana, iso))
        antes = (linha.get("tma_primeira_resposta"), linha.get("tmr"), linha.get("fcr_pct"))
        linha["tma_primeira_resposta"] = d["tma"]
        linha["tmr"] = d["tmr"]
        linha["fcr_pct"] = "" if d["fcr"] is None else ("%.1f" % (d["fcr"] * 100))
        depois = (linha["tma_primeira_resposta"], linha["tmr"], linha["fcr_pct"])
        if antes != depois and not novas or (antes != depois and (semana, iso) not in novas):
            mudadas.append((iso, antes, depois))

    # mensal primeiro, depois as semanas, na ordem do calendario
    atuais.sort(key=lambda l: (l.get("mes") or "", int(l.get("semana") or 0)))
    return campos, atuais, novas, mudadas


def gravar(campos, linhas):
    with io.open(DESTINO, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=campos)
        w.writeheader()
        for ln in linhas:
            w.writerow({c: ln.get(c, "") for c in campos})


# --------------------------------------------------------------------- main ---
def main():
    p = argparse.ArgumentParser(description="Importa a exportacao do Zendesk Explore.")
    p.add_argument("arquivo", nargs="?", help="o .zip ou .csv exportado (padrao: o mais novo em Downloads)")
    p.add_argument("--ano", type=int, default=date.today().year,
                   help="ano das semanas exportadas (padrao: o corrente)")
    p.add_argument("--simular", action="store_true", help="mostra o que faria, sem gravar")
    args = p.parse_args()

    caminho = achar_arquivo(args.arquivo)
    print("Lendo %s" % os.path.basename(caminho))
    linhas = linhas_da_exportacao(caminho)
    if not linhas:
        raise SystemExit("ERRO: a planilha veio vazia.")

    por_semana, descartadas = semanas_da_exportacao(linhas, args.ano)
    if not por_semana:
        raise SystemExit(
            "ERRO: nenhuma linha reconhecida. Confira se a exportacao tem as colunas\n"
            "      'Semana do ano', 'Tempo da primeira resposta (h)', 'Tempo total de\n"
            "      resolucao (h)' e '%% de tickets resolvidos em um contato'.")

    campos, atuais, novas, mudadas = aplicar(por_semana)

    print()
    print("%d semanas lidas (%s a %s)" % (
        len(por_semana),
        min(por_semana.values(), key=lambda d: d["inicio"])["inicio"],
        max(por_semana.values(), key=lambda d: d["inicio"])["inicio"]))
    for semana in sorted(por_semana):
        d = por_semana[semana]
        print("   semana %-3d %s   TMA %-7s TMR %-7s FCR %s" % (
            semana, d["inicio"], d["tma"], d["tmr"],
            "—" if d["fcr"] is None else "%.1f%%" % (d["fcr"] * 100)))
    if novas:
        print()
        print("linhas novas: %s" % ", ".join("semana %d (%s)" % n for n in novas))
    if descartadas:
        print()
        print("pedacos descartados (semana partida na virada do mes):")
        for semana, mes in descartadas:
            print("   semana %d, parte de %s" % (semana, mes))
        print("   Para nao perder esses dias, tire o agrupamento por 'Mes' no Explore")
        print("   e deixe so 'Semana do ano'.")

    if args.simular:
        print()
        print("--simular: nada foi gravado.")
        return 0

    gravar(campos, atuais)
    print()
    print("OK: %s atualizado." % os.path.relpath(DESTINO, RAIZ))
    print("    CSAT, resolucao com IA e a contagem humano x IA nao vem desta aba")
    print("    do Explore — essas colunas ficaram como estavam.")
    print()
    print("Agora: py scripts/build_appscript.py  e republique no Apps Script.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
