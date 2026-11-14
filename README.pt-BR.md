# Distributed Wagering Processor

> Tradução de [README.md](README.md), gerada a partir da versão final em inglês. Em caso de divergência, vale o original.

Serviço financeiro que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) de vários provedores, por HTTP e por uma fila SQS FIFO, e mantém o saldo de cada wallet e o seu ledger append-only consistentes com qualquer número de instâncias. É a solução do desafio de backend da Jungle Gaming; o enunciado está preservado sem alterações em [docs/CHALLENGE.md](docs/CHALLENGE.md).

Bun, TypeScript (strict), NestJS, MikroORM 7, PostgreSQL 17, SQS e SNS via LocalStack 4.12, Docker Compose.

| Documento | Conteúdo |
| --- | --- |
| [ARCHITECTURE.pt-BR.md](ARCHITECTURE.pt-BR.md) | A seção crítica, as garantias do schema, as decisões (ADRs) com seus trade-offs, a máquina de estados, os códigos de falha, as interpretações e as limitações conhecidas |
| [docs/spec/REQUIREMENTS.md](docs/spec/REQUIREMENTS.md) | Cada requisito do enunciado ligado ao teste que o prova (em inglês) |
| [docs/LOAD-TEST.md](docs/LOAD-TEST.md) | O experimento de carga: metodologia, resultados e leitura (em inglês) |
| [docs/CHALLENGE.md](docs/CHALLENGE.md) | O enunciado |

## O que é garantido, e onde está provado

| Garantia | Mecanismo | Prova |
| --- | --- | --- |
| Dinheiro nunca é `number` | Value object `Money` sobre `decimal.js`, colunas `NUMERIC(19,2)`, valores como strings com duas casas em toda API e evento | `test/unit/domain/money.test.ts` |
| Um único débito para 50 cópias paralelas de uma aposta, em três processos | `SELECT … FOR UPDATE` na linha da wallet e, sob o lock, a busca pela chave de idempotência; índices únicos como rede de segurança | `test/concurrency/wallet-races.test.ts` |
| Saldo nunca negativo | Lock por wallet, `Wallet.debit()` e `CHECK (balance >= 0)` | mesmo arquivo, 60 apostas de 5.00 numa wallet de 100 |
| Idempotência sobrevive a reinícios e instâncias | A linha da transação é o registro de idempotência; o replay devolve o resultado gravado | `test/integration/wagering-transactions.test.ts` |
| Wallet, ledger, transação, inbox e outbox no mesmo commit; nenhum evento antes do commit; ack do SQS depois do commit | Uma transação SQL; publisher do outbox com `FOR UPDATE SKIP LOCKED` | `test/integration/unit-of-work.test.ts`, `test/integration/outbox-publisher.test.ts`, `test/concurrency/sqs-consumer.test.ts` (processo morto entre o commit e o ack) |
| O ledger é append-only e sempre explica o saldo | Triggers que recusam `UPDATE`, `DELETE` e `TRUNCATE`; `UNIQUE (wallet_id, sequence)` | `expectLedgerInvariant` no `afterAll` de todo arquivo de integração, concorrência e carga |

## Início rápido

Pré-requisitos: Docker com Compose v2 e [Bun](https://bun.sh) 1.x (os scripts, as verificações estáticas e os testes de unidade rodam no host; o resto roda em containers).

```bash
git clone <repository-url> wagering && cd wagering
bun install
docker compose up -d --build --wait
```

Isso sobe o PostgreSQL, o LocalStack (cujo script de init cria as filas, a DLQ, o tópico SNS FIFO e a fila assinante), um container `migrate` de execução única que aplica as migrations, e uma instância da aplicação. `--wait` retorna quando todos os serviços estão saudáveis.

A instância publica a porta 3000 na primeira porta livre do host entre 3000 e 3002. Para descobri-la:

```bash
docker compose port app 3000          # ex.: 0.0.0.0:3000
export API=http://localhost:3000      # use a porta exibida acima
```

Três instâncias: `docker compose up -d --build --wait --scale app=3`; cada uma recebe sua porta do mesmo intervalo (`docker compose ps`).

Para parar tudo: `docker compose down`; acrescente `--volumes` para apagar o banco.

## Passo a passo

Todas as respostas abaixo foram produzidas por estes comandos contra a stack. Os identificadores vão variar.

Abrir uma wallet. O saldo inicial é uma transação interna `OPENING`, creditada a partir de uma conta de funding na mesma transação SQL.

```bash
curl -s -X POST $API/wallets -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
# {"id":"01a1d8d5-1adc-75fe-…","playerId":"player-1","balance":{"amount":"100.00","currency":"BRL"},"version":1}

export WALLET=01a1d8d5-1adc-75fe-…    # o id acima
```

Fazer uma aposta. `Idempotency-Key` é obrigatório; a chave recomendada é `{providerId}:{externalTransactionId}`.

```bash
BET='{"providerId":"provider-a","externalTransactionId":"bet-1","playerId":"player-1","walletId":"'$WALLET'",
      "roundId":"round-1","gameId":"game-1","kind":"BET","money":{"amount":"30.00","currency":"BRL"}}'
curl -s -X POST $API/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:bet-1' -d "$BET"
# 200 {"transactionId":"01a1d8d5-1b28-…","status":"PROCESSED","balance":{"amount":"70.00","currency":"BRL"},"idempotentReplay":false}
```

Reenviar: o resultado gravado é devolvido, com o saldo observado da primeira vez. A mesma chave com outro valor: conflito.

```bash
curl -s -X POST $API/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:bet-1' -d "$BET"
# 200 {"transactionId":"01a1d8d5-1b28-…","status":"PROCESSED","balance":{"amount":"70.00","currency":"BRL"},"idempotentReplay":true}

curl -s -X POST $API/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:bet-1' -d "${BET/30.00/31.00}"
# 409 {"code":"IDEMPOTENCY_KEY_CONFLICT","message":"The idempotency key was already used with another payload"}
```

Um `REFUND` que chega antes do seu `BET` espera (`202 PENDING_REFERENCE`). O worker de referências pendentes o aplica quando o `BET` existir (backoff de 1 s dobrando até 60 s, 10 tentativas, ADR-05). O `BET` não o acorda: o worker o encontra na próxima tentativa, em menos de um segundo quando o `BET` vem logo em seguida, como abaixo, ou até 60 s depois nos outros casos. Um `BET` que chega depois da última tentativa, cerca de 4 minutos após o `REFUND`, chega tarde: o `REFUND` termina `REJECTED` com `REFERENCE_NOT_FOUND` (L-10).

```bash
REFUND='{"providerId":"provider-a","externalTransactionId":"refund-2","playerId":"player-1","walletId":"'$WALLET'",
         "roundId":"round-1","gameId":"game-1","kind":"REFUND","money":{"amount":"20.00","currency":"BRL"},
         "referenceExternalTransactionId":"bet-2"}'
curl -s -X POST $API/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:refund-2' -d "$REFUND"
# 202 {"transactionId":"01a1d8d5-1bbc-…","status":"PENDING_REFERENCE","balance":{"amount":"70.00","currency":"BRL"},"idempotentReplay":false}

BET2='{"providerId":"provider-a","externalTransactionId":"bet-2","playerId":"player-1","walletId":"'$WALLET'",
       "roundId":"round-1","gameId":"game-1","kind":"BET","money":{"amount":"20.00","currency":"BRL"}}'
curl -s -X POST $API/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:bet-2' -d "$BET2"
# 200 {…,"status":"PROCESSED","balance":{"amount":"50.00","currency":"BRL"},…}

curl -s $API/providers/provider-a/wagering/transactions/refund-2     # repita até sair de PENDING_REFERENCE
# {…,"kind":"REFUND","referenceTransactionId":"01a1d8d5-1beb-…","status":"PROCESSED","balance":{"amount":"70.00","currency":"BRL"},…}
```

Ler a wallet, o ledger e a reconciliação.

```bash
curl -s $API/wallets/$WALLET
# {"id":"…","playerId":"player-1","balance":{"amount":"70.00","currency":"BRL"},"version":4}

curl -s "$API/wallets/$WALLET/ledger?limit=2"
# {"items":[{…"direction":"CREDIT","money":{"amount":"100.00",…},"sequence":1…},{…"direction":"DEBIT","money":{"amount":"30.00",…},"sequence":2…}],
#  "nextCursor":"MDFhMWQ4…","hasMore":true}
curl -s "$API/wallets/$WALLET/ledger?limit=2&cursor=MDFhMWQ4…"

curl -s -X POST $API/wallets/$WALLET/reconciliation
# {"walletId":"…","storedBalance":{"amount":"70.00",…},"calculatedBalance":{"amount":"70.00",…},
#  "difference":{"amount":"0.00","currency":"BRL"},"consistent":true,"checkedEntries":4}
```

O ledger é paginado na ordem da sequência, com um cursor opaco ligado à sua wallet (50 por página por padrão, no máximo 200). **Pare em `hasMore: false`, não na ausência de cursor:** a última página mantém o cursor, para que um leitor possa retomar dali depois de novas escritas (L-13). As páginas são estáveis sob escritas concorrentes.

Uma transação também pode ser lida pelo id: `GET /wagering/transactions/{transactionId}`.

### Por SQS

O consumer lê `wager-transactions.fifo`. A mensagem é o envelope do enunciado; `data.idempotencyKey` faz o papel do header, então a mesma requisição de negócio enviada por HTTP e por SQS é uma única transação. Use o id da wallet como `MessageGroupId` para manter a ordem das mensagens de uma wallet.

```bash
docker compose exec -T localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id "$WALLET" --message-deduplication-id msg-1 \
  --message-body '{"messageId":"msg-1","type":"WagerTransactionRequested","occurredAt":"2026-11-14T12:00:00.000Z",
    "data":{"idempotencyKey":"provider-a:win-1","providerId":"provider-a","externalTransactionId":"win-1",
    "playerId":"player-1","walletId":"'$WALLET'","roundId":"round-1","gameId":"game-1","kind":"WIN",
    "money":{"amount":"15.00","currency":"BRL"}}}'

curl -s $API/wallets/$WALLET      # saldo 85.00, versão 5
```

No Git Bash do Windows, prefixe os comandos `docker compose exec` com `MSYS_NO_PATHCONV=1`.

Os eventos (`WagerTransactionProcessed`, `WalletBalanceChanged`, `WagerTransactionRejected`, `WagerTransactionPendingReference`) são publicados depois do commit no tópico SNS FIFO `wager-events.fifo`, que os distribui para a fila assinante:

```bash
docker compose exec -T localstack awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/wager-events-subscriber.fifo --max-number-of-messages 10
```

A entrega é at-least-once, ordenada por wallet dentro de um lote do publisher: o consumidor ordena por `walletVersion` e deduplica por `eventId` (L-14).

## Para provedores: o que cada resposta significa

| Resposta | Significado | O que fazer |
| --- | --- | --- |
| 200 `PROCESSED` | Aplicada (um `LOSS` é registrado sem mexer no saldo) | Nada |
| 202 `PENDING_REFERENCE` | A transação referenciada ainda não existe | Esperar o evento, ou consultar a transação |
| 400 `VALIDATION_ERROR`, `IDEMPOTENCY_KEY_REQUIRED` | Requisição inválida; nada gravado | Corrigir a requisição |
| 403 `PROVIDER_FORBIDDEN` | O chamador não pode agir por este provedor (nunca hoje: autenticação não implementada, ADR-08) | Usar as credenciais do próprio provedor |
| 404 `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND` | Identificador desconhecido | Corrigir o identificador |
| 409 `IDEMPOTENCY_KEY_CONFLICT`, `EXTERNAL_TRANSACTION_CONFLICT`, `WALLET_ALREADY_EXISTS` | A chave ou o id externo já foi usado | Não reenviar |
| 422 com `failureCode` | `REJECTED` por regra de negócio, ou `FAILED` (`PROCESSING_FAILED`) | Ler o `failureCode`; reenviar a mesma chave devolve a mesma resposta |
| 503 `SERVICE_UNAVAILABLE` com `Retry-After` | Falha transitória: timeout de lock ou de statement, pool esgotado, banco inacessível | Reenviar com a **mesma chave**: ou nada foi gravado, ou o reenvio devolve o que foi |

`POST /wallets` não tem chave de idempotência: um reenvio depois de um 201 perdido responde 409 `WALLET_ALREADY_EXISTS`, o que significa que a wallet foi criada. A taxonomia completa de códigos de falha está em [ARCHITECTURE.pt-BR.md §6](ARCHITECTURE.pt-BR.md#6-códigos-de-falha-e-status-http).

## Operação

- **Health.** `GET /health/live` (o processo responde) e `GET /health/ready` (PostgreSQL e SQS alcançáveis; 503 caso contrário). Ambos abertos.
- **Métricas.** `GET /metrics`, formato texto do Prometheus: transações por canal e status, latência de processamento, duplicatas, retries por origem, mensagens enviadas à DLQ, conflitos e espera de lock, outbox lag, eventos pendentes e o maior número de tentativas entre eles, profundidade da DLQ, divergências de reconciliação (ADR-14). Contadores são por instância; some entre instâncias.
- **Logs.** Linhas JSON no stdout com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`; nunca valores nem payloads. `X-Correlation-Id` é respeitado ou gerado, devolvido, e levado até os eventos.
- **Transações `FAILED`.** Só uma transação em espera cujas tentativas continuam falhando por um motivo que não é de negócio nem transitório termina `FAILED` com `PROCESSING_FAILED` (L-07). Nada foi movimentado; é terminal.
- **Dead-letter queue.** `wager-transactions-dlq.fifo` recebe dois tipos de mensagem. As que o consumer recusou como permanentes (ilegíveis, inválidas, conflitantes) têm o atributo `failureReason`; reenviá-las sem mudança falha de novo. As que não têm esse atributo esgotaram cinco recebimentos com erros transitórios, tipicamente uma queda do PostgreSQL de mais de cerca de 75 s (ARCHITECTURE §9); é seguro fazer o redrive delas, porque o inbox e a chave de idempotência tornam uma segunda entrega inócua se a primeira foi aplicada.

  ```bash
  # Inspecionar, deixando as mensagens no lugar
  docker compose exec -T localstack awslocal sqs receive-message --visibility-timeout 0 \
    --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
    --max-number-of-messages 10 --message-attribute-names All

  # Redrive para a fila de origem (AWS)
  aws sqs start-message-move-task --source-arn arn:aws:sqs:<region>:<account>:wager-transactions-dlq.fifo
  ```

  O LocalStack 4.12 falha `start-message-move-task` em filas FIFO (a tarefa termina `FAILED` com `AttributeError`). Localmente, reenvie o corpo da mensagem para `wager-transactions.fifo` com `send-message` (mesmo group id, um deduplication id novo) e depois apague-a da DLQ.

## Testes

| Comando | O que roda | Precisa de Docker |
| --- | --- | --- |
| `bun run typecheck` | `tsc --noEmit`, strict | não |
| `bun run lint` | Biome (`bun run lint:fix` formata) | não |
| `bun run test:unit` | Domínio, aplicação e adaptadores sem I/O | não |
| `bun run test:integration` | PostgreSQL e LocalStack reais: constraints e triggers do schema, atomicidade, inbox e redelivery, retries e DLQ, publishers concorrentes, métricas, auditoria de logs, falha de cada dependência (por um proxy TCP na frente do container real) | sim |
| `bun run test:concurrency` | Três processos `bun src/main.ts` reais: 50 cópias paralelas de uma aposta, a corrida das duas apostas de 80, wallets distintas em paralelo, processo morto depois do commit e antes do ack, publishers mortos no meio do lote, reversões antes da referência, processo morto sob carga e substituído | sim |
| `bun run test:load` | Experimento de carga opcional, cerca de dois minutos (ver [docs/LOAD-TEST.md](docs/LOAD-TEST.md)) | sim |

As suítes com Docker constroem uma imagem `test` e rodam dentro dela, contra o PostgreSQL do Compose (num banco separado, `wagering_test`) e o LocalStack, então se comportam igual em Linux, macOS, Windows e no CI. Elas sobem as dependências sozinhas; o container da aplicação não é necessário. Todo arquivo de integração, concorrência e carga termina verificando que o saldo de cada wallet é igual ao saldo reconstruído pelo seu ledger. Os mesmos comandos, exceto o experimento de carga, rodam em todo pull request (`.github/workflows/ci.yml`).

Um arquivo de integração: `docker compose --profile test run --rm --build test bun test ./test/integration/<arquivo>`.

## Configuração

Toda configuração é uma variável de ambiente, validada na inicialização (`src/config/env.ts`). O Compose as define para os containers; [.env.example](.env.example) lista todas, com o valor padrão e o motivo de cada uma.

Para rodar uma instância no host contra as dependências do Compose:

```bash
docker compose up -d --wait postgres localstack
cp .env.example .env
bun run migrate up
bun run start
```

`bun run migrate down` reverte a última migration.

## Estrutura do repositório

```text
src/
  domain/           Money, Wallet, WagerTransaction, WalletLedgerEntry, OutboxMessage, eventos (sem ORM, sem NestJS)
  application/      Casos de uso e suas portas
  infrastructure/   HTTP, consumer SQS, publisher do outbox, workers, records e migrations do MikroORM, logs, métricas
  main.ts           Uma instância: HTTP, consumer e os dois workers
  migrate.ts        Executor de migrations
test/
  unit/  integration/  concurrency/  load/  support/
infra/              Scripts de init do LocalStack e do PostgreSQL
docs/               Enunciado, matriz de requisitos, plano, listas de tarefas por fatia, registro de progresso, teste de carga
```

## Não implementado

- **Autenticação** (enunciado §2, sem pontos). O ponto de extensão está no código: um `AuthGuard` global no-op e uma `ProviderIdentityPort` que o caso de uso consulta antes de abrir a transação; o desenho com Keycloak está em [ARCHITECTURE.pt-BR.md §8](ARCHITECTURE.pt-BR.md#8-desenho-de-autenticação-não-implementado).
- **OpenTelemetry e dashboard** (opcionais).

As limitações do que foi implementado estão em [ARCHITECTURE.pt-BR.md §9](ARCHITECTURE.pt-BR.md#9-limitações-conhecidas).
