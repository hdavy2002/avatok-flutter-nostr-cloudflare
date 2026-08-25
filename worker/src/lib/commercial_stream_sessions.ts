// Phase 2 commercial GetStream identity contracts.
//
// This module intentionally contains no Messenger imports. Listing/booking
// routes load authoritative D1 records first, then pass those server-owned IDs
// here. Clients never choose provider call types, call IDs, prices, members, or
// roles.

export const COMMERCIAL_PROVIDER = "getstream" as const;

export type CommercialSessionKind = "live_event" | "consult_1to1";
export type CommercialProviderCallType =
  | "avatok_livestream"
  | "avatok_consult_1to1";

export type CommercialProviderIdentity = {
  provider: typeof COMMERCIAL_PROVIDER;
  callType: CommercialProviderCallType;
  callId: string;
};

const AUTHORITY_ID = /^[A-Za-z0-9-]{1,64}$/;

function authorityId(value: string, field: string): string {
  if (!AUTHORITY_ID.test(value)) {
    throw new Error(`invalid server ${field}`);
  }
  return value;
}

export function commercialProviderIdentity(input: {
  kind: CommercialSessionKind;
  listingId: string;
  bookingId?: string | null;
  sessionVersion?: number;
}): CommercialProviderIdentity {
  const listingId = authorityId(input.listingId, "listing id");
  if (input.kind === "consult_1to1") {
    const bookingId = authorityId(input.bookingId ?? "", "booking id");
    return {
      provider: COMMERCIAL_PROVIDER,
      callType: "avatok_consult_1to1",
      callId: `consult_${bookingId}`,
    };
  }

  const sessionVersion = Math.trunc(input.sessionVersion ?? 1);
  if (!Number.isSafeInteger(sessionVersion) || sessionVersion < 1) {
    throw new Error("invalid server session version");
  }
  return {
    provider: COMMERCIAL_PROVIDER,
    callType: "avatok_livestream",
    callId: `live_${listingId}_${sessionVersion}`,
  };
}

export function commercialJoinEnabled(
  kind: CommercialSessionKind,
  config: {
    commercialLiveJoinEnabled?: boolean;
    commercialConsultJoinEnabled?: boolean;
  },
): boolean {
  return kind === "live_event"
    ? config.commercialLiveJoinEnabled === true
    : config.commercialConsultJoinEnabled === true;
}
