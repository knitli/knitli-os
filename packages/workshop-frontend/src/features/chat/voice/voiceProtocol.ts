import type { VoiceTransport } from "agents/voice/client";

export const TRANSCRIPTION_CONTEXT = "Input context: This message includes speech transcribed from audio and may have been edited by the user. Transcription can mishear words, names, technical terms, or punctuation. Interpret it in context; if ambiguity materially affects the requested action, ask for clarification rather than guessing.";

export const withTranscriptionContext = (text: string) => `${text}\n\n${TRANSCRIPTION_CONTEXT}`;

export class VoiceAudioGate {
  #waitingForAck = false;
  #waitingForTranscript = false;

  interrupt() {
    this.#waitingForAck = true;
    this.#waitingForTranscript = false;
  }

  acknowledgeInterrupt() {
    if (this.#waitingForAck) this.#waitingForTranscript = true;
  }

  transcript(sessionId: string, expectedSessionId: string) {
    if (this.#waitingForTranscript && sessionId === expectedSessionId) {
      this.#waitingForAck = false;
      this.#waitingForTranscript = false;
    }
  }

  get allowsAudio() {
    return !this.#waitingForAck && !this.#waitingForTranscript;
  }
}

type VoiceWebSocket = Pick<WebSocket, "binaryType" | "readyState" | "send" | "close" | "addEventListener">;

/** A single-use session URL must never inherit PartySocket reconnection behavior. */
export class VoiceSessionTransport implements VoiceTransport {
  onopen: (() => void) | null = null;
  onclose: ((info?: { code?: number; reason?: string; wasClean?: boolean }) => void) | null = null;
  onerror: ((error?: unknown) => void) | null = null;
  onmessage: ((data: string | ArrayBuffer | Blob) => void) | null = null;
  #socket: VoiceWebSocket | null = null;
  #gate = new VoiceAudioGate();

  constructor(
    private readonly url: string,
    private readonly sessionId: string,
    private readonly createSocket: (url: string) => VoiceWebSocket = (url) => new WebSocket(url),
  ) {}

  get connected() {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  connect() {
    if (this.#socket) return;
    const socket = this.createSocket(this.url);
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => this.onopen?.());
    socket.addEventListener("close", (event) => {
      this.#gate.interrupt();
      this.onclose?.({ code: event.code, reason: event.reason, wasClean: event.wasClean });
    });
    socket.addEventListener("error", (event) => this.onerror?.(event));
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") this.receiveJson(event.data);
      else if (this.#gate.allowsAudio) this.onmessage?.(event.data);
    });
    this.#socket = socket;
  }

  disconnect() {
    this.#gate.interrupt();
    this.#socket?.close();
    this.#socket = null;
  }

  sendJSON(data: Record<string, unknown>) {
    if (data.type === "interrupt") this.#gate.interrupt();
    if (this.connected) this.#socket!.send(JSON.stringify(data));
  }

  sendBinary(data: ArrayBuffer) {
    if (this.connected) this.#socket!.send(data);
  }

  private receiveJson(data: string) {
    try {
      const message = JSON.parse(data) as { type?: string; sessionId?: string };
      if (message.type === "playback_interrupt") this.#gate.interrupt();
      if (message.type === "voice_interrupt_ack") this.#gate.acknowledgeInterrupt();
      if (message.type === "voice_transcript" && typeof message.sessionId === "string") {
        this.#gate.transcript(message.sessionId, this.sessionId);
      }
    } catch {
      // The SDK will surface malformed protocol JSON as its normal error state.
    }
    this.onmessage?.(data);
  }
}

export const voiceWebSocketUrl = (path: string) => {
  if (!path.startsWith("/")) throw new Error("Voice session returned an invalid URL.");
  return `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}${path}`;
};
