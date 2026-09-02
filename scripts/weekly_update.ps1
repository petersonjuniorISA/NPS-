# Atualiza data/nps.json com dados reais do Databricks e sobe para o GitHub.
# Rodado automaticamente pelo Agendador de Tarefas do Windows (tarefa "NPS-ISAs-AtualizacaoSemanal").
# Usa o login OAuth salvo localmente (databricks auth login) — não precisa de token.
#
# Para rodar manualmente: powershell -File scripts\weekly_update.ps1

$ErrorActionPreference = "Stop"
$repoDir = Split-Path -Parent $PSScriptRoot
Set-Location $repoDir

$logDir = Join-Path $repoDir "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logFile = Join-Path $logDir ("weekly_update_{0}.log" -f (Get-Date -Format "yyyy-MM-dd_HHmmss"))

Start-Transcript -Path $logFile

try {
    Write-Output "== Buscando dados no Databricks =="
    python scripts\fetch_databricks.py
    if ($LASTEXITCODE -ne 0) { throw "fetch_databricks.py falhou com codigo $LASTEXITCODE" }

    Write-Output "== Verificando alteracoes =="
    git add data\nps.json
    $changes = git diff --cached --name-only

    if ($changes) {
        Write-Output "== Publicando alteracoes =="
        git commit -m "chore: atualiza dados do NPS (automatico)"
        git push
        Write-Output "OK: nps.json atualizado e publicado."
    } else {
        Write-Output "OK: sem mudancas nos dados desta semana."
    }
} catch {
    Write-Error $_
    exit 1
} finally {
    Stop-Transcript
}
