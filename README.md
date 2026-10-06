# Onderhaus

**Onderhaus** (say it "on the house"): cross-chain USDC payments between Arc and Stellar
where the recipient needs no gas. The gas is on the house.

A recipient receives native USDC on Stellar without ever holding XLM. The sender burns USDC
on Arc through CCTP V2 as usual, then hands the burn hash to Onderhaus, which submits the
completion on Stellar and pays the XLM fee from its own funded account. The completion calls
come from the `@asctp/parabola` SDK.

## Stage

This is Phase 1 of three, and it is an early proof that runs rather than a product with
users. What exists today is a single authenticated service that completes Arc to Stellar
transfers. It has not been run against a funded account on mainnet. There is no hosted
instance, no demo page, and no reverse direction. See [Scope](#scope) for the precise
boundary.

## The gap this fills

CCTP moves native USDC by burning it on a source chain and minting it on a destination
chain after Circle attests the burn. On Stellar the final step is not a plain mint. It is a
call to `mint_and_forward` on Circle's on-chain `CctpForwarder` contract, which mints to
itself and then forwards the USDC to the real recipient. That contract already exists and is
deployed.

The problem is that every Stellar transaction costs a fee paid in XLM, so whoever submits
`mint_and_forward` must hold XLM. Circle runs a hosted relayer that covers this on EVM chains
and Solana, but not on Stellar. This service is the missing relayer for that rail.

The property that makes it work is that the submitting account has nothing to do with who
gets paid. The recipient is fixed inside the burn message's hook data at burn time, not
passed as an argument. So one funded XLM account can pay the fee for any number of
recipients, and none of them need XLM, or a wallet, or anything else on Stellar beyond a
USDC trustline.

## What a recipient still needs

A Stellar account must exist on-ledger and hold a USDC trustline before it can receive USDC.
Neither is something this service can set up on a stranger's behalf, since both require the
recipient's own signature. A transfer to an account without a trustline cannot land, so the
service checks both conditions before spending anything and refuses with a clear error if
either is missing.

## Quick start

Requires Node 20 or later and pnpm.

```bash
pnpm install

cp .env.example .env
# Set STELLAR_SECRET_KEY to a funded Stellar account, and leave NETWORK=testnet to start.

pnpm key:create -- --label "my-first-key" --daily-cap 100 --rate-limit 60
# Prints the API key once. Only its hash is stored, so save it now.

pnpm dev
```

The service refuses to complete anything until it has successfully read its own XLM balance
and found it above the floor. That is deliberate, so a misconfigured or unreachable Horizon
ends in a refusal rather than in spending from an account whose balance was never confirmed.

Check whether it considers itself able to work:

```bash
curl -s localhost:3000/healthz   # {"status":"ok"}
curl -s localhost:3000/readyz    # {"status":"ready"}, or 503 {"status":"halted"} while halted
curl -s localhost:3000/v1/status -H "Authorization: Bearer $ONDERHAUS_KEY"
```

`/healthz` is liveness and stays 200 whenever the process is running. `/readyz` is
readiness and turns 503 the moment the low-balance halt is on, so a load balancer pointed
at it stops sending work to a service that would refuse it. Both answer without a key, and
neither returns the balance figure, which stays behind the key on `/v1/status`.

## Completing a transfer

```bash
curl -s localhost:3000/v1/complete \
  -H "Authorization: Bearer $ONDERHAUS_KEY" \
  -H "content-type: application/json" \
  -d '{
    "burnTxHash": "0x...",
    "from": "arc",
    "to": "stellar",
    "recipient": "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
    "network": "testnet"
  }'
```

The `recipient` field is required. The app that initiated the burn already holds the address it
encoded, so it passes that back. The service uses the value to confirm the account can receive
USDC before it spends anything.

A successful completion returns the destination transaction hash:

```json
{ "mintTxHash": "...", "attestationHash": "...", "replayed": false }
```

If the same `burnTxHash` is submitted again by the same key, the service returns the
recorded result with `replayed: true` rather than submitting a second time.

### Responses

| Status | Code | Meaning |
| --- | --- | --- |
| 200 | | Completed. `mintTxHash` is the Stellar transaction. |
| 400 | `validation_error` | Malformed request, or a direction other than Arc to Stellar. |
| 400 | `network_mismatch` | The request named a network this service is not configured for. |
| 401 | `unauthorized` | Missing, unknown, or disabled API key. |
| 409 | `attestation_pending` | Circle has not attested the burn yet. Retry the same request. |
| 409 | `mint_in_progress` | Another request for this burn is being submitted right now. Retry shortly. |
| 422 | `recipient_not_ready` | The recipient account does not exist, or has no USDC trustline. |
| 429 | `rate_limited` | The key's rate limit or the caller's per-address limit was exceeded. |
| 429 | `spend_cap_exceeded` | Per-key daily completion cap reached. Resets at 00:00 UTC. |
| 502 | `upstream_error` | A failure outside this service. Read the message before retrying. |
| 503 | `insufficient_service_balance` | The service's own XLM is below the floor, or unconfirmed. |

A 502 caused by a submission timeout is the one case where the outcome is genuinely
unknown. The transaction was broadcast and may still land, so the message contains the
transaction hash and the caller should check it before retrying. Retrying is not dangerous,
because CCTP rejects a message that has already been used, but it costs another fee to find
that out.

## Scope

Built:

- An authenticated HTTP service that completes Arc to Stellar CCTP transfers
- Pre-spend verification that the recipient account exists and holds a USDC trustline
- Per-key API keys, rate limiting, daily spend caps, and a metered usage ledger
- Balance monitoring on the service's Stellar account with a low-balance halt
- Idempotent completion keyed on the burn hash, so a retry does not resubmit

Not built:

- The reverse direction, Stellar to Arc, which is Phase 2. Requests for it are refused
  explicitly rather than failing obscurely.
- A hosted instance and a demo page, which is Phase 3.
- Any on-chain fee mechanism. See the fee model below.
- Batch submission. Each completion is one request.

## Fee model

Every completion spends real XLM from the service account, so access is metered rather than
open. Each integrating app gets an API key carrying a per-minute rate limit and an optional
daily cap, and every completion is written to a local ledger holding the API key, the burn
hash, the recipient, and the outcome.

Payment is off-band. Usage is invoiced on a cycle you set, and nothing enforces payment
on-chain, so the model rests on the integrator paying. That ledger is both the billing record
and the idempotency guard, since it is unique on the API key, the burn hash, and the network
together.

The trustless alternative is a USDC fee taken on the source chain at burn time, or skimmed by
a forwarder contract before forwarding. Both need on-chain code this service does not ship,
and both are the path once there is volume worth the audit.

## Security posture

This service custodies a hot, funded Stellar key and spends real money on request. Running
it means accepting that.

- **API keys are required on every spending endpoint.** There is no unauthenticated
  completion path. Only the two probes are open, and they reveal nothing beyond liveness
  and whether the service is currently willing to work.
- **Only hashes of API keys are stored.** A key that is lost cannot be recovered and must be
  replaced.
- **Per-key rate limits and daily caps** bound what any single caller can cause the service
  to spend.
- **A per-address rate limit** bounds everything else, including requests presenting no key
  and requests carrying a body the schema rejects. Both limiters run before the body is
  validated, because a limiter that only ever sees well-formed authenticated traffic can be
  bypassed by sending neither. The probes are exempt so that health checking cannot take the
  service out of rotation during the incident it exists to detect.
- **The service key never leaves the environment**, is never logged, and is never written to
  the database. Log output redacts the `Authorization` header so a key cannot leak into a log
  file through a request.
- **A low-balance halt** stops completion when the service account falls below a configured
  floor. The halt fails closed: until the first successful balance read, the service reports
  itself halted and refuses to complete anything.
- **Mainnet is opt-in.** The service defaults to testnet, which differs from the SDK's own
  default, and it refuses any request naming a network it is not configured for.

The recipient field deserves one explicit note. The caller supplies it, and the service uses
it only to decide whether a mint is worth attempting. It cannot be used to redirect funds,
because `mint_and_forward` pays whichever address is encoded in the burn message. A wrong
recipient can therefore cause a refused transfer or a wasted submission, but never a payment
to the wrong account.

## Configuration

See [`.env.example`](.env.example) for the full list with notes. The values that matter most:

| Variable | Purpose |
| --- | --- |
| `STELLAR_SECRET_KEY` | The funded account that pays the XLM fee. Required. |
| `NETWORK` | `testnet` or `mainnet`. Defaults to `testnet`. |
| `STELLAR_RPC_URL` | Soroban RPC override. The mainnet default is rate limited and is not meant for production traffic. |
| `DATABASE_PATH` | Where the key table and ledger live. |
| `XLM_LOW_BALANCE_FLOOR` | Halt threshold for the service account. |
| `IP_RATE_LIMIT_PER_MINUTE` | Per-address ceiling covering traffic that presents no key or a malformed body. Defaults to 600. |
| `ATTESTATION_POLL_TIMEOUT_MS` | How long one request waits for Circle before answering 409. Defaults to 30 seconds, well below the SDK's 5 minutes, so a request does not hold a connection open for minutes. |
| `TRUST_PROXY` | Set true only behind a proxy you control, so the per-address limit sees the real client address rather than the proxy's. |

## Development

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest, 65 tests, no network access
pnpm build       # tsup, emits ESM to dist/
pnpm key:create  # provision an API key
pnpm key:list    # list keys and today's usage
```

Tests inject fakes for the two SDK calls that would otherwise reach the network, so the
suite runs offline and never spends anything. `pnpm test` currently passes with 65 tests
across 4 files.

No live transfer has been run. That needs a funded Stellar account on the target network,
which was not available while this was built. The first live run should be on testnet, where
an unfunded service key correctly reports itself halted and refuses to complete anything.

## License

MIT
