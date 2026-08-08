"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { apiFetch } from "../../../lib/api";

export interface CreateCampaignActionState {
  error?: string;
}

export async function createCampaignAction(
  _prevState: CreateCampaignActionState,
  formData: FormData,
): Promise<CreateCampaignActionState> {
  const name = String(formData.get("name") ?? "").trim();
  const brief = String(formData.get("brief") ?? "").trim();
  const allowedMarkets = String(formData.get("allowedMarkets") ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);

  if (!name || !brief || allowedMarkets.length === 0) {
    return { error: "Name, brief, and at least one allowed market are required." };
  }

  let campaign: { id: string };
  try {
    campaign = await apiFetch<{ id: string }>("/v1/campaigns", {
      method: "POST",
      body: JSON.stringify({ name, brief, allowedMarkets }),
      idempotencyKey: randomUUID(),
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to create campaign." };
  }

  redirect(`/campaigns/${campaign.id}`);
}
