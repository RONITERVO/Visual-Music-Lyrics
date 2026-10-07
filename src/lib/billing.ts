/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

import { buildApiUrl, getAuthorizedApiRequestHeaders } from "./api";

export interface ElevenLabsBillingAvailability {
  purchasesEnabled: boolean;
  message: string;
}

export async function fetchElevenLabsBillingAvailability(): Promise<ElevenLabsBillingAvailability> {
  const response = await fetch(buildApiUrl("/api/billing/elevenlabs/status"), { cache: "no-store" });
  const data = await response.json().catch(() => null);
  if (!response.ok || typeof data?.purchasesEnabled !== "boolean") {
    throw new Error("Purchase availability could not be verified.");
  }
  return {
    purchasesEnabled: data.purchasesEnabled === true,
    message: String(data.message || ""),
  };
}

export interface ElevenLabsEntitlement {
  uid: string;
  elevenLabsPaidSeconds: number;
  elevenLabsUsedSeconds: number;
  elevenLabsReservedSeconds: number;
  elevenLabsRemainingSeconds: number;
}

export async function fetchElevenLabsEntitlement(): Promise<ElevenLabsEntitlement> {
  const response = await fetch(buildApiUrl("/api/entitlements/me"), {
    method: "GET",
    headers: await getAuthorizedApiRequestHeaders(),
    cache: "no-store",
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || "Could not load Scribe balance");
  }

  return {
    uid: String(data?.uid || ""),
    elevenLabsPaidSeconds: Math.max(0, Math.floor(Number(data?.elevenLabsPaidSeconds) || 0)),
    elevenLabsUsedSeconds: Math.max(0, Math.floor(Number(data?.elevenLabsUsedSeconds) || 0)),
    elevenLabsReservedSeconds: Math.max(0, Math.floor(Number(data?.elevenLabsReservedSeconds) || 0)),
    elevenLabsRemainingSeconds: Math.max(0, Math.floor(Number(data?.elevenLabsRemainingSeconds) || 0)),
  };
}

export async function createElevenLabsCheckoutSession(seconds = 3600) {
  const response = await fetch(buildApiUrl("/api/billing/elevenlabs/checkout-session"), {
    method: "POST",
    headers: await getAuthorizedApiRequestHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ seconds }),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || "Could not start checkout");
  }
  if (!data?.url) {
    throw new Error("Checkout did not return a redirect URL.");
  }

  return {
    url: String(data.url),
    id: String(data.id || ""),
    seconds: Math.max(0, Math.floor(Number(data.seconds) || seconds)),
    amount: Math.max(0, Math.floor(Number(data.amount) || 0)),
    currency: String(data.currency || "eur"),
  };
}
