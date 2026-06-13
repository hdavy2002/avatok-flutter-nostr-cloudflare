/* Phase B — GuestEmail.
 *
 * Per the phase brief this is a THIN WRAPPER around Phase 0's shared GuestGate
 * (lib/clerk.tsx). We do NOT reinvent the email→OTP UI. BookingFlow uses
 * `requireGuestAuth()` directly (which drives the same modal); this component
 * exists only for the rare case a phase wants the gate inline as a controlled
 * element rather than via the imperative helper.
 */
import { GuestGate } from '../../lib/clerk';
import type { GuestGateProps } from '../../lib/clerk';

export type GuestEmailProps = GuestGateProps;

/** Inline alias of the shared gate — keeps the email captured at checkout. */
export function GuestEmail(props: GuestEmailProps) {
  return <GuestGate {...props} />;
}

export default GuestEmail;
