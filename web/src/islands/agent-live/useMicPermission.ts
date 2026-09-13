// useMicPermission — audio-only getUserMedia preflight for the agent talk
// room. Deliberately smaller than `islands/consult-gs/PreJoin.tsx`: a voice
// agent call has no camera, no device picker beyond the mic, and no "join"
// button of its own — the talk room drives the state machine and just needs
// a live MediaStream once permission is granted.
import { useCallback, useEffect, useRef, useState } from 'react';

export type MicPermissionState = 'idle' | 'asking' | 'granted' | 'denied';

export interface UseMicPermissionResult {
  state: MicPermissionState;
  /** The live mic stream once `state === 'granted'`, else null. */
  stream: MediaStream | null;
  /** Human copy for the denied/failed case. */
  error: string | null;
  /** Ask again (e.g. after the visitor fixes browser permissions). */
  retry: () => void;
}

/** Requests an echo-cancelled mono mic stream on mount and keeps it alive
 *  until the component unmounts, at which point every track is stopped. */
export function useMicPermission(): UseMicPermissionResult {
  const [state, setState] = useState<MicPermissionState>('idle');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);

  const acquire = useCallback(() => {
    const generation = ++generationRef.current;
    setState('asking');
    setError(null);
    navigator.mediaDevices
      .getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        video: false,
      })
      .then((s) => {
        if (!mountedRef.current || generation !== generationRef.current) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = s;
        setStream(s);
        setState('granted');
      })
      .catch((e: DOMException) => {
        if (!mountedRef.current || generation !== generationRef.current) return;
        setState('denied');
        setError(
          e?.name === 'NotAllowedError'
            ? 'Microphone access was blocked. Allow it in your browser settings and try again.'
            : e?.name === 'NotFoundError'
              ? 'No microphone found. Connect one and try again.'
              : 'Could not start your microphone.',
        );
      });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    acquire();
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { state, stream, error, retry: acquire };
}
