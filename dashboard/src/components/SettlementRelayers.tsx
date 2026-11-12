import type { SettlementRelayerStat } from "../types";
import { formatRelative, formatUsdc, shortHash } from "../format";
import { EmptyState } from "./Bits";

export function SettlementRelayersTable({ relayers }: { relayers: SettlementRelayerStat[] }) {
  if (relayers.length === 0) {
    return (
      <EmptyState title="No relayers recorded yet">
        Run the settlement indexer to read relayer activity from the contract.
      </EmptyState>
    );
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Relayer</th>
            <th>Settlements</th>
            <th>Volume</th>
            <th>Fees</th>
            <th>Relayer share</th>
            <th>Treasury share</th>
            <th>Last seen</th>
          </tr>
        </thead>
        <tbody>
          {relayers.map((relayer) => (
            <tr key={relayer.relayer}>
              <td className="mono" title={relayer.relayer}>
                {shortHash(relayer.relayer, 8, 6)}
              </td>
              <td>{relayer.settlements}</td>
              <td>{formatUsdc(relayer.volumeUsdc)}</td>
              <td>{formatUsdc(relayer.feesUsdc)}</td>
              <td>{formatUsdc(relayer.relayerFeesUsdc)}</td>
              <td>{formatUsdc(relayer.treasuryFeesUsdc)}</td>
              <td title={new Date(relayer.lastSeenAt).toLocaleString()}>{formatRelative(relayer.lastSeenAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
