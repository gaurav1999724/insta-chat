// spec §41: "the backend must first determine whether the official
// Instagram API supports the intended outbound initiation... If Meta does
// not permit the operation, display: 'This action isn't available through
// the currently supported Instagram API.' Do not attempt to bypass it."
//
// Instagram's standard messaging window is 24 hours from the contact's
// last inbound message. Meta's only official extension is the
// `human_agent` tag (7 days) — but per Meta's own policy that tag is for a
// real human replying manually, not for automating a send; using it
// programmatically here would be exactly the kind of unofficial bypass
// spec §41 forbids. So this app never sends outside the plain 24-hour
// window, automated or not — see docs/INSTAGRAM_SETUP.md.
const MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;

export const SEND_NOT_SUPPORTED_MESSAGE =
  "This action isn't available through the currently supported Instagram API.";

export function isWithinMessagingWindow(lastInboundMessageAt: Date | null): boolean {
  if (!lastInboundMessageAt) return false;
  return Date.now() - lastInboundMessageAt.getTime() <= MESSAGING_WINDOW_MS;
}
