import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { RpcStub } from "cloudflare:workers";
import { VoiceLiveness, VoiceResponseStream, VoiceSession } from "../src/voice-session";
import { newSecretToken } from "../src/connect-handoff";

const voices = (env as typeof env & { TEST_VOICE: DurableObjectNamespace<VoiceSession> }).TEST_VOICE;
async function session(mode: "dictate" | "conversation" = "dictate") {
  const id = crypto.randomUUID();
  const stub = voices.getByName(id);
  const { secret, hash } = await newSecretToken();
  const live = new RpcStub(new VoiceLiveness(() => true));
  await stub.initialize(id.toString(), mode, hash, Date.now() + 60_000, live, {
    stt: "@cf/deepgram/flux",
    ...(mode === "conversation"
        ? { tts: { model: "@cf/deepgram/aura-2-en", speaker: "luna" } } : {}),
  });
  return { stub, token: secret.toHex(), live };
}
function upgrade(token: string) {
  return new Request(`https://voice.example/api/voice/test?token=${token}`, { headers: { Upgrade: "websocket" } });
}
describe("voice audio capability", () => {
  it("expires an unredeemed ticket without starting a heartbeat", async () => {
    const stub = voices.getByName(crypto.randomUUID());
    const { secret, hash } = await newSecretToken();
    await runInDurableObject(stub, async (instance: VoiceSession) => {
      using live = new RpcStub(new VoiceLiveness(() => true));
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      const timeout = vi.spyOn(globalThis, "setTimeout");
      const interval = vi.spyOn(globalThis, "setInterval");
      try {
        expect(Date.now()).toBe(1_000_000);
        now.mockClear();
        await instance.initialize("unused", "dictate", hash, 1_045_000, live,
            { stt: "@cf/deepgram/flux" });
        expect(now).toHaveBeenCalled();
        expect(interval).not.toHaveBeenCalled();
        expect(timeout).toHaveBeenCalledWith(expect.any(Function), 45_000);
        const expire = timeout.mock.calls[0][0] as () => void;
        expire();
        expect((await instance.fetch(upgrade(secret.toHex()))).status).toBe(403);
      } finally {
        await instance.revoke();
        timeout.mockRestore(); interval.mockRestore(); now.mockRestore();
      }
    });
  });
  it("promotes the ticket deadline to a call lifetime only on connection", async () => {
    const current = await session();
    try {
      await runInDurableObject(current.stub, async (instance: VoiceSession) => {
        const timeout = vi.spyOn(globalThis, "setTimeout");
        const interval = vi.spyOn(globalThis, "setInterval");
        const clear = vi.spyOn(globalThis, "clearTimeout");
        try {
          const response = await instance.fetch(upgrade(current.token));
          expect(response.status).toBe(101);
          response.webSocket!.accept();
          expect(clear).toHaveBeenCalled();
          expect(timeout).toHaveBeenCalledWith(expect.any(Function), 60 * 60 * 1000);
          expect(interval).toHaveBeenCalledWith(expect.any(Function), 5000);
          response.webSocket!.close();
        } finally {
          await instance.revoke();
          timeout.mockRestore(); interval.mockRestore(); clear.mockRestore();
        }
      });
    } finally { await current.stub.revoke(); current.live[Symbol.dispose](); }
  });
  it.each(["response", "throw"])("revokes a redeemed ticket when transport acceptance fails with %s", async failure => {
    const current = await session();
    try {
      await runInDurableObject(current.stub, async (instance: VoiceSession) => {
        const sdkFetch = vi.spyOn(Object.getPrototypeOf(VoiceSession.prototype), "fetch");
        const revoke = vi.spyOn(instance, "revoke");
        try {
          if (failure === "throw") {
            sdkFetch.mockRejectedValueOnce(new Error("Transport unavailable"));
            await expect(instance.fetch(upgrade(current.token))).rejects.toThrow("Transport unavailable");
          } else {
            sdkFetch.mockResolvedValueOnce(new Response("Transport unavailable", { status: 503 }));
            expect((await instance.fetch(upgrade(current.token))).status).toBe(503);
          }
          expect(sdkFetch).toHaveBeenCalledOnce();
          expect(revoke).toHaveBeenCalledOnce();
          expect((await instance.fetch(upgrade(current.token))).status).toBe(403);
        } finally {
          sdkFetch.mockRestore(); revoke.mockRestore();
          await instance.revoke();
        }
      });
    } finally { await current.stub.revoke(); current.live[Symbol.dispose](); }
  });
  it("rejects wrong-session credentials, consumes once, and rejects replay", async () => {
    const first = await session();
    const second = await session();
    try {
      expect((await first.stub.fetch(upgrade(second.token))).status).toBe(403);
      const accepted = await first.stub.fetch(upgrade(first.token));
      expect(accepted.status).toBe(101);
      accepted.webSocket!.accept();
      expect((await first.stub.fetch(upgrade(first.token))).status).toBe(403);
      accepted.webSocket!.close();
    } finally {
      await first.stub.revoke(); await second.stub.revoke();
      first.live[Symbol.dispose](); second.live[Symbol.dispose]();
    }
  });
  it("rejects expired and revoked capabilities before transport acceptance", async () => {
    const id = crypto.randomUUID();
    const stub = voices.getByName(id);
    const { secret, hash } = await newSecretToken();
    using live = new RpcStub(new VoiceLiveness(() => true));
    await stub.initialize(id.toString(), "conversation", hash, Date.now() - 1, live,
        { stt: "@cf/deepgram/flux", tts: { model: "@cf/deepgram/aura-1", speaker: "asteria" } });
    expect((await stub.fetch(upgrade(secret.toHex()))).status).toBe(403);
    await stub.revoke();
    const fresh = await session();
    await fresh.stub.revoke();
    expect((await fresh.stub.fetch(upgrade(fresh.token))).status).toBe(403);
    fresh.live[Symbol.dispose]();
  });
  it("rejects outside-call text_message without inference", async () => {
    const current = await session();
    try {
      const response = await current.stub.fetch(upgrade(current.token));
      const socket = response.webSocket!;
      socket.accept();
      const closed = new Promise<CloseEvent>(resolve => socket.addEventListener("close", resolve, { once: true }));
      socket.send(JSON.stringify({ type: "text_message", text: "unauthorized inference" }));
      expect((await closed).code).toBe(1000);
    } finally { await current.stub.revoke(); current.live[Symbol.dispose](); }
  });
});
describe("voice model selection", () => {
  it("runs the resolved STT adapter and TTS model/speaker", async () => {
    const id = crypto.randomUUID();
    const stub = voices.getByName(id);
    const { hash } = await newSecretToken();
    using live = new RpcStub(new VoiceLiveness(() => true));
    await stub.initialize(id.toString(), "conversation", hash, Date.now() + 60_000, live,
        { stt: "@cf/deepgram/nova-3", tts: { model: "@cf/deepgram/aura-2-en", speaker: "luna" } });
    try {
      await runInDurableObject(stub, async (instance: VoiceSession) => {
        const bindings = Reflect.get(instance, "env") as Cloudflare.Env;
        const originalAi = bindings.WORKERS_AI;
        const pair = new WebSocketPair();
        pair[0].accept();
        const run = vi.fn(async (model: string) => model === "@cf/deepgram/nova-3"
            ? new Response(null, { status: 101, webSocket: pair[1] })
            : new Response(new ArrayBuffer(8), { status: 200 }));
        Object.assign(bindings, { WORKERS_AI: { run } });
        try {
          const stt = instance.createTranscriber()!.createSession({});
          await stt.waitUntilReady?.();
          expect(run).toHaveBeenCalledWith("@cf/deepgram/nova-3", expect.anything(),
              { websocket: true });
          stt.close();
          Reflect.set(instance, "inCall", true);
          await instance.onTurn("Hello.", {
            signal: new AbortController().signal,
            connection: { send() {} },
          } as never);
          await instance.tts!.synthesize("Hello.");
          expect(run).toHaveBeenCalledWith("@cf/deepgram/aura-2-en",
              { text: "Hello.", speaker: "luna" },
              expect.objectContaining({ returnRawResponse: true }));
        } finally {
          await instance.revoke();
          Object.assign(bindings, { WORKERS_AI: originalAi });
        }
      });
    } finally { await stub.revoke(); }
  });
});
describe("voice response stream", () => {
  it("settles a pending read on abort and discards buffered speech", async () => {
    const abort = new AbortController();
    const stream = new VoiceResponseStream(abort.signal);
    const pending = stream.next();
    abort.abort();
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(() => stream.push(0, "late audio", false)).toThrow("Invalid voice response sequence or size");
  });
  it("accepts ordered chunks and refuses replay, gaps and oversized output", async () => {
    const stream = new VoiceResponseStream(new AbortController().signal);
    stream.push(0, "Hello", false);
    expect(() => stream.push(0, "duplicate", false)).toThrow("Invalid voice response sequence or size");
    expect(() => stream.push(2, "gap", false)).toThrow("Invalid voice response sequence or size");
    expect(() => stream.push(1, "x".repeat(8193), false)).toThrow("Invalid voice response sequence or size");
    stream.push(1, " world.", true);
    const chunks: string[] = [];
    for await (const text of stream) chunks.push(text);
    expect(chunks.join("")).toBe("Hello world.");
  });
});


/** Keep early SDK frames so listening/transcript events cannot race test listeners. */
function frames(socket: WebSocket) {
  socket.binaryType = "arraybuffer";
  const messages: Array<Record<string, unknown> | ArrayBuffer> = [];
  let notify: (() => void) | undefined;
  let closed = false;
  socket.addEventListener("close", () => { closed = true; notify?.(); notify = undefined; });
  socket.addEventListener("message", event => {
    messages.push(typeof event.data === "string" ? JSON.parse(event.data) : event.data);
    notify?.(); notify = undefined;
  });
  return async (matches: (frame: Record<string, unknown> | ArrayBuffer) => boolean) => {
    for (;;) {
      const index = messages.findIndex(matches);
      if (index >= 0) return messages.splice(index, 1)[0];
      if (closed) throw new Error("Voice socket closed before the expected frame");
      await new Promise<void>(resolve => { notify = resolve; });
    }
  };
}

for (const mode of ["dictate", "conversation"] as const) {
  it(`runs the pinned SDK ${mode} path with fake providers and no parallel history`, async () => {
    const current = await session(mode);
    let synthesized = 0;
    let turns = 0;
    let released = false;
    await runInDurableObject(current.stub, async (instance: VoiceSession) => {
      // Provider availability is the only replaced prerequisite; credential and message gates stay real.
      instance.beforeCallStart = async () => true;
      instance.createTranscriber = () => ({
        createSession: options => ({
          feed: () => options?.onUtterance?.("A dictated request."),
          close: () => { released = true; },
        }),
      });
      instance.tts = { synthesize: async () => { synthesized++; return new ArrayBuffer(4); } };
      const onTurn = instance.onTurn.bind(instance);
      instance.onTurn = async (...args) => { turns++; return onTurn(...args); };
    });
    try {
      const response = await current.stub.fetch(upgrade(current.token));
      const socket = response.webSocket!;
      const next = frames(socket);
      socket.accept();
      await next(frame => !(frame instanceof ArrayBuffer) && frame.type === "welcome");
      socket.send(JSON.stringify({ type: "start_call" }));
      await next(frame => !(frame instanceof ArrayBuffer) && frame.type === "status" && frame.status === "listening");
      socket.send(new ArrayBuffer(320));
      const transcript = await next(frame => !(frame instanceof ArrayBuffer) && frame.type === "voice_transcript");
      expect(transcript).toMatchObject({ type: "voice_transcript", mode, text: "A dictated request." });
      if (mode === "conversation" && !(transcript instanceof ArrayBuffer)) {
        socket.send(JSON.stringify({ type: "voice_response", sessionId: transcript.sessionId,
          turnId: transcript.turnId, sequence: 0, text: "A spoken answer.", done: true }));
        await next(frame => frame instanceof ArrayBuffer);
        await next(frame => !(frame instanceof ArrayBuffer) && frame.type === "status" && frame.status === "listening");
        expect(turns).toBe(1);
        expect(synthesized).toBe(1);
      } else {
        expect(await next(frame => !(frame instanceof ArrayBuffer) && frame.type === "turn_metrics")).toMatchObject({ outcome: "skipped" });
        expect(turns).toBe(0);
        expect(synthesized).toBe(0);
        expect(released).toBe(false);
        socket.send(new ArrayBuffer(320));
        expect(await next(frame => !(frame instanceof ArrayBuffer) && frame.type === "voice_transcript"))
          .toMatchObject({ mode: "dictate", text: "A dictated request." });
        await next(frame => !(frame instanceof ArrayBuffer) && frame.type === "turn_metrics");
        expect(released).toBe(false);
        const closed = new Promise<CloseEvent>(resolve => socket.addEventListener("close", resolve, { once: true }));
        socket.send(JSON.stringify({ type: "end_call" }));
        expect((await closed).code).toBe(1000);
        expect(released).toBe(true);
      }
      await runInDurableObject(current.stub, async (instance: VoiceSession, state) => {
        expect(instance.getConversationHistory()).toEqual([]);
        const table = [...state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'cf_voice_messages'")][0];
        if (table.count) expect([...state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM cf_voice_messages")][0].count).toBe(0);
      });
      await current.stub.revoke();
      expect(released).toBe(true);
    } finally { await current.stub.revoke(); current.live[Symbol.dispose](); }
  });
}

for (const mode of ["dictate", "conversation"] as const) {
  it(`routes real Flux events through repeated ${mode} turns`, async () => {
    const current = await session(mode);
    try {
      await runInDurableObject(current.stub, async (instance: VoiceSession) => {
        const bindings = Reflect.get(instance, "env") as Cloudflare.Env;
        const originalAi = bindings.WORKERS_AI;
        const pair = new WebSocketPair();
        const provider = pair[0];
        provider.binaryType = "arraybuffer";
        provider.accept();
        const run = vi.fn(async () => new Response(null, { status: 101, webSocket: pair[1] }));
        // Only the network boundary is fake; the Flux adapter and withVoice stay real.
        Object.assign(bindings, { WORKERS_AI: { run } });
        instance.tts = { synthesize: async () => new ArrayBuffer(4) };
        try {
          const response = await instance.fetch(upgrade(current.token));
          const socket = response.webSocket!;
          const next = frames(socket);
          const finalTexts: string[] = [];
          socket.addEventListener("message", event => {
            if (typeof event.data !== "string") return;
            const frame = JSON.parse(event.data);
            if (frame.type === "voice_transcript") finalTexts.push(frame.text);
          });
          socket.accept();
          await next(frame => !(frame instanceof ArrayBuffer) && frame.type === "welcome");
          socket.send(JSON.stringify({ type: "start_call" }));
          await next(frame => !(frame instanceof ArrayBuffer) && frame.type === "status" && frame.status === "listening");
          expect(run).toHaveBeenCalledExactlyOnceWith("@cf/deepgram/flux", {
            encoding: "linear16", sample_rate: "16000",
          }, { websocket: true });
          let sequence = 0;
          for (const [turnIndex, text] of ["First sentence.", "Second sentence."].entries()) {
            const send = (event: string, transcript: string) => provider.send(JSON.stringify({
              type: "TurnInfo", event, transcript, turn_index: turnIndex, sequence_id: sequence++,
            }));
            const audio = new Promise<MessageEvent>(resolve => provider.addEventListener("message", resolve, { once: true }));
            socket.send(new ArrayBuffer(320));
            expect((await audio).data).toBeInstanceOf(ArrayBuffer);
            send("StartOfTurn", "");
            send("Update", text);
            await next(frame => !(frame instanceof ArrayBuffer) && frame.type === "transcript_interim" && frame.text === text);
            expect(finalTexts).toHaveLength(turnIndex);
            send("EndOfTurn", text);
            const final = await next(frame => !(frame instanceof ArrayBuffer) && frame.type === "voice_transcript");
            expect(final).toMatchObject({ type: "voice_transcript", mode, text });
            if (mode === "conversation" && !(final instanceof ArrayBuffer)) {
              socket.send(JSON.stringify({ type: "voice_response", sessionId: final.sessionId,
                turnId: final.turnId, sequence: 0, text: "Acknowledged.", done: true }));
              await next(frame => frame instanceof ArrayBuffer);
            }
            expect(await next(frame => !(frame instanceof ArrayBuffer) && frame.type === "turn_metrics"))
              .toMatchObject({ outcome: mode === "dictate" ? "skipped" : "completed" });
            expect(finalTexts).toEqual(["First sentence.", "Second sentence."].slice(0, turnIndex + 1));
          }
          // Provider resets must surface as failure instead of silently freezing the call.
          provider.close(1011, "Durable Object reset because its code was updated.");
          expect(await next(frame => !(frame instanceof ArrayBuffer) && frame.type === "error"))
            .toMatchObject({ code: "stt_connection_lost", stage: "stt", retryable: true });
          socket.close();
        } finally {
          await instance.revoke();
          Object.assign(bindings, { WORKERS_AI: originalAi });
        }
      });
    } finally { await current.stub.revoke(); current.live[Symbol.dispose](); }
  });
}
