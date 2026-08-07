export interface MetricsTrade {
  tradeNumber: number;
  direction: "LONG" | "SHORT";
  entryTime: string;
  exitTime?: string | undefined;
  /** Net P&L after fees, in quote currency. Required for closed trades — open trades are excluded from all metrics. */
  netPnl?: number | undefined;
  isOpen: boolean;
}
