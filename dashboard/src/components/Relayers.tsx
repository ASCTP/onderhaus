import type { RelayerStat } from "../types";
import { formatRelative, formatUsdc, shortHash } from "../format";
import { EmptyState } from "./Bits";

export function RelayersTable({ relayers }: { relayers: RelayerStat[] }) {
  if (relayers.length === 0) {
    return (
      <EmptyState title="No relayers recorded yet">
        The permissionless relayer set arrives with the settlement contract. Until then, completed transfers have no
        relayer address and this table stays empty.
      </EmptyState>
    );
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Relayer</th>
            <th>Completed</th>
            <th>Volume</th>
            <th>Last seen</th>
          </tr>
        </thead>
        <tbody>
          {relayers.map((relayer) => (
            <tr key={relayer.relayer}>
              <td className="mono" title={relayer.relayer}>
                {shortHash(relayer.relayer, 8, 6)}
              </td>
              <td>{relayer.completed}</td>
              <td>{formatUsdc(relayer.volumeUsdc)}</td>
              <td title={new Date(relayer.lastSeenAt).toLocaleString()}>{formatRelative(relayer.lastSeenAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
