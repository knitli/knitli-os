import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newWebSocketRpcSession } from "capnweb";
import type { PublicApi, VoiceSessionConnection } from "@gadgets/workshop-shared/api";
import { expect, it } from "vitest";
import server from "../src/server";

const origin = "https://workshop.invalid";

async function bounded<T>(label: string, operation: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 5000);
    })]);
  } finally { clearTimeout(timer!); }
}

async function connect() {
  // Session creation checks binding availability. These transport tests never start inference;
  // the actual DO retains its test environment, without a remote Workers AI binding.
  const response = await server.fetch(new Request(`${origin}/api`, {
    headers: { Upgrade: "websocket", Origin: origin },
  }), { ...env, WORKERS_AI: {} as Ai }, createExecutionContext());
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const api = newWebSocketRpcSession<PublicApi>(socket);
  const name = `voice${crypto.randomUUID().replaceAll("-", "")}`;
  const token = await bounded("create account", api.createAccount(name, name, new Uint8Array([1, 2, 3])));
  if (token === null) throw new Error("Voice test account was not created");
  const authenticated = await bounded("authenticate", api.authenticate(token));
  return { api, authenticated, socket };
}

function upgrade(session: VoiceSessionConnection, requestOrigin = origin) {
  return server.fetch(new Request(new URL(session.url, origin), {
    headers: { Upgrade: "websocket", Origin: requestOrigin },
  }), env, createExecutionContext());
}

it("authenticates voice creation and redeems its same-origin ticket only once", async () => {
  const connection = await connect();
  using _api = connection.api;
  using authenticated = connection.authenticated;
  using session = await bounded("create dictation session", authenticated.createVoiceSession("dictate"));
  expect(session.id).toMatch(/^[0-9a-f]{64}$/);
  expect((await upgrade(session, "https://attacker.invalid")).status).toBe(403);

  const wrongToken = { ...session, url: session.url.replace(/token=.*/, `token=${"0".repeat(64)}`) };
  expect((await upgrade(wrongToken)).status).toBe(403);

  const accepted = await upgrade(session);
  expect(accepted.status).toBe(101);
  const audio = accepted.webSocket!;
  const welcomed = new Promise<void>((resolve, reject) => {
    audio.addEventListener("message", event => {
      if (typeof event.data === "string" && JSON.parse(event.data).type === "welcome") resolve();
    });
    audio.addEventListener("close", event => reject(new Error(`Audio closed before welcome: ${event.code}`)), { once: true });
  });
  audio.accept();
  await bounded("voice welcome", welcomed);
  expect((await upgrade(session)).status).toBe(403);
  const closed = new Promise<void>(resolve => audio.addEventListener("close", () => resolve(), { once: true }));
  await bounded("close voice lease", session.session.close());
  await bounded("audio close event", closed);
  expect((await upgrade(session)).status).toBe(403);
  audio.close();
  connection.socket.close();
});

it("closes the audio socket when its authenticated RPC transport disconnects", async () => {
  const connection = await connect();
  using _api = connection.api;
  using authenticated = connection.authenticated;
  using session = await authenticated.createVoiceSession("conversation");
  const accepted = await upgrade(session);
  expect(accepted.status).toBe(101);
  const audio = accepted.webSocket!;
  const welcomed = new Promise<void>((resolve, reject) => {
    audio.addEventListener("message", event => {
      if (typeof event.data === "string" && JSON.parse(event.data).type === "welcome") resolve();
    });
    audio.addEventListener("close", event => reject(new Error(`Audio closed before welcome: ${event.code}`)), { once: true });
  });
  audio.accept();
  await bounded("voice welcome", welcomed);
  const closed = new Promise<void>(resolve => audio.addEventListener("close", () => resolve(), { once: true }));
  connection.socket.close(1000, "Test browser disconnected");
  await bounded("audio close event", closed);
  expect((await upgrade(session)).status).toBe(403);
  audio.close();
});
