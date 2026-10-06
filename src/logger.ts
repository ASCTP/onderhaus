/**
 * The logging surface the service depends on. Kept to a structural interface so the
 * Fastify request logger can be passed straight in without the rest of the code taking a
 * dependency on Fastify itself.
 */

export interface Logger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  debug(obj: Record<string, unknown>, msg?: string): void;
}
