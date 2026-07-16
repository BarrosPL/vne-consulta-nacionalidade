# Próximos passos — Sistema de consulta de nacionalidade

Atualizado em: 16/07/2026

## 1. Objetivo do sistema

O sistema deve ler os códigos de consulta da aba `Andamentos` no Google Sheets, consultar o portal da Justiça portuguesa, resolver o hCaptcha, identificar a situação atual do processo e atualizar a mesma linha da planilha.

O resultado esperado inclui:

- fase atual do processo;
- posição da fase, por exemplo `3 de 5`;
- quantidade total de fases (4 ou 5);
- data da fase atual;
- indicação de existência de notificação;
- título de uma ou mais notificações;
- data e hora da consulta;
- observação de sucesso ou erro.

## 2. Estado atual da implementação

O arquivo principal é `consulta_status.js`.

Já está implementado:

- leitura de Excel local;
- leitura e atualização do Google Sheets;
- automação do Chromium com Playwright;
- resolução automática de hCaptcha por CapSolver e 2Captcha;
- fallback entre os serviços de CAPTCHA;
- reconhecimento de processos com 4 ou 5 fases;
- reconhecimento de fase atual pelas marcações `aria-current="step"`, `active` e `current`;
- fallback para a última fase `past` quando o portal não marca explicitamente a fase atual;
- detecção de notificações pelo título dos cartões;
- reconhecimento correto de bloco de notificações vazio;
- suporte a múltiplos títulos, separados por ` | `;
- gravação de resultados em colunas separadas;
- Chromium do Playwright instalado no computador local.

Os três HTMLs de referência foram validados:

1. `pagina_principal.html`
   - 4 fases;
   - fase atual: `Submetido`;
   - posição: `1 de 4`;
   - possui notificação.

2. `segundo_exemplo.html`
   - 5 fases;
   - fase atual: `Aguarda resposta`;
   - posição: `3 de 5`;
   - possui notificação.

3. `terceiro_exemplo.html`
   - 4 fases;
   - fase atual: `Submetido`;
   - posição: `1 de 4`;
   - não possui notificação.

## 3. Configuração atual do Google Sheets

O `config.json` está apontando para:

- planilha: `1Cq-QlenMcb-7oeB0dBW9eeexUguo7toH`;
- aba: `Andamentos`;
- coluna de entrada: `CÓDIGO DE CONSULTA`;
- armazenamento: `google_sheets`.

As colunas de saída configuradas são:

- `FASE CONSULTA AUTOMÁTICA`;
- `POSIÇÃO DA FASE`;
- `TOTAL DE FASES`;
- `DATA DA FASE`;
- `POSSUI NOTIFICAÇÃO`;
- `TÍTULOS DAS NOTIFICAÇÕES`;
- `DATA DA ÚLTIMA CONSULTA`;
- `OBSERVAÇÃO CONSULTA`.

Essas colunas serão criadas automaticamente caso não existam. As colunas manuais `STATUS` e `ANOTAÇÕES` não serão sobrescritas.

## 4. Primeira pendência: credencial do Google

Ainda falta colocar o arquivo de conta de serviço na raiz do projeto:

```text
google-service-account.json
```

Passos:

1. Baixar a chave JSON da conta de serviço no Google Cloud.
2. Renomear para `google-service-account.json`.
3. Colocar na mesma pasta do `config.json`.
4. Copiar o valor de `client_email` presente no JSON.
5. Compartilhar a planilha com esse e-mail como `Editor`.
6. Não compartilhar o conteúdo do JSON e não enviá-lo ao GitHub.

O `.gitignore` já protege:

```text
.env
google-service-account.json
*.service-account.json
```

## 5. Ajustes necessários antes do primeiro teste real

A planilha de exemplo possui aproximadamente:

- 767 linhas com conteúdo;
- 534 linhas com código de consulta;
- 458 códigos únicos;
- 72 códigos repetidos;
- 673 linhas ocultas.

O fluxo atual percorre todas as linhas, inclusive ocultas e duplicadas. Portanto, não executar `npm start` na planilha completa antes de implementar controles de segurança.

Implementar primeiro:

### 5.1. Modo de teste

Adicionar opções ao `config.json`, por exemplo:

```json
"linha_inicial": 2,
"linha_final": 2,
"limite_por_execucao": 1
```

Isso permitirá testar somente uma linha conhecida.

### 5.2. Pular resultados já consultados

Antes de consultar uma linha, verificar `DATA DA ÚLTIMA CONSULTA` e/ou `FASE CONSULTA AUTOMÁTICA`.

Adicionar uma opção como:

```json
"reconsultar_processados": false
```

### 5.3. Tratar códigos duplicados

Durante uma execução, consultar cada código apenas uma vez. Quando o mesmo código aparecer em várias linhas, reutilizar o resultado e atualizar todas as linhas correspondentes.

Isso reduz tempo e consumo de créditos de CAPTCHA.

### 5.4. Definir regra para linhas ocultas

A API do Google Sheets normalmente retorna linhas ocultas. Precisamos decidir entre:

- consultar todas as linhas com código;
- ignorar linhas ocultas;
- usar uma coluna explícita, como `CONSULTAR AUTOMATICAMENTE`, com `SIM` ou `NÃO`.

A opção mais previsível é criar uma coluna de controle explícita.

### 5.5. Evitar execução simultânea

Impedir que duas execuções processem a mesma planilha ao mesmo tempo. Isso será especialmente importante no servidor.

## 6. Roteiro do primeiro teste local

Depois de adicionar a credencial e implementar o modo limitado:

1. Escolher uma linha de teste com código válido.
2. Configurar limite de uma linha.
3. Confirmar que a planilha foi compartilhada com a conta de serviço.
4. Confirmar saldo no serviço de CAPTCHA.
5. Executar:

```powershell
npm.cmd start
```

6. Conferir no terminal:
   - CAPTCHA detectado;
   - solver utilizado;
   - fase extraída;
   - posição da fase;
   - notificação detectada.
7. Conferir se as oito colunas foram criadas/atualizadas na linha correta.
8. Testar uma linha com notificação e outra sem notificação.
9. Somente depois aumentar gradualmente o limite.

## 7. Melhorias recomendadas para operação local

- padronizar mensagens e corrigir textos antigos do README;
- remover dependências npm que não são utilizadas;
- adicionar logs com horário e código mascarado;
- registrar número de sucessos, erros e linhas ignoradas ao final;
- implementar tentativas de navegação separadas das tentativas de CAPTCHA;
- salvar HTML e screenshot automaticamente somente quando ocorrer erro;
- definir intervalo configurável entre consultas;
- detectar respostas inválidas, bloqueios e páginas inesperadas;
- evitar apagar um resultado anterior quando uma nova tentativa falhar;
- gravar o erro sem sobrescrever a última fase válida.

## 8. Preparação para Docker

Depois que o fluxo local estiver estável, criar:

- `Dockerfile`;
- `.dockerignore`;
- comando de inicialização apropriado;
- verificação de saúde, se o sistema virar API/worker permanente.

Imagem base sugerida, mantendo a mesma versão do Playwright usada no projeto:

```dockerfile
FROM mcr.microsoft.com/playwright:v1.61.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

CMD ["npm", "start"]
```

No servidor, usar:

```json
"headless": true
```

Nunca copiar `.env` ou `google-service-account.json` para dentro da imagem.

## 9. Modelo recomendado para EasyPanel

O script atual executa uma vez e termina. Se for publicado diretamente como serviço e o EasyPanel reiniciar processos encerrados, a planilha poderá ser processada repetidamente.

Antes do deploy, escolher um modelo operacional:

### Opção recomendada: API/worker controlado

Criar uma pequena API com:

- endpoint protegido para iniciar uma consulta;
- endpoint para consultar o estado da execução;
- trava contra duas execuções simultâneas;
- limite por lote;
- logs de execução;
- agendamento opcional.

Exemplo conceitual:

```text
POST /executions
GET  /executions/current
GET  /health
```

O endpoint de início deve exigir autenticação e nunca ficar público sem proteção.

### Alternativa: execução agendada

Executar o worker em horário definido, garantindo que:

- somente uma instância rode por vez;
- linhas já processadas sejam ignoradas;
- exista limite por execução;
- falhas não iniciem um ciclo infinito de reinicialização.

## 10. Configuração futura no EasyPanel

Configurar as chaves como variáveis secretas:

```env
CAPSOLVER_API_KEY=...
TWOCAPTCHA_API_KEY=...
GOOGLE_SHEET_ID=1Cq-QlenMcb-7oeB0dBW9eeexUguo7toH
GOOGLE_APPLICATION_CREDENTIALS=/app/secrets/google-service-account.json
```

Montar a credencial como arquivo em:

```text
/app/secrets/google-service-account.json
```

Configuração recomendada:

- uma única réplica do worker;
- Chromium em modo headless;
- memória suficiente para Chromium;
- política de reinicialização que não repita lotes concluídos;
- logs habilitados;
- nenhum domínio público enquanto o projeto for apenas um worker;
- se virar API, domínio HTTPS e autenticação obrigatória.

## 11. Ordem recomendada para continuar

1. Adicionar e validar `google-service-account.json`.
2. Implementar limite de linhas/modo de teste.
3. Implementar a regra para pular linhas já processadas.
4. Reutilizar resultados de códigos duplicados.
5. Definir tratamento de linhas ocultas ou coluna de controle.
6. Executar testes locais de uma linha.
7. Executar lote pequeno de 3 a 5 linhas.
8. Corrigir erros observados e atualizar o README.
9. Criar Dockerfile e testar a imagem localmente.
10. Transformar o script em worker/API controlado.
11. Publicar no EasyPanel com segredos e uma única réplica.
12. Monitorar a primeira execução em produção antes de habilitar agendamento.

## 12. Comando para retomar o trabalho

Ao continuar, solicitar:

> Leia o arquivo `PROXIMOS_PASSOS.md` e continue a partir da seção 5, começando pelo modo de teste limitado a uma linha.
