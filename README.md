# Sistema de consulta de status

Este projeto le a planilha `Leads_Correlacionados_Codigo_Consulta.xlsx`, consulta o site do Registo/Justica com o campo `codigo_consulta` e gera a planilha `Leads_Correlacionados_Com_Status.xlsx` com duas colunas novas:

- `status_processo`
- `observacao_consulta`

## Importante sobre CAPTCHA

O script nao burla nem resolve CAPTCHA automaticamente. Quando o navegador abrir, resolva o CAPTCHA manualmente e pressione `ENTER` no terminal para o script continuar lendo o resultado.

## Instalação

```powershell
npm.cmd install
npx.cmd playwright install chromium
```

## Execução

```powershell
npm.cmd start
```

O navegador sera aberto em modo visivel. Para cada linha, o script salva a planilha de saida imediatamente, entao se a execucao for interrompida voce nao perde o progresso ja obtido.

## Configuração

As principais opcoes ficam em `config.json`:

- `input_file`: planilha original.
- `output_file`: planilha gerada.
- `codigo_coluna`: nome da coluna que contem o codigo.
- `status_coluna`: coluna criada para o status.
- `observacao_coluna`: coluna criada para mensagens de erro ou controle.
- `headless`: mantenha `false` para conseguir resolver o CAPTCHA.

## Usando Google Sheets

O script agora aceita dois modos no `config.json`:

- `storage: "local_excel"`: usa os arquivos `.xlsx` locais.
- `storage: "google_sheets"`: le e atualiza uma planilha do Google Sheets.

Para usar Google Sheets:

1. Ative a Google Sheets API em um projeto do Google Cloud.
2. Crie uma service account e baixe a chave JSON.
3. Coloque o arquivo JSON na pasta do projeto, por exemplo `google-service-account.json`.
4. Compartilhe a planilha com o e-mail da service account.
5. Configure o `config.json`:

```json
{
  "storage": "google_sheets",
  "google_sheet_id": "ID_DA_PLANILHA",
  "google_sheet_name": "NomeDaAba",
  "google_credentials_file": "google-service-account.json"
}
```

Tambem e possivel definir o ID e a credencial pelo `.env`:

```env
GOOGLE_SHEET_ID=ID_DA_PLANILHA
GOOGLE_APPLICATION_CREDENTIALS=./google-service-account.json
```

## PostgreSQL

Para PostgreSQL, a conexão vem de `DATABASE_URL` no `.env`. O projeto inicia protegido por:

```json
"storage": "postgres",
"modo_teste": true,
"id_registro_teste": "",
"limite_por_execucao": 1,
"simular": true
```

Preencha `id_registro_teste` com um identificador existente. Com `simular: true`, `npm start` apenas mostra a seleção com o código mascarado; não abre o portal nem grava no banco. Depois de conferir a seleção, use `simular: false` para consultar somente esse registro.

Comandos de banco:

```powershell
npm.cmd run db:validate
npm.cmd run db:inspect
npm.cmd run db:map
```

A migração está em `migrations/001_consultas_nacionalidade.sql`. Os campos manuais `status` e `anotacoes` não são sobrescritos pela automação.

## EasyPanel

O `Dockerfile` executa um agendador diário. O worker só processa o banco quando o ciclo configurado de 15 dias estiver vencido. Consulte `EASYPANEL_DEPLOY.md` para variáveis, primeiro deploy e acompanhamento.
