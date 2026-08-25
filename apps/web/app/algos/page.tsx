import Link from "next/link";
import { Badge } from "../../components/Badge";
import { Alert, Card, CardBody, CardHead, EmptyState, Timestamp } from "../../components/primitives";
import { SCOPE_LABEL, formatPct } from "../../lib/algo-display";
import { listAlgos } from "../../lib/algo-library";

const MARKETS = ["CRYPTO", "INDEX_FUTURES", "FX", "COMMODITIES", "EQUITIES"] as const;
const STATUSES = ["DRAFT", "PUBLISHED", "RETIRED"] as const;

const STATUS_TONE = { DRAFT: "neutral", PUBLISHED: "ok", RETIRED: "warn" } as const;

interface AlgoLibrarySearchParams {
  status?: string;
  marketCategory?: string;
  symbol?: string;
  timeframe?: string;
}

export default async function AlgoLibraryPage({
  searchParams,
}: {
  searchParams: Promise<AlgoLibrarySearchParams>;
}) {
  const params = await searchParams;
  const hasFilter = Boolean(params.status || params.marketCategory || params.symbol || params.timeframe);
  const result = await listAlgos(params);

  return (
    <>
      <Link href="/" className="breadcrumb">
        ← Command Centre
      </Link>

      <div className="page-head">
        <div className="page-title-group">
          <h1>Algo Library</h1>
          <p className="page-subtitle">
            The algos that made it through: each one pinned to an immutable strategy version, with the evidence that
            version actually produced.
          </p>
        </div>
      </div>

      <Card>
        <CardHead
          title="Filters"
          hint="Headline figures show the strongest available evidence — forward paper over out-of-sample over in-sample."
        />
        <CardBody>
          <form
            method="get"
            key={new URLSearchParams(params as Record<string, string>).toString()}
            className="field-row"
            style={{ flexWrap: "wrap", alignItems: "flex-end" }}
          >
            <div className="field">
              <label htmlFor="status">Status</label>
              <select id="status" name="status" defaultValue={params.status ?? ""}>
                <option value="">Any</option>
                {STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="marketCategory">Market</label>
              <select id="marketCategory" name="marketCategory" defaultValue={params.marketCategory ?? ""}>
                <option value="">Any</option>
                {MARKETS.map((market) => (
                  <option key={market} value={market}>
                    {market.replace("_", " ")}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="symbol">Symbol</label>
              <input id="symbol" name="symbol" defaultValue={params.symbol ?? ""} placeholder="BTCUSD" />
            </div>
            <div className="field">
              <label htmlFor="timeframe">Timeframe</label>
              <input id="timeframe" name="timeframe" defaultValue={params.timeframe ?? ""} placeholder="60" />
            </div>
            <div className="field" style={{ marginBottom: "var(--sp-4)" }}>
              <button type="submit" className="btn btn-primary">
                Apply
              </button>
            </div>
            {hasFilter && (
              <div className="field" style={{ marginBottom: "var(--sp-4)" }}>
                <Link href="/algos" className="btn">
                  Clear filters
                </Link>
              </div>
            )}
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHead title="Algos" />
        {"error" in result ? (
          <CardBody>
            <Alert tone="error">Could not load the library. {result.error.message}</Alert>
          </CardBody>
        ) : result.data.items.length === 0 ? (
          <EmptyState title={hasFilter ? "No algos match these filters" : "No algos catalogued yet"}>
            {hasFilter ? (
              <Link href="/algos">Clear filters</Link>
            ) : (
              "An algo is catalogued from a PAPER_APPROVED strategy version — take one through the research lifecycle first."
            )}
          </EmptyState>
        ) : (
          <CardBody flush>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Algo</th>
                    <th>Market</th>
                    <th>Status</th>
                    <th>Evidence</th>
                    <th>Net return</th>
                    <th>Max DD</th>
                    <th>Trades</th>
                    <th>Published (UTC)</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.items.map((algo) => (
                    <tr key={algo.algoId}>
                      <td>
                        <div className="row" style={{ gap: "var(--sp-2)", alignItems: "baseline" }}>
                          <Link href={`/algos/${algo.slug}`}>{algo.name}</Link>
                          {/* pickHeadline (catalogue.ts) always prefers FORWARD_PAPER over any
                              backtest scope, so this badge and the headline number are never out
                              of sync — if it's showing, the number beside it is forward-paper. */}
                          {algo.headline?.scope === "FORWARD_PAPER" && <Badge tone="ok">Forward tested</Badge>}
                        </div>
                        {algo.tagline && <div className="card-hint">{algo.tagline}</div>}
                      </td>
                      <td>
                        {algo.symbol} · {algo.timeframe}
                      </td>
                      <td>
                        <Badge tone={STATUS_TONE[algo.status]}>{algo.status}</Badge>
                      </td>
                      {/* The scope label travels with the number, always. */}
                      <td>{algo.headline ? SCOPE_LABEL[algo.headline.scope] : <span className="unset">none</span>}</td>
                      <td className="num">
                        {algo.headline ? formatPct(algo.headline.netProfitPct) : <span className="unset">—</span>}
                      </td>
                      <td className="num">
                        {algo.headline ? formatPct(algo.headline.maxDrawdownPct) : <span className="unset">—</span>}
                      </td>
                      <td className="num">
                        {algo.headline ? algo.headline.tradeCount : <span className="unset">—</span>}
                      </td>
                      <td>
                        {algo.publishedAt ? <Timestamp value={algo.publishedAt} /> : <span className="unset">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody>
        )}
      </Card>
    </>
  );
}
