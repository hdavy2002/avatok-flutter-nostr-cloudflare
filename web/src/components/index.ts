// Shared component kit barrel — the contract A–E import from.
// Import as: `import { Button, ListingTile } from '@/components';`
export { Button } from './Button';
export type { ButtonProps, ButtonVariant } from './Button';
export { Card } from './Card';
export type { CardProps } from './Card';
export { ListingTile } from './ListingTile';
export type { ListingTileProps } from './ListingTile';
export { Avatar } from './Avatar';
export type { AvatarProps } from './Avatar';
export { Pill } from './Pill';
export type { PillProps, PillKind } from './Pill';
export { Modal } from './Modal';
export type { ModalProps } from './Modal';
export { Sheet } from './Sheet';
export type { SheetProps } from './Sheet';
export { Field } from './Field';
export type { FieldProps } from './Field';
export { Spinner } from './Spinner';
export type { SpinnerProps } from './Spinner';

// Auth foundation (lives in lib/clerk.tsx; re-exported for ergonomics).
export { ClerkIsland, useAuthToken, SignInButton, GuestGate, requireGuestAuth, getActiveToken } from '../lib/clerk';
export type { GuestGateProps } from '../lib/clerk';
