"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { apiFetch } from "../../../lib/api";

export interface ActionState {
  error?: string;
  success?: string;
}

export async function saveDefinitionAction(
  strategyVersionId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const raw = String(formData.get("definition") ?? "");
  let definition: unknown;
  try {
    definition = JSON.parse(raw);
  } catch {
    return { error: "Definition must be valid JSON." };
  }

  try {
    await apiFetch(`/v1/strategy-versions/${strategyVersionId}/definition`, {
      method: "PUT",
      body: JSON.stringify(definition),
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to save definition." };
  }

  return { success: "Strategy definition saved." };
}

export async function savePineAction(
  strategyVersionId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const source = String(formData.get("source") ?? "");
  const manifestRaw = String(formData.get("manifest") ?? "{}");

  if (!source.trim()) {
    return { error: "Pine source is required." };
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch {
    return { error: "Manifest must be valid JSON." };
  }

  try {
    await apiFetch(`/v1/strategy-versions/${strategyVersionId}/pine`, {
      method: "PUT",
      body: JSON.stringify({ source, manifest }),
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to save Pine revision." };
  }

  return { success: "Pine revision saved." };
}

export async function requestVerificationAction(
  strategyVersionId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const requiredSymbol = String(formData.get("requiredSymbol") ?? "").trim();
  const requiredTimeframe = String(formData.get("requiredTimeframe") ?? "").trim();

  if (!requiredSymbol || !requiredTimeframe) {
    return { error: "Symbol and timeframe are required." };
  }

  let result: { verificationId: string };
  try {
    result = await apiFetch<{ verificationId: string }>("/v1/verifications", {
      method: "POST",
      body: JSON.stringify({ strategyVersionId, requiredSymbol, requiredTimeframe }),
      idempotencyKey: randomUUID(),
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to create verification." };
  }

  redirect(`/verifications/${result.verificationId}`);
}

export async function recordDecisionAction(
  strategyVersionId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const decision = String(formData.get("decision") ?? "");
  const rejectionCase = String(formData.get("rejectionCase") ?? "").trim();
  const positiveCase = String(formData.get("positiveCase") ?? "").trim();
  const reasonCodes = String(formData.get("reasonCodes") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const evidenceIds = String(formData.get("evidenceIds") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!["REJECT", "REWORK_WITH_NEW_VERSION", "PAPER_APPROVED"].includes(decision)) {
    return { error: "Choose a decision." };
  }
  if (reasonCodes.length === 0 || evidenceIds.length === 0 || !rejectionCase || !positiveCase) {
    return { error: "Reason codes, evidence ids, rejection case, and positive case are all required." };
  }

  try {
    await apiFetch(`/v1/strategy-versions/${strategyVersionId}/decisions`, {
      method: "POST",
      body: JSON.stringify({ decision, reasonCodes, evidenceIds, rejectionCase, positiveCase }),
      idempotencyKey: randomUUID(),
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to record decision." };
  }

  return { success: `Decision recorded: ${decision}.` };
}

export interface CatalogueFields {
  /** Slug of an existing algo to add a release to, or "" to create a new one. */
  existingSlug: string;
  slug: string;
  name: string;
  tagline: string;
  marketCategory: string;
  symbol: string;
  timeframe: string;
  changelog: string;
  setupInstructions: string;
  /** Encoded by the form's evidence <select> as "run:<id>" or "deployment:<id>", or "" for none. */
  evidenceSource: string;
  scope: string;
  publishNow: boolean;
}

function readCatalogueFields(formData: FormData): CatalogueFields {
  const value = (key: string) => String(formData.get(key) ?? "").trim();
  return {
    existingSlug: value("existingSlug"),
    slug: value("slug"),
    name: value("name"),
    tagline: value("tagline"),
    marketCategory: value("marketCategory"),
    symbol: value("symbol"),
    timeframe: value("timeframe"),
    changelog: value("changelog"),
    setupInstructions: value("setupInstructions"),
    evidenceSource: value("evidenceSource"),
    scope: value("scope"),
    publishNow: formData.get("publishNow") === "on",
  };
}

/**
 * Splits the form's encoded evidence selection back into the discriminated
 * shape the API's PublishStatsBody expects — the mislabelling a backtest
 * scope on forward evidence (or vice versa) is unrepresentable there, and
 * this is where that encoding is undone.
 */
function evidenceSourceBody(fields: CatalogueFields): unknown | null {
  if (!fields.evidenceSource) return null;
  if (fields.evidenceSource.startsWith("run:")) {
    return { kind: "BACKTEST_RUN", backtestRunId: fields.evidenceSource.slice("run:".length), scope: fields.scope };
  }
  if (fields.evidenceSource.startsWith("deployment:")) {
    return { kind: "FORWARD_DEPLOYMENT", forwardDeploymentId: fields.evidenceSource.slice("deployment:".length) };
  }
  return null;
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Catalogues this strategy version as an algo (ADR 0015): resolve or create the
 * algo, pin a release to this version, optionally record evidence from one of
 * its succeeded runs, and optionally publish.
 *
 * Each step is a separate command, so a later failure leaves the earlier steps
 * standing. The error text says which step got through rather than implying
 * nothing happened — a half-catalogued algo the operator does not know about is
 * worse than one they do.
 */
export async function catalogueAlgoAction(
  strategyVersionId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const fields = readCatalogueFields(formData);

  let algoId: string;
  let slug: string;
  let created = false;

  if (fields.existingSlug) {
    slug = fields.existingSlug;
    try {
      const algo = await apiFetch<{ algoId: string }>(`/v1/algos/${encodeURIComponent(slug)}`);
      algoId = algo.algoId;
    } catch (error) {
      return { error: message(error, "Could not load that algo.") };
    }
  } else {
    if (!fields.slug || !fields.name || !fields.marketCategory || !fields.symbol || !fields.timeframe) {
      return { error: "Slug, name, market, symbol, and timeframe are required for a new algo." };
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fields.slug)) {
      return { error: "Slug must be lower-case words separated by single hyphens, e.g. momentum-btc." };
    }

    slug = fields.slug;
    try {
      const algo = await apiFetch<{ algoId: string }>("/v1/algos", {
        method: "POST",
        idempotencyKey: randomUUID(),
        body: JSON.stringify({
          slug: fields.slug,
          name: fields.name,
          tagline: fields.tagline,
          marketCategory: fields.marketCategory,
          symbol: fields.symbol,
          timeframe: fields.timeframe,
        }),
      });
      algoId = algo.algoId;
      created = true;
    } catch (error) {
      return { error: message(error, "Could not create the algo.") };
    }
  }

  const madeAlgo = created ? `Algo "${slug}" was created as a draft. ` : "";

  let releaseId: string;
  try {
    const release = await apiFetch<{ releaseId: string }>(`/v1/algos/${algoId}/releases`, {
      method: "POST",
      body: JSON.stringify({
        strategyVersionId,
        changelog: fields.changelog,
        setupInstructions: fields.setupInstructions,
      }),
    });
    releaseId = release.releaseId;
  } catch (error) {
    return { error: `${madeAlgo}${message(error, "Could not publish a release for this version.")}` };
  }

  const evidenceBody = evidenceSourceBody(fields);
  if (evidenceBody) {
    try {
      await apiFetch(`/v1/algo-releases/${releaseId}/stats`, {
        method: "POST",
        body: JSON.stringify(evidenceBody),
      });
    } catch (error) {
      return {
        error: `${madeAlgo}The release was published, but the evidence was not: ${message(error, "unknown error")}`,
      };
    }
  }

  if (fields.publishNow) {
    try {
      await apiFetch(`/v1/algos/${algoId}/publish`, { method: "POST" });
    } catch (error) {
      return {
        error: `${madeAlgo}The release was published, but the algo is still a draft: ${message(error, "unknown error")}`,
      };
    }
  }

  redirect(`/algos/${encodeURIComponent(slug)}`);
}
