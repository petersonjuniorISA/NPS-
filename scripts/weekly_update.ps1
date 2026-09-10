# Atualiza data/nps.json (Databricks) e data/ocorrencias.json (Metabase) e sobe para o GitHub.
# Rodado automaticamente pelo Agendador de Tarefas do Windows (tarefa "NPS-ISAs-AtualizacaoSemanal"),
# toda sexta as 18h.
#
# Para rodar manualmente: powershell -File scripts\weekly_update.ps1

$ErrorActionPreference = "Stop"
$repoDir = Split-Path -Parent $PSScriptRoot
Set-Location $repoDir

$logDir = Join-Path $repoDir "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logFile = Join-Path $logDir ("weekly_update_{0}.log" -f (Get-Date -Format "yyyy-MM-dd_HHmmss"))

Start-Transcript -Path $logFile

# Achar o Python de verdade.
#
# Chamar "python" direto nao funciona aqui: o Windows instala um atalho para a
# Microsoft Store em WindowsApps que responde no lugar do interpretador, imprime
# "Python was not found" e devolve 9009. Foi o que derrubou a execucao de
# 04/09/2026. O "py" (Python Launcher) e o caminho confiavel.
function Resolve-Python {
    $candidatos = @()
    $py = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($py) { $candidatos += $py.Source }
    foreach ($c in (Get-Command python.exe -All -ErrorAction SilentlyContinue)) {
        # descarta o stub da Store
        if ($c.Source -notlike "*\WindowsApps\*") { $candidatos += $c.Source }
    }
    $candidatos += (Join-Path $env:LOCALAPPDATA "Python\pythoncore-3.14-64\python.exe")

    foreach ($exe in $candidatos) {
        if (-not (Test-Path $exe)) { continue }
        & $exe -c "import sys" 2>$null
        if ($LASTEXITCODE -eq 0) { return $exe }
    }
    return $null
}

try {
    $python = Resolve-Python
    if (-not $python) { throw "Nao achei um interpretador Python utilizavel (nem py.exe nem python.exe fora do WindowsApps)." }
    Write-Output "Python: $python"

    # A CLI do Databricks guarda o token OAuth e o renova sozinha. O PATH da
    # tarefa agendada nem sempre traz a pasta do winget.
    $cliDir = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages\Databricks.DatabricksCLI_Microsoft.Winget.Source_8wekyb3d8bbwe"
    if (Test-Path $cliDir) { $env:PATH = "$cliDir;$env:PATH" }

    # Uma fonte que falha nao deve impedir as outras de atualizar: um painel
    # com o Zendesk novo e o NPS da semana passada e melhor que nenhum painel.
    # As falhas sao guardadas e derrubam a tarefa no fim, para aparecerem no
    # Agendador em vez de passarem em branco.
    $falhas = @()

    Write-Output "== Buscando dados no Databricks =="
    & $python scripts\fetch_databricks.py
    if ($LASTEXITCODE -ne 0) {
        $falhas += "Databricks (codigo $LASTEXITCODE) - se for token expirado, rode: databricks auth login --host https://dbc-0fbb1123-410c.cloud.databricks.com"
        Write-Warning $falhas[-1]
    }

    Write-Output "== Buscando ocorrencias no Metabase =="
    # Sem chave de API o script avisa e sai com 0: a falta das ocorrencias nao
    # pode derrubar a atualizacao do NPS, que e a parte critica.
    & $python scripts\fetch_metabase.py
    if ($LASTEXITCODE -ne 0) {
        $falhas += "Metabase (codigo $LASTEXITCODE)"
        Write-Warning $falhas[-1]
    }

    Write-Output "== Buscando comentarios do i-NPS no Metabase =="
    # Os comentarios sao a leitura qualitativa do mesmo NPS; se falharem, o
    # painel abre a tela vazia e o resto continua de pe.
    & $python scripts\fetch_comentarios.py
    if ($LASTEXITCODE -ne 0) {
        $falhas += "comentarios do i-NPS (codigo $LASTEXITCODE)"
        Write-Warning $falhas[-1]
    }

    Write-Output "== Buscando onboarding no Metabase =="
    & $python scripts\fetch_onboarding.py
    if ($LASTEXITCODE -ne 0) {
        $falhas += "onboarding (codigo $LASTEXITCODE)"
        Write-Warning $falhas[-1]
    }

    Write-Output "== Empacotando para o Apps Script =="
    & $python scripts\build_appscript.py
    if ($LASTEXITCODE -ne 0) {
        $falhas += "empacotamento do Apps Script (codigo $LASTEXITCODE)"
        Write-Warning $falhas[-1]
    }

    # Publica no Apps Script se o clasp estiver configurado. Sem ele o pacote
    # fica em dist/appscript/ para colar a mao — ver dist/appscript/LEIA-ME.md.
    if (Test-Path (Join-Path $repoDir ".clasp.json")) {
        Write-Output "== Publicando no Apps Script =="
        npx --yes @google/clasp push --force
        if ($LASTEXITCODE -eq 0) {
            npx --yes @google/clasp deploy --description "atualizacao semanal"
            if ($LASTEXITCODE -ne 0) { Write-Warning "clasp deploy falhou - o codigo subiu, mas a implantacao nao foi atualizada." }
        } else {
            Write-Warning "clasp push falhou - o painel no Apps Script segue com os dados anteriores."
        }
    } else {
        Write-Output "clasp nao configurado - pacote pronto em dist\appscript\ para publicar a mao."
    }

    Write-Output "== Verificando alteracoes =="
    git add data\nps.json data\ocorrencias.json
    $changes = git diff --cached --name-only

    if ($changes) {
        Write-Output "== Publicando alteracoes =="
        git commit -m "chore: atualiza dados do NPS e das ocorrencias (automatico)"
        git push
        Write-Output "OK: dados atualizados e publicados."
    } else {
        Write-Output "OK: sem mudancas nos dados desta semana."
    }

    if ($falhas.Count -gt 0) {
        Write-Output ""
        Write-Output "CONCLUIDO COM FALHAS:"
        $falhas | ForEach-Object { Write-Output "  - $_" }
        exit 1
    }
} catch {
    Write-Error $_
    exit 1
} finally {
    Stop-Transcript
}
