# Shared component kit + auth contract

This is the **read-only contract** Phases A–E code against. Import everything from
the barrel:

```ts
import { Button, Card, ListingTile, Avatar, Pill, Modal, Sheet, Field, Spinner } from '@/components';
import { ClerkIsland, useAuthToken, requireGuestAuth, GuestGate, SignInButton } from '@/components';
```

Do **not** add components to this kit (Phase 0/Z own it). If you need something
missing, build a **local** component inside your own phase island folder and note
it in your Graphiti episode so Phase Z can promote it.

All styling uses the generated zine tokens only — no hardcoded hex/radius/shadow.
Tailwind theme keys come from `tailwind.zine.cjs` (generated from `zine.dart`):
colors `paper/paper2/card/ink/inkSoft/inkMute/blue/blueInk/lime/coral/lilac/mint/…`,
radius `rounded-zine|zineSm|zineField|zineBadge`, border `border-zine|zineLg`,
shadow `shadow-zine|zine-sm|zine-xs|zine-pressed|zine-focus|zine-error`,
fonts `font-display|body|mono`, motion `duration-zine|zine-slow`.

## Components

### `Button`
Pill button, ink border, hard shadow that collapses on press.
| prop | type | default | notes |
|---|---|---|---|
| `variant` | `'lime' \| 'blue' \| 'coral' \| 'ghost'` | `'lime'` | lime = primary (one per screen); coral = destructive, the only fill with white text |
| `label` | `string` | — | or pass `children` |
| `icon` | `ReactNode` | — | optional |
| `trailingIcon` | `boolean` | `true` | icon side |
| `loading` | `boolean` | `false` | shows spinner, disables |
| `fullWidth` | `boolean` | `false` | |
| `disabled` | `boolean` | — | renders muted/paper2 state |
| …`button` attrs | | | `onClick`, `type`, etc. |

### `Card`
Container card (card fill, 2.5px ink border, 22px radius, hard shadow).
| prop | type | default |
|---|---|---|
| `children` | `ReactNode` | — |
| `fillClassName` | `string` | `'bg-card'` |
| `onClick` | `() => void` | — (adds press interaction) |
| `shadow` | `'sm' \| 'lg' \| 'none'` | `'sm'` |
| `as` | `'div' \| 'article' \| 'section'` | `'div'` |

### `ListingTile`
Poster card for marketplace grids. Links to `/l/<id>` by default.
| prop | type | default | notes |
|---|---|---|---|
| `listing` | `Card` (from `@/lib/types`) | — | required |
| `href` | `string` | `/l/<id>` | cross-link override |
| `width` | `number` | `360` | poster transform width |

Renders a LIVE pill when `listing.live || listing.joinable`.

### `Avatar`
Round avatar using the Cloudflare image-transform pattern
`/cdn-cgi/image/format=avif,quality=60,width=N,fit=cover/<path>` (see `cfImage`).
| prop | type | default |
|---|---|---|
| `src` | `string \| null` | — |
| `name` | `string \| null` | — (initials fallback) |
| `size` | `number` | `44` |
| `fallbackClassName` | `string` | `'bg-blue'` |

### `Pill`
Sticker/tag pill, UPPERCASE mono label.
| prop | type | default | notes |
|---|---|---|---|
| `kind` | `'ok' \| 'no' \| 'hint' \| 'plain'` | `'plain'` | ok=lime, no=coral(white), hint=ghost(no shadow) |
| `icon` | `ReactNode` | — | |
| `onClick` | `() => void` | — | renders as button |

### `Modal`
Centered dialog (paper card, 3px ink border, big shadow). Closes on Escape /
backdrop when `dismissable`.
| prop | type | default |
|---|---|---|
| `open` | `boolean` | — |
| `onClose` | `() => void` | — |
| `title` | `ReactNode` | — |
| `dismissable` | `boolean` | `true` |
| `maxWidth` | `number` | `440` |

### `Sheet`
Bottom sheet variant of `Modal` (same props minus `maxWidth`).

### `Field`
Text input in zine field chrome — optional lime lead cell, focus lift + blue-ink
shadow, coral error shadow + message.
| prop | type | default | notes |
|---|---|---|---|
| `label` | `string` | — | UPPERCASE mono label |
| `lead` | `string` | — | leading glyph ("@", "$") on a lime cell |
| `error` | `string \| null` | — | turns shadow coral, shows line |
| `trailing` | `ReactNode` | — | |
| …`input` attrs | | | `value`, `onChange`, `type`, `placeholder`, … |

### `Spinner`
Ring spinner. Props: `size` (px, default 20), `color` (default ink).

---

## Auth foundation (`lib/clerk.tsx`)

### `<ClerkIsland>`
Wrap any auth-aware island. Provides Clerk context (from
`PUBLIC_CLERK_PUBLISHABLE_KEY`) **and** mounts the `GuestGate` host so
`requireGuestAuth()` works anywhere inside. Renders children unauthenticated for
public reads. If no Clerk key is set, guest auth still works (Clerk sign-in is
disabled).

### `requireGuestAuth(): Promise<string>` — **the gate**
Resolves to a **session JWT**, opening the email/OTP modal only if no session
exists. Use at the point of a gated action; then retry the action with the token:

```ts
const jwt = await requireGuestAuth();
await request('/api/calendar/book', { method: 'POST', auth: jwt, body });
```

- If a live Clerk session exists → resolves its JWT, no UI.
- Else if a stored `guest_token` exists → resolves it, no UI.
- Else opens the modal and runs the flow below.
- Rejects with `Error('cancelled')` if the user dismisses.

### `getActiveToken(): Promise<string | null>`
Non-interactive: live Clerk token, else stored guest token, else `null`. Use for
optional-auth reads.

### `useAuthToken()`
Island hook → `{ token, loaded, refresh(), require() }`. `require()` is the
React-friendly `requireGuestAuth` that also updates local state.

### `<GuestGate open onAuthed onCancel />`
The reusable modal (B/C/D/E **must not** rebuild this). Props: `open: boolean`,
`onAuthed: (jwt) => void`, `onCancel?: () => void`.

### `SignInButton`
Re-export of Clerk's sign-in trigger (full-account path). Phase B owns `/sign-in`.

### ⚠ Contract drift from MASTER-PROMPT §4b (confirmed against the Worker)
§4b sketches `email → start → verify → identity/guest → JWT`. The **real Worker
is handle-first** and the gate implements the actual order:

1. `POST /api/identity/guest { handle, device_id? }` *(no auth)* →
   `{ uid, handle, guest_token, level:0 }` — **the JWT is minted here**. The gate
   auto-generates a handle from the email local-part and retries on `409` (taken).
2. `POST /api/id/email/start { email }` *(Bearer guest_token)* → sends a 6-digit OTP.
3. `POST /api/id/email/verify { email, code }` *(Bearer guest_token)* → verifies
   the email on the guest identity.

A valid `requireUser` session therefore exists after step 1; steps 2–3 capture
the email (for notifications, per §4b). `requireGuestAuth()` resolves the
`guest_token`. Guest tier may be feature-flagged off → `503` surfaces inline.
The token is cached in `localStorage['avatok_guest_jwt']`; a stable
`avatok_device_id` seeds guest creation.
