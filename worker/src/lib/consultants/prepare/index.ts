// [AUMFE-CONSULT-FOUNDATION-1] Stub — lane W2 (AstrologyAPI precompute → consult_file_cards).
import type { Env } from "../../../types";
export async function runPrepareJobs(_env: Env): Promise<number> { return 0; }
/** Kick one booking's preparation right after payment confirms (also retried by cron). */
export async function prepareBooking(_env: Env, _bookingId: string): Promise<void> {}
