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
directions, both directions have been exercised end to end on testnet, and a public
read-only dashboard now reads settlement events from the testnet settlement contract. Arc to
Stellar has since been completed on mainnet against a funded account, and Stellar to Arc has
not. There is no hosted instance. See [Scope](#scope) for the precise boundary.

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

### Funding the accounts on testnet

The service halts until each paying account is funded, so a fresh checkout needs funded
accounts before `/readyz` reports ready.

- The Stellar account named by `STELLAR_SECRET_KEY` needs testnet XLM. Stellar's Friendbot
  funds a testnet account: `curl "https://friendbot.stellar.org/?addr=<G...public key>"`.
- The Arc account named by `ARC_SECRET_KEY`, only for the reverse direction, needs testnet
  Arc gas, which is native USDC. There is no Friendbot equivalent for Arc, so obtain testnet
  funds for that account from the Arc testnet faucet or provider you use.

### Preparing a test recipient on Stellar

Only Stellar-destination transfers need a prepared recipient; an Arc address needs nothing.
A Stellar recipient must exist on-ledger and hold a USDC trustline, both signed for by the
recipient, not by this service. For a test account, fund it with Friendbot as above to
activate it, then have that account add a USDC trustline with a `change_trust` operation for
the testnet USDC asset. Until both are done, `/v1/complete` refuses that recipient with 422
`recipient_not_ready` and spends nothing.

Check whether it considers itself able to work:

```bash
curl -s localhost:3000/healthz   # {"status":"ok"}
curl -s localhost:3000/readyz    # see the shape below, or 503 when nothing works
curl -s localhost:3000/v1/status -H "Authorization: Bearer $ONDERHAUS_KEY"
```

`/healthz` is liveness and stays 200 whenever the process is running. `/readyz` is readiness,
and it reports each direction separately because each is paid for by a different account. It
answers `ready` when every configured direction is funded, `degraded` when some are and some
are not, and 503 `halted` only when the service can serve nothing at all. Both probes answer
without a key, and neither returns a balance figure, which stays behind the key on
`/v1/status`.

`/readyz` returns the network the instance serves and a `directions` object naming each
direction and whether it is ready, so a client can tell up front which network and which
legs it can use without provoking a 400:

```json
{
  "status": "degraded",
  "network": "testnet",
  "directions": { "arc->stellar": "ready", "stellar->arc": "halted" }
}
```

The 503 body carries the same `status`, `network`, and `directions` fields plus a `reason`
string.

## Public dashboard

`dashboard/` is a separate Vite and React app that reads indexed events from the settlement
contract. It shows what an explorer would: settlements, volume, fees, relayer share,
treasury share, message ids, and relayers. The service ledger routes remain available for
the legacy paymaster, but the dashboard now treats the chain as the source of truth.

```bash
pnpm install
pnpm dev            # API on :3000
pnpm settlement:index -- --contract C...
pnpm dashboard:dev  # dashboard on :5173, proxying /v1 to the API
```

The indexer stores a cursor next to the settlements, so a restart resumes from the last
processed event instead of rescanning the retention window. Pass `--once` for a single pass.
The public routes need no key and are bounded by the same per-address limiter as everything
else:

| Route | Returns |
| --- | --- |
| `GET /v1/public/stats` | Legacy paymaster totals, success rate, USDC volume, fees by unit, latency, relayers, and 14 daily points. |
| `GET /v1/public/transfers` | A page of legacy paymaster transfers, filterable by `direction`, `status`, `limit`, and `offset`. |
| `GET /v1/public/transfers/:burnTxHash` | One legacy transfer, or 404. |
| `GET /v1/public/relayers` | Legacy completed transfers and volume grouped by relayer. |
| `GET /v1/public/settlement-stats` | Settlement totals, volume, fees, relayer and treasury shares, and 14 daily points. |
| `GET /v1/public/settlements` | A page of indexed settlements, filterable by `relayer`, `recipient`, `sourceDomain`, `limit`, and `offset`. |
| `GET /v1/public/settlements/:sourceDomain/:nonce` | One settlement, or 404. |
| `GET /v1/public/settlement-relayers` | Indexed settlements, volume, and fee shares grouped by relayer. |

Service balances and API keys stay behind a key on `/v1/status`. The dashboard's Operator tab
asks for that key and keeps it in `sessionStorage` for the tab only.

`pnpm dashboard:build` emits static files to `dashboard/dist/`. Point it at a non-default API
with `VITE_API_BASE` at build time. The dashboard does not invent Arc explorer links, because
the Arc explorer base is not guaranteed; hashes stay copyable instead.

The service ledger only knows what it completed itself. Import a transfer completed elsewhere,
or before the read model existed, with a JSON array or newline-delimited objects:

```bash
pnpm transfer:import -- --file transfers.json --network testnet
```

Re-importing the same burn hash on the same network updates the row rather than duplicating
it.

## Settlement contract

`contracts/settlement` is the on-chain half of the trustless path. The sender burns USDC
through CCTP with the settlement contract as the mint recipient and destination caller, and
carries the recipient and the agreed fee in the hook. Anyone may call `settle`; the contract
receives the mint, pays the relayer its share, pays the treasury its share, and forwards the
rest to the recipient in one transaction. The fee split and the maximum fee are fixed in the
constructor and there is no admin surface.

The testnet deployment used for the dashboard is
`CARSIIMF4ERN5V2TTTQT4ACFFKJKKDZAD4RLV64B6D2I5S4UDFHPQN2R` with a 70/30 relayer/treasury
split and a 500 bps maximum fee. The `settled` event carries the source domain and the CCTP
nonce, which is what lets the indexer identify a settlement independently of the Stellar
transaction that submitted it.

A relayer with a funded XLM account and a USDC trustline can settle a burn:

```bash
pnpm exec tsx scripts/relay.ts \
  --contract CARSIIMF4ERN5V2TTTQT4ACFFKJKKDZAD4RLV64B6D2I5S4UDFHPQN2R \
  --burn 0x...
```

The command reads the contract configuration, waits for the Iris attestation, refuses a
payout below `--min-payout` (0.005 USDC by default), checks that the message mints to this
contract and targets the expected Stellar token messenger, and then submits `settle`. The
relayer address is passed as an argument and must sign the transaction, so a settlement
cannot redirect the relayer fee to an address that did not authorize it.

## Producing the burn to complete

Onderhaus only finishes a transfer. The integrating app produces the input, the `burnTxHash`,
by burning through CCTP with Parabola first. The one requirement is to leave the completion
open: call Parabola's `transfer()` without a `destinationSigner`, so the SDK burns on the
source chain, stops, and returns `status: "pending"` with the `burnTxHash` to hand on.

```ts
import { transfer } from "@asctp/parabola";

// signer is a source-chain signer built the way Parabola's own README shows: a StellarSigner
// from a Keypair when burning on Stellar, an ArcSigner wrapping a viem WalletClient on Arc.
const result = await transfer({
  from: "arc",
  to: "stellar",
  amount: "1.0",
  recipient: "GBZX...the Stellar recipient...",
  speed: "standard",
  signer,
  network: "testnet",
  // No options.destinationSigner, so the SDK leaves the mint for Onderhaus.
});

// result.status === "pending", result.burnTxHash is what you send to /v1/complete.
```

Pass `result.burnTxHash` and the same `recipient` to `/v1/complete`. Signer construction is
Parabola's surface rather than this service's, so see the Parabola README for it.

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
encoded, so it passes that back. The value is advisory. The service reads the true recipient out
of the burn message and pays that address regardless, so the field cannot redirect funds. It is
used only to confirm the destination can receive before spending. If it disagrees with the
address in the burn, the effect is a wasted or refused attempt, never a payment to the wrong
account: on Arc to Stellar a stale `recipient` can cause a false `recipient_not_ready`, and on
Stellar to Arc the field only lands on the ledger and does not gate spending at all.

A successful completion returns the destination transaction hash:

```json
{ "mintTxHash": "...", "attestationHash": "...", "replayed": false }
```

If the same `burnTxHash` is submitted again by the same key on the same network, the service
returns the recorded result with `replayed: true` rather than submitting a second time.
Idempotency is keyed on the API key, the burn hash, and the network together, so the same burn
presented under a different key is not deduplicated against the first, which matters only for a
caller fronting several keys. A burn whose earlier attempt failed is not treated as done; it
can be retried and will be submitted again.

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
unknown. The transaction was broadcast and may still land, so the caller should check it
before retrying. Retrying is not dangerous, because CCTP rejects a message that has already
been used, but it costs another fee to find that out.

Every error shares one envelope. The body is an `error` object carrying the `code` from the
table, a human `message`, and a `retryable` boolean a client can branch on directly instead
of maintaining its own list of which codes are safe to repeat:

```json
{ "error": { "code": "attestation_pending", "message": "Circle has not attested burn ... yet. Retry the same request in a few seconds.", "retryable": true } }
```

On the submission-timeout 502, and only there, the object also carries a `txHash` field with
the broadcast transaction's hash, so a caller can check that transaction without parsing it
out of the message:

```json
{ "error": { "code": "upstream_error", "message": "The completion transaction was broadcast as 0x... but confirmation did not arrive in time. It may still land; check that hash before retrying.", "retryable": true, "txHash": "0x..." } }
```

### Calling from a browser

The API key is a bearer secret that can spend the service's funds, so the primary integration
path is server to server, with the key held on a backend and never shipped to a browser. A
frontend that needs completions should call its own backend, which holds the key and calls
Onderhaus. There is no scoped or publishable key today, so a key placed in client code is a
spendable secret exposed to every visitor.

For the browser cases that are safe, such as reading the probes, the service returns
`Access-Control-Allow-Origin: *`. Because the key travels in the `Authorization` header rather
than a cookie, a cross-origin request is uncredentialed in CORS terms, so the wildcard exposes
nothing a caller could not already reach, and no integrator has to be added to an allow-list by
hand. A browser request blocked for any other reason surfaces as a generic `TypeError: Failed
to fetch`, which a client cannot tell apart from the host being down.

## Scope

Built:

- An authenticated HTTP service that completes CCTP transfers in both directions
- A testnet settlement contract that receives the CCTP mint, splits the fee between the
  relayer and the treasury, and forwards the remainder to the recipient
- A permissionless relayer CLI with a payout floor and message-target validation
- A cursor-based settlement indexer and a dashboard and public API over its events
- Pre-spend verification that a Stellar recipient exists and holds a USDC trustline
- Per-direction balance monitoring on whichever account pays for a leg, with an independent
  low-balance halt on each
- Per-key API keys, rate limiting, daily spend caps, and a metered usage ledger that records
  the direction each row was for
- Idempotent completion keyed on the burn hash, so a retry does not resubmit
- A public, read-only transfer API and a React dashboard over it

Not built:

- A production relayer network, a mainnet settlement deployment, and a hosted public
  instance
- A mainnet run in the Stellar to Arc direction. Arc to Stellar has been completed on
  mainnet, but the reverse has only ever run on testnet.
- Batch submission. Each completion or settlement is one transaction.

## Fee model

There are two paths today. The settlement contract charges its fee on chain at settlement
time. The sender puts the fee in the burn hook, the contract takes it from the minted amount,
pays 70 percent to the relayer and 30 percent to the treasury by default, and forwards the
rest to the recipient. No API key is involved and no invoice is sent.

On the legacy paymaster path, every completion spends real money from whichever service
account pays for that direction, XLM from the Stellar-funded account and native USDC from the
Arc-funded one, so access is metered rather than open. Each integrating app gets an API key
carrying a per-minute rate limit and an optional daily cap, and every completion is written
to a local ledger holding the API key, the burn hash, the direction, the recipient, and the
outcome.

Payment on that legacy path is off-band. Usage is invoiced on a cycle you set, and nothing
enforces payment on-chain, so the model rests on the integrator paying. That ledger is both
the billing record and the idempotency guard, since it is unique on the API key, the burn
hash, and the network together. The direction is deliberately not part of that key, which is
safe because the two hash formats cannot collide: a Stellar hash is bare and an Arc one
carries the `0x` prefix, so the same text is never valid for both legs.

The contract path removes the off-band invoice and the API key from the settlement leg. The
relayer fee is a public on-chain number, fixed per deployment, and any funded account with a
USDC trustline can submit the settlement and claim it. The next step is competitive
relaying, where the fee can vary rather than being fixed in the constructor.

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
| `SETTLEMENT_CONTRACT_ID` | The contract whose events the indexer reads. Required by `pnpm settlement:index`. |
| `SETTLEMENT_START_LEDGER` | Optional first ledger for a fresh index. Empty backfills the last 10000 ledgers, then the stored cursor takes over. |
| `SETTLEMENT_POLL_INTERVAL_MS` | Indexer polling interval. Defaults to 5000. |
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
pnpm typecheck           # tsc --noEmit
pnpm test                # vitest, offline, no network access
pnpm build               # tsup, emits ESM to dist/
pnpm key:create          # provision an API key
pnpm key:list            # list keys and today's usage
pnpm transfer:import     # import legacy settlement events into the read model
pnpm settlement:index    # index settlement contract events
pnpm dashboard:dev       # dashboard dev server
pnpm dashboard:typecheck # dashboard tsc --noEmit
pnpm dashboard:build     # static dashboard build
```

Tests inject fakes for the two SDK calls that would otherwise reach the network, so the
suite runs offline and never spends anything. `pnpm test` currently passes with 138 tests
across 7 files.

Both directions have been completed against a live testnet burn produced outside the
service, and each settlement was then verified independently of it. In both cases the
recipient's balance rose by the transferred amount, the recipient's own XLM went untouched,
and replaying the same burn returned `replayed: true` without a second submission.

One detail on the Stellar to Arc leg is worth keeping. Its burn came from a `transfer` call
with no `destinationSigner`, which leaves the SDK returning a `pending` transfer and
completion to whoever holds the hash. The service completed it from its own Arc key, and the
fee it paid in native USDC matched the fall in that account's balance exactly, read
independently of the service.

Arc to Stellar has since been completed on mainnet against a funded account. The service
account paid the XLM fee there and the Arc account went untouched.

No mainnet transfer has been run in the Stellar to Arc direction.

## License

MIT
