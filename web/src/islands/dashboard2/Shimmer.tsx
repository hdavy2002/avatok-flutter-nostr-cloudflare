// [DASH2-BILLING 2026-09-25] Skeleton with a travelling shimmer (framer-motion),
// falling back to a still block under prefers-reduced-motion.
import { motion, useReducedMotion } from 'framer-motion';
import { cn } from '../../lib/utils';

export function Shimmer({ className }: { className?: string }) {
  const reduce = useReducedMotion();
  return (
    <div aria-hidden className={cn('relative overflow-hidden rounded-md bg-muted', className)}>
      {!reduce && (
        <motion.div
          className="absolute inset-y-0 -left-1/2 w-1/2 bg-gradient-to-r from-transparent via-card/80 to-transparent"
          animate={{ x: ['0%', '400%'] }}
          transition={{ duration: 1.4, ease: 'easeInOut', repeat: Infinity, repeatDelay: 0.2 }}
        />
      )}
    </div>
  );
}
