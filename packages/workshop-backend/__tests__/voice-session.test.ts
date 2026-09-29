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
  await stub.initialize(id.toString(), mode, hash, Date.now() + 60_000, live);
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
        await instance.initialize("unused", "dictate", hash, 1_045_000, live);
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
    await stub.initialize(id.toString(), "conversation", hash, Date.now() - 1, live);
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
  socket.addEventListener("message", event => {
    messages.push(typeof event.data === "string" ? JSON.parse(event.data) : event.data);
    notify?.(); notify = undefined;
  });
  return async (matches: (frame: Record<string, unknown> | ArrayBuffer) => boolean) => {
    for (;;) {
      const index = messages.findIndex(matches);
      if (index >= 0) return messages.splice(index, 1)[0];
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
