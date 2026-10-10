# Onderhaus

**Onderhaus** (say it "on the house"): cross-chain USDC payments between Arc and Stellar
where the recipient needs no gas. The gas is on the house.

A recipient receives native USDC without ever holding the destination chain's gas token. The
sender burns USDC through CCTP V2 as usual, then hands the burn hash to Onderhaus, which
submits the completion and pays the fee from its own funded account. The completion calls
come from the `@asctp/parabola` SDK.

Both directions are supported. Arc to Stellar settles on Stellar and costs XLM. Stellar to
Arc settles on Arc, where gas is paid in native USDC, and is funded from a second account.

## Stage

This is Phase 1 of three, and it is an early proof that runs rather than a product with
users. What exists today is a single authenticated service that completes transfers in both
directions, and both directions have been exercised end to end on testnet. Nothing has been
run against a funded account on mainnet, and there is no hosted instance and no demo page.
See [Scope](#scope) for the precise boundary.

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
The trustline is the half this service cannot set up for a recipient, because `change_trust`
is signed by the account owner. Activation is the easier half, since `create_account` is
signed only by the funder, but this service performs neither and treats both as preconditions.
A transfer to an account without a trustline cannot land, so the service checks both
conditions before spending anything and refuses with a clear error if either is missing.

That requirement is one-sided, and where it applies follows from where the money settles. An
Arc recipient needs no setup, because any address on an EVM chain can hold USDC. So on the
Stellar to Arc direction there is nothing to verify, and the `recipient` field is recorded on
the ledger rather than used as a gate on spending.

## Quick start

Requires Node 20 or later and pnpm.

```bash
pnpm install

cp .env.example .env
# Set STELLAR_SECRET_KEY to a funded Stellar account, and leave NETWORK=testnet to start.
# Set ARC_SECRET_KEY as well if you want the Stellar to Arc direction.

pnpm key:create -- --label "my-first-key" --daily-cap 100 --rate-limit 60
# Prints the API key once. Only its hash is stored, so save it now.

pnpm dev
```

The service refuses to complete anything until it has successfully read the balance of the
account that pays for a direction and found it above that direction's floor. That is
deliberate, so a misconfigured or unreachable Horizon ends in a refusal rather than in
spending from an account whose balance was never confirmed.

Check whether it considers itself able to work:

```bash
curl -s localhost:3000/healthz   # {"status":"ok"}
curl -s localhost:3000/readyz    # {"status":"ready","directions":{...}}, or 503 when nothing works
curl -s localhost:3000/v1/status -H "Authorization: Bearer $ONDERHAUS_KEY"
```

`/healthz` is liveness and stays 200 whenever the process is running. `/readyz` is readiness,
and it reports each direction separately because each is paid for by a different account. It
answers `ready` when every configured direction is funded, `degraded` when some are and some
are not, and 503 `halted` only when the service can serve nothing at all. Both probes answer
without a key, and neither returns a balance figure, which stays behind the key on
`/v1/status`.

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

### The reverse direction

Stellar to Arc takes the same shape with the formats swapped. The burn happens on Stellar, so
the hash is a bare 32 byte transaction hash with no `0x` prefix, and the recipient is an Arc
address.

```bash
curl -s localhost:3000/v1/complete \
  -H "Authorization: Bearer $ONDERHAUS_KEY" \
  -H "content-type: application/json" \
  -d '{
    "burnTxHash": "...",
    "from": "stellar",
    "to": "arc",
    "recipient": "0x...",
    "network": "testnet"
  }'
```

This direction needs `ARC_SECRET_KEY`. Without it the request is refused with 501 rather
than being attempted, so a deployment that only ever meant to spend XLM never needs a second
hot key.

### Responses

| Status | Code | Meaning |
| --- | --- | --- |
| 200 | | Completed. `mintTxHash` is the settling transaction, on Stellar or on Arc. |
| 400 | `validation_error` | Malformed request, or a pair of chains that is not a direction this service knows. |
| 400 | `network_mismatch` | The request named a network this service is not configured for. |
| 401 | `unauthorized` | Missing, unknown, or disabled API key. |
| 409 | `attestation_pending` | Circle has not attested the burn yet. Retry the same request. |
| 409 | `mint_in_progress` | Another request for this burn is being submitted right now. Retry shortly. |
| 422 | `recipient_not_ready` | The Stellar recipient account does not exist, or has no USDC trustline. |
| 429 | `rate_limited` | The key's rate limit or the caller's per-address limit was exceeded. |
| 429 | `spend_cap_exceeded` | Per-key daily completion cap reached. Resets at 00:00 UTC. |
| 501 | `direction_unavailable` | The direction is real, but this deployment holds no account to pay for it. Set `ARC_SECRET_KEY` to enable Stellar to Arc. |
| 502 | `upstream_error` | A failure outside this service. Read the message before retrying. |
| 503 | `insufficient_service_balance` | The account that pays for this direction is below its floor, or its balance is unconfirmed. |

A 502 caused by a submission timeout is the one case where the outcome is genuinely
unknown. The transaction was broadcast and may still land, so the message contains the
transaction hash and the caller should check it before retrying. Retrying is not dangerous,
because CCTP rejects a message that has already been used, but it costs another fee to find
that out.

## Scope

Built:

- An authenticated HTTP service that completes CCTP transfers in both directions
- Pre-spend verification that a Stellar recipient exists and holds a USDC trustline
- Per-direction balance monitoring on whichever account pays for a leg, with an independent
  low-balance halt on each
- Per-key API keys, rate limiting, daily spend caps, and a metered usage ledger that records
  the direction each row was for
- Idempotent completion keyed on the burn hash, so a retry does not resubmit

Not built:

- A hosted instance and a demo page, which is Phase 3.
- A mainnet run. Everything so far has been on testnet.
- Any on-chain fee mechanism. See the fee model below.
- Batch submission. Each completion is one request.

## Fee model

Every completion spends real money from whichever service account pays for that direction,
XLM from the Stellar-funded account and native USDC from the Arc-funded one, so access is
metered rather than open. Each integrating app gets an API key carrying a per-minute rate
limit and an optional daily cap, and every completion is written to a local ledger holding
the API key, the burn hash, the direction, the recipient, and the outcome.

Payment is off-band. Usage is invoiced on a cycle you set, and nothing enforces payment
on-chain, so the model rests on the integrator paying. That ledger is both the billing record
and the idempotency guard, since it is unique on the API key, the burn hash, and the network
together. The direction is deliberately not part of that key, which is safe because the two
hash formats cannot collide: a Stellar hash is bare and an Arc one carries the `0x` prefix,
so the same text is never valid for both legs.

The trustless alternative is a USDC fee taken on the source chain at burn time, or skimmed by
a forwarder contract before forwarding. Both need on-chain code this service does not ship,
and both are the path once there is volume worth the audit.

## Security posture

This service custodies hot, funded keys on two chains and spends real money on request.
Running it means accepting that. Its answer to that risk is a single rule that the whole
request path is built around. The engine works hard to say no before it ever says pay, and
every control below serves that order.

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
- **The service keys never leave the environment**, are never logged, and are never written
  to the database. Log output redacts the `Authorization` header so a key cannot leak into a
  log file through a request.
- **The reverse direction is off unless configured.** Stellar to Arc needs `ARC_SECRET_KEY`,
  and without it the deployment refuses that direction with 501 and polls no Arc balance, so
  a service that only ever meant to spend XLM never holds a second hot key.
- **A per-direction low-balance halt** stops a leg when the account paying for it falls below
  its configured floor, without stopping the other leg. The halt fails closed: until the
  first successful balance read for that leg, it reports itself halted and refuses to
  complete anything.
- **Mainnet is opt-in.** The service defaults to testnet, which differs from the SDK's own
  default, and it refuses any request naming a network it is not configured for.

The recipient field deserves one explicit note. The caller supplies it, and the service uses
it only to decide whether a mint is worth attempting. It cannot be used to redirect funds,
because the completion pays whichever address is encoded in the burn message. A wrong
recipient can therefore cause a refused transfer or a wasted submission, but never a payment
to the wrong account. On the Stellar to Arc direction it does not even gate spending, since
there is nothing to verify about an Arc address.

## Configuration

See [`.env.example`](.env.example) for the full list with notes. The values that matter most:

| Variable | Purpose |
| --- | --- |
| `STELLAR_SECRET_KEY` | The funded account that pays the XLM fee. Required. |
| `ARC_SECRET_KEY` | The funded Arc account that pays that chain's gas in native USDC. Optional. Without it, Stellar to Arc is refused with 501 and no Arc balance is polled. |
| `NETWORK` | `testnet` or `mainnet`. Defaults to `testnet`. |
| `STELLAR_RPC_URL` | Soroban RPC override. The mainnet default is rate limited and is not meant for production traffic. |
| `ARC_RPC_URL` | Arc RPC override, for the same reason. |
| `DATABASE_PATH` | Where the key table and ledger live. |
| `XLM_LOW_BALANCE_FLOOR` | Halt threshold for the Stellar-funding account. |
| `USDC_LOW_BALANCE_FLOOR` | Halt threshold for the Arc-funding account, in native USDC. |
| `IP_RATE_LIMIT_PER_MINUTE` | Per-address ceiling covering traffic that presents no key or a malformed body. Defaults to 600. |
| `ATTESTATION_POLL_TIMEOUT_MS` | How long one request waits for Circle before answering 409. Defaults to 30 seconds, well below the SDK's 5 minutes, so a request does not hold a connection open for minutes. |
| `TRUST_PROXY` | Set true only behind a proxy you control, so the per-address limit sees the real client address rather than the proxy's. |

One detail about the Arc floor is worth stating plainly, because it is easy to get wrong.
Arc pays gas in USDC as the chain's native token, and that balance is reported at 18
decimals. The ERC-20 USDC that CCTP mints and burns is the same asset seen through a
6-decimal contract, not a second token: on testnet a native balance of 18.99551755 reads as
18.995517 through the contract, the native figure truncated to six places, and the two move
together through a burn and a settlement. So `USDC_LOW_BALANCE_FLOOR` is measured against
the native balance, and a floor written in the wrong scale is wrong by a factor of a
trillion without failing loudly.

## Development

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest, 85 tests, no network access
pnpm build       # tsup, emits ESM to dist/
pnpm key:create  # provision an API key
pnpm key:list    # list keys and today's usage
```

Tests inject fakes for the two SDK calls that would otherwise reach the network, so the
suite runs offline and never spends anything. `pnpm test` currently passes with 85 tests
across 4 files.

Both directions have been completed against a live testnet burn produced outside the
service, and each settlement was then verified independently of it.

Arc to Stellar. Burn
`0x24d19d7515f72359fa7bb8b066674b1bb7de4c32a0a424d59717641b03f80783` was submitted and
settled as Stellar transaction
`c60dafc3e40bfb65fd72499ce649affa7d030650d66c93fe616b3630de1637e8` in ledger 5056172. The
recipient held 1.0000000 USDC afterwards, with their XLM balance untouched by the mint. The
service account paid 186890 stroops, the ledger row recorded one attempt, and replaying the
same burn returned `replayed: true` without a second submission.

Stellar to Arc. Burn
`a62a448a3b5fb826644f26717c8a2e295ab772af47f337715dfb20ab3aaebb10` was produced by a
`transfer` call with no `destinationSigner`, which leaves the SDK returning a `pending`
transfer and completion to whoever holds the hash. The service completed it in 3.783 seconds
as Arc transaction
`0xed4f8572b9c3c598235edc45844e1e20bba0cdc2a0dc940ad22c3f1ba4cb1081` in block 65830403,
status success, from the service's own Arc key. The receipt was read independently: 186731
gas at 0.000000025 USDC per gas, a fee of 0.004668275 USDC. The recipient's balance read
exactly 0.5 USDC afterwards and the service's native balance fell by exactly the fee.
Replaying the same burn returned `replayed: true` without a second submission.

No mainnet transfer has been run in either direction.

## License

MIT
