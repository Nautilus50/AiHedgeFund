"use client";

import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useApiClient } from "../../../lib/api-client";
import { StateBadge } from "../../../components/Badge";
import { SourceTag } from "../../../components/Provenance";
import { Alert, Card, CardBody, CardHead, EmptyState } from "../../../components/primitives";

interface ReportUpload {
  id: string;
  kind: string;
  parseStatus: string;
  parseWarnings: string[];
}

interface VerificationDetail {
  id: string;
  strategyVersionId: string;
  status: string;
  requiredSymbol: string;
  requiredTimeframe: string;
  uploads: ReportUpload[];
}

type ReportKind = "LIST_OF_TRADES" | "PERFORMANCE_SUMMARY";

const KIND_LABEL: Record<ReportKind, string> = {
  LIST_OF_TRADES: "List of Trades",
  PERFORMANCE_SUMMARY: "Performance Summary",
};

function UploadRow({
  kind,
  uploading,
  message,
  tone,
  onUpload,
}: {
  kind: ReportKind;
  uploading: boolean;
  message: string | undefined;
  tone: "ok" | "error" | undefined;
  onUpload: (kind: ReportKind, file: File) => void;
}) {
  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) onUpload(kind, file);
  }

  return (
    <div className="field">
      <label htmlFor={`upload-${kind}`}>{KIND_LABEL[kind]} CSV</label>
      <input id={`upload-${kind}`} type="file" accept=".csv,text/csv" disabled={uploading} onChange={handleChange} />
      {uploading && <span className="field-hint">Uploading and parsing…</span>}
      {message && tone && (
        <div style={{ marginTop: "var(--sp-2)" }}>
          <Alert tone={tone}>{message}</Alert>
        </div>
      )}
    </div>
  );
}

export default function VerificationUploadPage() {
  const params = useParams<{ id: string }>();
  const { call } = useApiClient();
  const [verification, setVerification] = useState<VerificationDetail | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [uploading, setUploading] = useState<Partial<Record<ReportKind, boolean>>>({});
  const [message, setMessage] = useState<Partial<Record<ReportKind, { text: string; tone: "ok" | "error" }>>>({});

  const refresh = useCallback(async () => {
    try {
      setVerification(await call<VerificationDetail>(`/v1/verifications/${params.id}`));
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load verification.");
    } finally {
      setLoading(false);
    }
  }, [call, params.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleUpload(kind: ReportKind, file: File) {
    setUploading((p) => ({ ...p, [kind]: true }));
    setMessage((p) => ({ ...p, [kind]: undefined }));

    try {
      const intent = await call<{ uploadUrl: string; objectKey: string }>(
        `/v1/verifications/${params.id}/uploads`,
        { method: "POST", body: JSON.stringify({ kind }) },
      );

      const put = await fetch(intent.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": "text/csv" },
      }).catch(() => {
        // A opaque network failure here is almost always the bucket's CORS
        // policy, which is invisible to the API and to the test suite.
        throw new Error(
          "Upload to storage was blocked by the browser. This usually means the bucket has no CORS policy for this origin — see docs/local-setup.md.",
        );
      });
      if (!put.ok) throw new Error(`Storage rejected the upload (HTTP ${put.status}).`);

      await call(`/v1/verifications/${params.id}/uploads/complete`, {
        method: "POST",
        body: JSON.stringify({ kind, objectKey: intent.objectKey }),
        idempotencyKey: crypto.randomUUID(),
      });

      setMessage((p) => ({ ...p, [kind]: { text: "Uploaded, checksummed, and parsed.", tone: "ok" } }));
      await refresh();
    } catch (e) {
      setMessage((p) => ({
        ...p,
        [kind]: { text: e instanceof Error ? e.message : "Upload failed.", tone: "error" },
      }));
    } finally {
      setUploading((p) => ({ ...p, [kind]: false }));
    }
  }

  if (loading) {
    return (
      <Card>
        <CardBody>
          <div className="stack" aria-busy="true">
            <div className="skeleton" style={{ width: "40%" }} />
            <div className="skeleton" style={{ width: "70%" }} />
            <div className="skeleton" style={{ width: "55%" }} />
            <span className="visually-hidden">Loading verification…</span>
          </div>
        </CardBody>
      </Card>
    );
  }

  if (error || !verification) {
    return <Alert tone="error">{error ?? "Verification not found."}</Alert>;
  }

  return (
    <>
      <Link href={`/strategy-versions/${verification.strategyVersionId}`} className="breadcrumb">
        ← Strategy version
      </Link>

      <div className="page-head">
        <div className="page-title-group">
          <div className="row">
            <h1>TradingView verification</h1>
            <StateBadge state={verification.status} kind="verification" />
            <SourceTag source="TRADINGVIEW" />
          </div>
          <p className="page-subtitle">
            Run this exact configuration in TradingView, then upload the exports. Raw files are preserved
            by checksum before parsing.
          </p>
        </div>
      </div>

      <Card>
        <CardHead title="Required configuration" hint="The exports must come from this exact setup." />
        <CardBody>
          <dl className="dl">
            <dt>Symbol</dt>
            <dd className="mono">{verification.requiredSymbol}</dd>
            <dt>Timeframe</dt>
            <dd className="mono">{verification.requiredTimeframe}</dd>
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHead title="Upload exports" />
        <CardBody>
          <UploadRow
            kind="LIST_OF_TRADES"
            uploading={uploading.LIST_OF_TRADES ?? false}
            message={message.LIST_OF_TRADES?.text}
            tone={message.LIST_OF_TRADES?.tone}
            onUpload={handleUpload}
          />
          <UploadRow
            kind="PERFORMANCE_SUMMARY"
            uploading={uploading.PERFORMANCE_SUMMARY ?? false}
            message={message.PERFORMANCE_SUMMARY?.text}
            tone={message.PERFORMANCE_SUMMARY?.tone}
            onUpload={handleUpload}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHead title="Ingested reports" hint="Parser warnings are shown in full — none are suppressed." />
        {verification.uploads.length === 0 ? (
          <EmptyState title="No uploads yet">Upload an export above to begin ingestion.</EmptyState>
        ) : (
          <CardBody flush>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Report</th>
                    <th>Parse</th>
                    <th>Warnings</th>
                  </tr>
                </thead>
                <tbody>
                  {verification.uploads.map((upload) => (
                    <tr key={upload.id}>
                      <td>{KIND_LABEL[upload.kind as ReportKind] ?? upload.kind}</td>
                      <td>
                        <StateBadge state={upload.parseStatus} kind="parse" />
                      </td>
                      <td>
                        {upload.parseWarnings.length === 0 ? (
                          <span className="unset">none</span>
                        ) : (
                          <ul className="warning-list">
                            {upload.parseWarnings.map((w, i) => (
                              <li key={i}>{w}</li>
                            ))}
                          </ul>
                        )}
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
