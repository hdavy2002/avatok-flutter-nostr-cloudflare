// GeminiLiveClient — the browser side of the AvaVision live session.
//
// MIRRORED from web-client Phase E (islands/agent/GeminiLiveClient.ts) per MASTER
// rule 4 ("mirror, don't share"). Same direct-to-Google Live WS using the
// short-lived EPHEMERAL token minted by the Worker (POST /sessions/start). The
// token already has the model/prompt/voice/language LOCKED in server-side; for
// AvaVision the Worker ALSO locks the VIDEO config (MEDIA_RESOLUTION_LOW, ~1 fps),
// so the browser can never raise fps/resolution and inflate cost (MASTER §2).
//
//   wss://generativelanguage.googleapis.com/ws/...BidiGenerateContent?access_token=<tok>
//     -> send { setup: { model: "models/<model>" } }
//     -> recv { serverContent: { modelTurn:{parts:[{inlineData:{data}}]},
//                                outputTranscription:{text}, turnComplete, interrupted } }
//
// Audio  in: { realtimeInput: { audio: { data:<b64 pcm16>, mimeType:"audio/pcm;rate=16000" } } }
// Vision in: { realtimeInput: { video: { data:<b64 jpeg>, mimeType:"image/jpeg" } } } (~1 fps LOW)
// System in (score/time cues, MASTER §5): { clientContent: { turns:[{role:"user",
//            parts:[{text:"[SYSTEM: FormScore 82, left elbow dropping]"}]}], turnComplete:false } }

const GEMINI_WS_BASE =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent';

export interface GeminiLiveHandlers {
  onReady?: () => void;
  onAudio?: (pcm16: ArrayBuffer) => void;
  onTranscript?: (text: string) => void;
  onTurnComplete?: () => void;
  onInterrupted?: () => void;
  onClose?: (clean: boolean, reason: string) => void;
}

function b64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function arrayBufferToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(bin);
}

export class GeminiLiveClient {
  private ws: WebSocket | null = null;
  private ready = false;
  private closed = false;

  constructor(
    private readonly token: string,
    private readonly model: string,
    private readonly handlers: GeminiLiveHandlers = {},
  ) {}

  get isReady(): boolean {
    return this.ready;
  }

  connect(): void {
    const url = `${GEMINI_WS_BASE}?access_token=${encodeURIComponent(this.token)}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      const model = this.model.startsWith('models/') ? this.model : `models/${this.model}`;
      ws.send(JSON.stringify({ setup: { model } }));
    };
    ws.onmessage = (ev) => void this.onMessage(ev.data);
    ws.onerror = () => this.handleClose(false, 'error');
    ws.onclose = (ev) => this.handleClose(ev.wasClean, ev.reason || (ev.wasClean ? 'closed' : 'dropped'));
  }

  private async onMessage(data: unknown): Promise<void> {
    try {
      let text: string;
      if (typeof data === 'string') text = data;
      else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
      else if (data instanceof Blob) text = await data.text();
      else return;
      const m = JSON.parse(text) as Record<string, any>;

      if (m.setupComplete) {
        this.ready = true;
        this.handlers.onReady?.();
        return;
      }

      const content = m.serverContent as Record<string, any> | undefined;
      if (!content) return;

      if (content.interrupted === true) this.handlers.onInterrupted?.();

      const outT: string | undefined = content.outputTranscription?.text;
      if (outT) this.handlers.onTranscript?.(outT);

      const parts: any[] = content.modelTurn?.parts ?? [];
      for (const p of parts) {
        const inline = p?.inlineData;
        const dataB64: string | undefined = inline?.data;
        if (dataB64 && (!inline.mimeType || String(inline.mimeType).startsWith('audio'))) {
          this.handlers.onAudio?.(b64ToArrayBuffer(dataB64));
        }
      }

      if (content.turnComplete === true) this.handlers.onTurnComplete?.();
    } catch {
      /* non-JSON keepalives are fine to ignore */
    }
  }

  /** Send a mic chunk: raw PCM16 mono @ 16 kHz. */
  sendAudio(pcm16: ArrayBuffer): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.ready || pcm16.byteLength === 0) return;
    try {
      ws.send(
        JSON.stringify({
          realtimeInput: { audio: { data: arrayBufferToB64(pcm16), mimeType: 'audio/pcm;rate=16000' } },
        }),
      );
    } catch {
      /* transient backpressure — drop frame */
    }
  }

  /** Send one ~1 fps LOW-res camera frame (JPEG bytes). The agent "sees" coarsely. */
  sendVideoFrame(jpeg: ArrayBuffer): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.ready || jpeg.byteLength === 0) return;
    try {
      ws.send(
        JSON.stringify({
          realtimeInput: { video: { data: arrayBufferToB64(jpeg), mimeType: 'image/jpeg' } },
        }),
      );
    } catch {
      /* drop frame */
    }
  }

  /**
   * Push a grounding cue to the model as text WITHOUT forcing a turn
   * (turnComplete:false) — e.g. "[SYSTEM: FormScore 82, left elbow dropping]" or
   * "[SYSTEM: 2 minutes remaining]" (MASTER §5). The score/time context steers
   * coaching and makes wrap-up exact; the model folds it into its next reply.
   */
  sendSystemCue(text: string): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.ready || !text) return;
    try {
      ws.send(
        JSON.stringify({
          clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: false },
        }),
      );
    } catch {
      /* drop cue */
    }
  }

  private handleClose(clean: boolean, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.handlers.onClose?.(clean, reason);
  }

  close(): void {
    this.closed = true;
    this.ready = false;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}
