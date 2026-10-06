/**
 * HTTP surface. This layer does four things and nothing else: authenticate the caller,
 * apply the rate limit, hand the request to the Paymaster, and map a thrown
 * PaymasterError onto a status code. Every spending decision lives in paymaster.ts.
 *
 * Authentication is mandatory and has no bypass route. The only unauthenticated endpoints
 * are the two probes, which reveal nothing beyond whether the process is up and whether it
 * is willing to accept work.
 *
 * Rate limiting is split across two hooks rather than living in the handlers. Both hooks
 * run before schema validation, because a limiter that only ever sees well-formed requests
 * from authenticated callers is trivially bypassed by sending neither.
 *
 * Creation is split from route registration because the logger is owned by the Fastify
 * instance, and the balance monitor needs a logger before the routes that report on it
 * can be registered.
 */

import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import type { ApiKeyRecord } from "./db.js";
import { Store, hashApiKey } from "./db.js";
import type { Config } from "./config.js";
import type { Direction, Paymaster } from "./paymaster.js";
import type { BalanceSource } from "./balance-monitor.js";
import { PaymasterError, RateLimitedError, UnauthorizedError } from "./errors.js";

/**
 * Probe endpoints are polled continuously by load balancers and uptime monitors, usually
 * from a small set of addresses, so charging them against a rate limit would take the
 * service out of rotation during the very incident the probes exist to detect.
 */
const PROBE_PATHS = new Set(["/healthz", "/readyz"]);

function pathOf(url: string): string {
  const query = url.indexOf("?");
  return query === -1 ? url : url.slice(0, query);
}

/** Fixed one-minute windows, matching the per-key limiter. */
function windowStartSeconds(): number {
  return Math.floor(Date.now() / 1000 / 60) * 60;
}

/**
 * One leg of the service, as the probes and the status endpoint report it. The server holds
 * no knowledge of which chains these are, only how to render whatever a leg says its unit
 * is, which is what lets the same code report XLM at 7 places and native USDC at 18 without
 * a branch on either.
 */
export interface RouteLeg {
  readonly direction: Direction;
  /** The asset this leg spends. Used in probes and status responses. */
  readonly unit: string;
  /** The account that pays for this leg, which is also the account being watched. */
  readonly account: string;
  readonly monitor: BalanceSource;
  /** Renders a raw on-chain amount for this leg into a human string. */
  readonly format: (amount: bigint) => string;
}

export interface RouteDeps {
  readonly config: Config;
  readonly store: Store;
  readonly paymaster: Paymaster;
  readonly legs: readonly RouteLeg[];
}

/**
 * The body schema rejects only what could never be valid for either direction. The precise
 * per-direction checks, a 0x-prefixed hash for an Arc burn and a bare one for a Stellar
 * burn, depend on which direction the request is for, which this schema cannot express, so
 * they live in Paymaster.validate where the direction has already been resolved. Splitting
 * the same rule across both places would only give two of them to keep in step.
 */
const completeBodySchema = {
  type: "object",
  required: ["burnTxHash", "from", "to", "recipient"],
  additionalProperties: false,
  properties: {
    // 64 hex characters bare on Stellar, 66 with the 0x prefix on Arc.
    burnTxHash: { type: "string", minLength: 64, maxLength: 66 },
    from: { type: "string" },
    to: { type: "string" },
    // 42 characters for an Arc address, 56 for a Stellar one.
    recipient: { type: "string", minLength: 42, maxLength: 56 },
    network: { type: "string", enum: ["mainnet", "testnet"] },
  },
} as const;

function extractApiKey(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && authorization.toLowerCase().startsWith("bearer ")) {
    const value = authorization.slice(7).trim();
    if (value !== "") return value;
  }
  const header = request.headers["x-api-key"];
  if (typeof header === "string" && header.trim() !== "") return header.trim();
  return undefined;
}

export function createApp(config: Config): FastifyInstance {
  return Fastify({
    logger: {
      level: config.logLevel,
      // The API key is a bearer credential. Redacting it at the logger means no route,
      // error path, or future code change can write one to disk by accident.
      redact: {
        paths: ["req.headers.authorization", "req.headers['x-api-key']", "headers.authorization"],
        censor: "[redacted]",
      },
    },
    trustProxy: config.trustProxy,
    bodyLimit: 16 * 1024,
    ajv: {
      customOptions: {
        // Fastify defaults to removeAdditional: true, which silently drops unknown body
        // fields instead of reporting them. The schema below sets additionalProperties to
        // false, and the intent is to tell a caller their request was malformed rather
        // than to accept a body while quietly ignoring part of it.
        removeAdditional: false,
      },
    },
  });
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { config, store, paymaster, legs } = deps;

  /** Resolves the caller from the presented key. Throws rather than returning undefined. */
  function authenticate(request: FastifyRequest): ApiKeyRecord {
    const presented = extractApiKey(request);
    if (!presented) {
      throw new UnauthorizedError("Provide an API key in the Authorization: Bearer header or the x-api-key header.");
    }
    const record = store.findApiKeyByHash(hashApiKey(presented));
    if (!record) {
      throw new UnauthorizedError("The presented API key is not recognized.");
    }
    if (record.disabled) {
      throw new UnauthorizedError("The presented API key has been disabled.");
    }
    return record;
  }

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof PaymasterError) {
      return reply
        .code(error.status)
        .send({ error: { code: error.code, message: error.message, retryable: error.retryable } });
    }
    if (error.validation) {
      return reply.code(400).send({
        error: {
          code: "validation_error",
          message: `Request body is not valid: ${error.message}`,
          retryable: false,
        },
      });
    }
    request.log.error({ err: error.message }, "unhandled error while serving a request");
    return reply
      .code(500)
      .send({ error: { code: "internal_error", message: "An unexpected error occurred.", retryable: false } });
  });

  // Registered as an onRequest hook because onRequest runs before schema validation and
  // before authentication. In a handler this would be skipped by any request lacking a
  // valid key or a well-formed body, which is precisely the traffic worth bounding.
  app.addHook("onRequest", async (request) => {
    if (PROBE_PATHS.has(pathOf(request.url))) return;
    const allowed = store.consumeIpRateLimit(request.ip, windowStartSeconds(), config.ipRateLimitPerMinute);
    if (!allowed) {
      throw new RateLimitedError(
        `Rate limit of ${config.ipRateLimitPerMinute} requests per minute exceeded for ${request.ip}.`,
      );
    }
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  /**
   * Readiness, as distinct from liveness. Liveness answers whether the process is running,
   * this answers whether it should be sent work. A halted service still answers /healthz
   * with 200 because the process itself is healthy, and answers /readyz with 503 only when
   * it can serve nothing at all.
   *
   * Readiness is judged per leg, because a leg is only usable while the account that pays
   * for it is funded. A service whose XLM has run low can still complete Stellar to Arc
   * transfers, and reporting that as unready would pull a working capability out of
   * rotation. So the probe fails only when every leg is down, and when it does not it names
   * which directions are serviceable so the partial case is visible rather than implied.
   *
   * No balance figure is returned. The endpoint is unauthenticated and a probe needs only
   * the verdict, so the amounts stay behind the key on /v1/status.
   */
  app.get("/readyz", async (_request, reply) => {
    const report = legs.map((leg) => {
      const snapshot = leg.monitor.snapshot();
      return { direction: leg.direction, unit: leg.unit, halted: snapshot.halted, lastError: snapshot.lastError };
    });
    const directions = Object.fromEntries(report.map((leg) => [leg.direction, leg.halted ? "halted" : "ready"]));

    if (report.every((leg) => leg.halted)) {
      const reason = report
        .map(
          (leg) =>
            leg.lastError ??
            `The service ${leg.unit} balance is at or below the configured floor, or has not been read successfully yet.`,
        )
        .join(" ");
      return reply.code(503).send({ status: "halted", reason, directions });
    }

    return {
      status: report.some((leg) => leg.halted) ? "degraded" : "ready",
      directions,
    };
  });

  app.post(
    "/v1/complete",
    {
      schema: { body: completeBodySchema },
      onRequest: async (request) => {
        // Before validation as well, so a caller cannot escape its own budget by sending a
        // body the schema rejects. A request presenting no usable key is left to the per-IP
        // limiter above rather than being charged to a key that does not exist.
        const presented = extractApiKey(request);
        if (!presented) return;
        const record = store.findApiKeyByHash(hashApiKey(presented));
        if (record && !record.disabled) paymaster.assertWithinRateLimit(record);
      },
    },
    async (request, reply) => {
      const apiKey = authenticate(request);
      const body = request.body as {
        burnTxHash: string;
        from: string;
        to: string;
        recipient: string;
        network?: string;
      };
      const result = await paymaster.complete(apiKey, body);
      return reply.code(200).send(result);
    },
  );

  app.get("/v1/status", async (request) => {
    const apiKey = authenticate(request);
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);

    return {
      network: config.network,
      legs: legs.map((leg) => {
        const snapshot = leg.monitor.snapshot();
        return {
          direction: leg.direction,
          unit: leg.unit,
          account: leg.account,
          balance: snapshot.amount === null ? null : leg.format(snapshot.amount),
          floor: leg.format(snapshot.floor),
          halted: snapshot.halted,
          lastCheckedAt: snapshot.lastCheckedAt,
          lastError: snapshot.lastError,
        };
      }),
      usage: {
        mintsToday: store.countBillableMintsSince(apiKey.id, startOfDay.toISOString()),
        dailyMintCap: apiKey.dailyMintCap,
        rateLimitPerMinute: apiKey.rateLimitPerMinute,
      },
      mints: store.countMintsByStatus(),
    };
  });

  app.setNotFoundHandler((_request: FastifyRequest, reply: FastifyReply) => {
    return reply
      .code(404)
      .send({ error: { code: "not_found", message: "No such endpoint.", retryable: false } });
  });
}
