"use client";

import { useEffect, useState, type ChangeEvent } from "react";
import { useParams } from "next/navigation";
import { useApiClient } from "../../../lib/api-client";

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

function UploadWidget({
  kind,
  label,
  uploading,
  message,
  onUpload,
}: {
  kind: ReportKind;
  label: string;
  uploading: boolean;
  message: string | undefined;
  onUpload: (kind: ReportKind, file: File) => void;
}) {
  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) {
      onUpload(kind, file);
    }
  }

  return (
    <div>
      <label>
        {label}
        <input type="file" accept=".csv,text/csv" disabled={uploading} onChange={handleChange} />
      </label>
      {uploading && <span> Uploading…</span>}
      {message && <p>{message}</p>}
    </div>
  );
}

export default function VerificationUploadPage() {
  const params = useParams<{ id: string }>();
  const { call } = useApiClient();
  const [verification, setVerification] = useState<VerificationDetail | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [uploading, setUploading] = useState<Partial<Record<ReportKind, boolean>>>({});
  const [uploadMessage, setUploadMessage] = useState<Partial<Record<ReportKind, string>>>({});

  async function refresh() {
    try {
      const data = await call<VerificationDetail>(`/v1/verifications/${params.id}`);
      setVerification(data);
      setError(undefined);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Failed to load verification.");
    }
  }

  useEffect(() => {
    void refresh();
  }, [params.id]);

  async function handleUpload(kind: ReportKind, file: File) {
    setUploading((prev) => ({ ...prev, [kind]: true }));
    setUploadMessage((prev) => ({ ...prev, [kind]: undefined }));

    try {
      const intent = await call<{ uploadUrl: string; objectKey: string }>(`/v1/verifications/${params.id}/uploads`, {
        method: "POST",
        body: JSON.stringify({ kind }),
      });

      const putResponse = await fetch(intent.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": "text/csv" },
      });
      if (!putResponse.ok) {
        throw new Error(`Upload to storage failed with status ${putResponse.status}.`);
      }

      await call(`/v1/verifications/${params.id}/uploads/complete`, {
        method: "POST",
        body: JSON.stringify({ kind, objectKey: intent.objectKey }),
        idempotencyKey: crypto.randomUUID(),
      });

      setUploadMessage((prev) => ({ ...prev, [kind]: "Uploaded and parsed." }));
      await refresh();
    } catch (uploadError) {
      setUploadMessage((prev) => ({
        ...prev,
        [kind]: uploadError instanceof Error ? uploadError.message : "Upload failed.",
      }));
    } finally {
      setUploading((prev) => ({ ...prev, [kind]: false }));
    }
  }

  if (error) {
    return (
      <main>
        <p role="alert">{error}</p>
      </main>
    );
  }

  if (!verification) {
    return (
      <main>
        <p>Loading…</p>
      </main>
    );
  }

  return (
    <main>
      <h1>TradingView Verification</h1>
      <dl>
        <dt>Symbol</dt>
        <dd>{verification.requiredSymbol}</dd>
        <dt>Timeframe</dt>
        <dd>{verification.requiredTimeframe}</dd>
        <dt>Status</dt>
        <dd>{verification.status}</dd>
      </dl>

      <UploadWidget
        kind="LIST_OF_TRADES"
        label="List of Trades CSV"
        uploading={uploading.LIST_OF_TRADES ?? false}
        message={uploadMessage.LIST_OF_TRADES}
        onUpload={handleUpload}
      />
      <UploadWidget
        kind="PERFORMANCE_SUMMARY"
        label="Performance Summary CSV"
        uploading={uploading.PERFORMANCE_SUMMARY ?? false}
        message={uploadMessage.PERFORMANCE_SUMMARY}
        onUpload={handleUpload}
      />

      <h2>Uploads</h2>
      {verification.uploads.length === 0 ? (
        <p>No uploads yet.</p>
      ) : (
        <ul>
          {verification.uploads.map((upload) => (
            <li key={upload.id}>
              {upload.kind}: {upload.parseStatus}
              {upload.parseWarnings.length > 0 ? ` (${upload.parseWarnings.join("; ")})` : ""}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
