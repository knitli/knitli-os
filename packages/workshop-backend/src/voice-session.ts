import { Agent, type Connection } from "agents";
import { withVoice, type Transcriber, type VoiceTurnContext } from "agents/voice";
import { WorkersAIFluxSTT, WorkersAITTS } from "agents/voice/workers-ai";
import { RpcTarget as NativeRpcTarget, type RpcStub as NativeRpcStub } from "cloudflare:workers";
import { RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import type { VoiceMode, VoiceSessionLease } from "@gadgets/workshop-shared/api";
import { hashPresentedSecret } from "./connect-handoff";

/** Authenticated invocation liveness, never an account or agent capability. */
export class VoiceLiveness extends NativeRpcTarget {
  constructor(private isAlive: () => boolean) { super(); }
  check(): void { if (!this.isAlive()) throw new Error("Voice session closed"); }
}

/** The browser retains this Cap'n Web capability for the call's lifetime. */
@validateRpc()
export class VoiceLease extends RpcTarget implements VoiceSessionLease {
  alive = true;
  constructor(private ctx: ExecutionContext, private voice: DurableObjectStub<VoiceSession>) {
    super();
  }
  async close(): Promise<void> {
    if (!this.alive) return;
    this.alive = false;
    await this.voice.revoke();
  }
  [Symbol.dispose](): void { this.ctx.waitUntil(this.close()); }
}

/** Bounded, abortable response stream; abort settles an outstanding next() immediately. */
export class VoiceResponseStream implements AsyncIterableIterator<string> {
  private queue: string[] = [];
  private waiter?: (result: IteratorResult<string>) => void;
  private ended = false;
  private size = 0;
  private sequence = 0;
  constructor(signal: AbortSignal) {
    if (signal.aborted) this.end();
    else signal.addEventListener("abort", () => this.end(), { once: true });
  }
  push(sequence: number, text: string, done: boolean): void {
    if (this.ended || sequence !== this.sequence || text.length > 8192 || this.size + text.length > 65536) {
      throw new Error("Invalid voice response sequence or size");
    }
    this.sequence++;
    this.size += text.length;
    if (text) {
      if (this.waiter) {
        const waiter = this.waiter; this.waiter = undefined;
        waiter({ value: text, done: false });
      } else this.queue.push(text);
    }
    if (done) {
      this.ended = true;
      this.waiter?.({ value: undefined, done: true });
      this.waiter = undefined;
    }
  }
  end(): void {
    this.ended = true; this.queue = [];
    this.waiter?.({ value: undefined, done: true }); this.waiter = undefined;
  }
  next(): Promise<IteratorResult<string>> {
    const value = this.queue.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise(resolve => { this.waiter = resolve; });
  }
  async return(): Promise<IteratorResult<string>> { this.end(); return { value: undefined, done: true }; }
  [Symbol.asyncIterator](): AsyncIterableIterator<string> { return this; }
}

/** Audio-only, single-browser bridge. All chat authority remains in the browser's native RPC. */
export class VoiceSession extends withVoice(Agent)<Cloudflare.Env> {
  private credential?: { hash: string; expiresAt: number };
  private mode?: VoiceMode;
  private sessionId = "";
  private liveness?: NativeRpcStub<VoiceLiveness>;
  private connectionId?: string;
  private closed = false;
  private inCall = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  private expiry?: ReturnType<typeof setTimeout>;
  private turn?: { id: string; stream: VoiceResponseStream };
  private messages = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    // The mixin installs an instance handler. Gate that handler, not the prototype fallback.
    const sdkMessage = this.onMessage.bind(this);
    const handleMessage = async (connection: Connection, message: Parameters<typeof sdkMessage>[1]) => {
      try {
        if (this.closed || connection.id !== this.connectionId) throw new Error("Closed voice session");
        if (!this.liveness) throw new Error("Voice session closed");
        await this.liveness.check();
        if (this.closed) throw new Error("Voice session closed");
        if (message instanceof ArrayBuffer) {
          if (!this.inCall || message.byteLength > 65536) throw new Error("Invalid audio frame");
          return sdkMessage(connection, message);
        }
        if (typeof message !== "string" || message.length > 10000) throw new Error("Invalid voice frame");
        const frame = JSON.parse(message);
        if (frame.type === "voice_response") {
          if (!this.inCall || this.mode !== "conversation" || frame.sessionId !== this.sessionId ||
              typeof frame.turnId !== "string" || !Number.isSafeInteger(frame.sequence) ||
              typeof frame.text !== "string" || (frame.done !== undefined && typeof frame.done !== "boolean")) {
            throw new Error("Invalid voice response");
          }
          // An interrupted response can already be in flight when its abort acknowledgment arrives.
          const turn = this.turn;
          if (!turn || frame.turnId !== turn.id) return;
          turn.stream.push(frame.sequence, frame.text, frame.done === true);
          return;
        }
        if (!["hello", "start_call", "end_call", "interrupt", "start_of_speech", "end_of_speech"].includes(frame.type)) {
          throw new Error("Unsupported voice message");
        }
        if (frame.type === "start_call") {
          if (this.inCall) throw new Error("Call already started");
          this.inCall = true;
        } else if (frame.type !== "hello" && !this.inCall) throw new Error("Call not active");
        return sdkMessage(connection, message);
      } catch {
        await this.revoke();
      }
    };
    this.onMessage = (connection, message) => {
      this.messages = this.messages.then(() => handleMessage(connection, message));
      return this.messages;
    };
  }

  async initialize(id: string, mode: VoiceMode, hash: string, expiresAt: number,
      liveness: NativeRpcStub<VoiceLiveness>): Promise<void> {
    if (this.mode || this.closed) throw new Error("Voice session already initialized");
    this.sessionId = id; this.mode = mode; this.credential = { hash, expiresAt };
    this.liveness = liveness.dup();
    this.expiry = setTimeout(() => { void this.revoke(); }, 60 * 60 * 1000);
    this.heartbeat = setInterval(() => {
      void this.liveness?.check().catch(() => this.revoke());
    }, 5000);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket required", { status: 400 });
    const token = new URL(request.url).searchParams.get("token") ?? "";
    const hash = await hashPresentedSecret(token);
    // No await between validation and consume: concurrent upgrades cannot redeem twice.
    if (this.closed || !this.credential || !hash || hash !== this.credential.hash || Date.now() >= this.credential.expiresAt) {
      return new Response("Voice connection expired", { status: 403 });
    }
    this.credential = undefined;
    try { await this.liveness!.check(); } catch { await this.revoke(); return new Response("Voice session closed", { status: 403 }); }
    if (this.closed) return new Response("Voice session closed", { status: 403 });
    return super.fetch(request);
  }

  onConnect(connection: Connection): void {
    if (this.closed || this.connectionId) { connection.close(1008, "Voice session closed"); return; }
    this.connectionId = connection.id;
  }
  async beforeCallStart(): Promise<boolean> {
    if (this.closed || !this.mode || !this.env.WORKERS_AI) return false;
    await this.liveness!.check();
    return !this.closed;
  }
  createTranscriber(): Transcriber | null {
    return this.env.WORKERS_AI ? new WorkersAIFluxSTT(this.env.WORKERS_AI) : null;
  }
  async afterTranscribe(text: string, connection: Connection): Promise<string | null> {
    if (this.closed || !this.inCall || text.length > 8192) return null;
    if (this.mode === "dictate") {
      this.emitTranscript(connection, crypto.randomUUID(), text);
      return null;
    }
    return text;
  }
  async onTurn(text: string, context: VoiceTurnContext): Promise<AsyncIterable<string>> {
    if (this.closed || !this.inCall || this.mode !== "conversation") throw new Error("Conversation not active");
    this.turn?.stream.end();
    const id = crypto.randomUUID();
    const stream = new VoiceResponseStream(context.signal);
    this.turn = { id, stream };
    this.tts ??= new WorkersAITTS(this.env.WORKERS_AI);
    this.emitTranscript(context.connection, id, text);
    return stream;
  }
  private emitTranscript(connection: Connection, turnId: string, text: string): void {
    connection.send(JSON.stringify({ type: "voice_transcript", sessionId: this.sessionId, turnId, text, mode: this.mode }));
  }
  onInterrupt(connection: Connection): void {
    const turnId = this.turn?.id ?? null;
    this.turn?.stream.end(); this.turn = undefined;
    // SDK aborts synthesis before this callback; its audio sends check that same abort signal.
    connection.send(JSON.stringify({ type: "voice_interrupt_ack", sessionId: this.sessionId, turnId }));
  }
  async onCallEnd(): Promise<void> { await this.revoke(); }
  async onClose(): Promise<void> { await this.revoke(); }
  saveMessage(): void {}
  getConversationHistory(): [] { return []; }
  async revoke(): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.inCall = false; this.credential = undefined;
    this.turn?.stream.end(); this.turn = undefined;
    clearInterval(this.heartbeat); clearTimeout(this.expiry);
    for (const connection of this.getConnections()) {
      this.forceEndCall(connection);
      connection.close(1000, "Voice session ended");
    }
    this.liveness?.[Symbol.dispose](); this.liveness = undefined;
  }
}
