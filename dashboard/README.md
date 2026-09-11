# Strategy Board

Open `index.html` in a browser (double-click it, or serve the folder with any
static server, e.g. `python3 -m http.server` from inside `dashboard/`). Some
browsers (notably Chrome) block a double-clicked page from fetching a local
JSON file due to `file://` security rules — if the list shows a load error,
either use Firefox or run a quick local server as above.

To use your own data, replace `strategies.json` in this folder with a file of
the same name and shape — no other changes are needed.

Data shape (a JSON array, one object per strategy):

```json
[
  {
    "name": "Strategy name",
    "market": "BTCUSDT",
    "timeframe": "1h",
    "metrics": { "netPct": 123.4, "pf": 1.42, "maxDD": 18.7, "trades": 212 },
    "forward_from": "2026-08-30",
    "equity": [[1694322000000, 0], [1694422800000, 4.9]]
  }
]
```

`forward_from` (optional, ISO date) marks where forward-test data begins.
`equity` is `[unix ms, cumulative % return]` pairs; omit or leave empty to
show "no curve recorded". Missing `metrics` fields show as a dash.
