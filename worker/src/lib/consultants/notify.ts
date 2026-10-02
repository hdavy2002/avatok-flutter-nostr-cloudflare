// [AUMFE-CONSULT-FOUNDATION-1] Stub — lane W3 (WhatsApp + email to customer/consultant/admin, reminders, thank-you).
import type { Env } from "../../types";
export async function runConsultReminders(_env: Env): Promise<number> { return 0; }
/** Called by lane W1 the moment a booking's payment is confirmed. Must be idempotent (confirm_sent_at). */
export async function notifyBookingConfirmed(_env: Env, _bookingId: string): Promise<void> {}
