/**
 * Fixed-point conversion shared by both chains.
 *
 * Stellar reports XLM with 7 decimal places and Arc reports its native USDC with 18, so
 * the same two operations are needed twice at a different scale. Both are written with
 * integer math only. A balance comparison decides whether the service halts, and a floor
 * expressed as a float is a halt that fires at the wrong moment.
 */

/**
 * A value that could not be read at the asset's scale. Deliberately not a ConfigError:
 * this module is used for rendering figures read back from a chain as well as for parsing
 * configured ones, and only the config layer should be able to claim a value is misconfigured.
 */
export class AmountFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmountFormatError";
  }
}

/**
 * Parses a human decimal string such as "5" or "2.5" into its smallest unit. Rejects more
 * decimal places than the asset has rather than rounding, because silently dropping
 * precision from a configured floor changes the number the operator wrote.
 */
export function parseFixed(amount: string, decimals: number, label: string): bigint {
  const trimmed = amount.trim();
  const pattern = new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`);
  if (!pattern.test(trimmed)) {
    throw new AmountFormatError(
      `${label} must be a decimal with at most ${decimals} places, got ${JSON.stringify(amount)}`,
    );
  }
  const [whole = "0", fraction = ""] = trimmed.split(".");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0"));
}

/**
 * Renders a smallest-unit integer as a decimal string. A value read back from a chain can
 * carry more places than the asset's display precision, so any excess is truncated rather
 * than rounded, which keeps a rendered figure from ever exceeding the real one.
 */
export function formatFixed(amount: bigint, decimals: number): string {
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(decimals, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * Adds human decimal strings without floating point. The scale is the widest fraction in
 * the input, because the ledger can hold values from two chains at different precisions
 * and a sum must not silently drop the finer one. Non-numeric entries are skipped rather
 * than throwing, since this feeds a dashboard and a single bad row should not blank it.
 */
export function sumDecimals(values: Iterable<string>): string {
  const list = [...values];
  let scale = 0;
  for (const value of list) {
    const dot = value.trim().indexOf(".");
    if (dot !== -1) scale = Math.max(scale, value.trim().length - dot - 1);
  }
  if (scale === 0) {
    let total = 0n;
    for (const value of list) {
      const trimmed = value.trim();
      if (/^\d+$/.test(trimmed)) total += BigInt(trimmed);
    }
    return total.toString();
  }

  const factor = 10n ** BigInt(scale);
  let total = 0n;
  for (const value of list) {
    const match = /^(\d+)(?:\.(\d*))?$/.exec(value.trim());
    if (!match) continue;
    const whole = match[1] ?? "0";
    const fraction = (match[2] ?? "").padEnd(scale, "0");
    total += BigInt(whole) * factor + BigInt(fraction);
  }
  return formatFixed(total, scale);
}
