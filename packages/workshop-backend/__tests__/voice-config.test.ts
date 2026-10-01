import { describe, expect, it } from "vitest";
import {
  DEFAULT_VOICE_CONFIG,
  VoiceAdminConfig,
} from "@gadgets/workshop-shared/api";
import {
  offeredVoiceModels,
  parseVoiceConfig,
  resolveVoiceSpec,
  validateVoiceConfig,
  validateVoicePreferences,
} from "../src/voice-config";

const FLUX = "@cf/deepgram/flux";
const NOVA = "@cf/deepgram/nova-3";
const AURA2 = "@cf/deepgram/aura-2-en";

describe("validateVoiceConfig", () => {
  it("accepts the built-in default curation", () => {
    expect(validateVoiceConfig(DEFAULT_VOICE_CONFIG)).toEqual(DEFAULT_VOICE_CONFIG);
  });
  it("rejects models the backend cannot run", () => {
    let config: VoiceAdminConfig = {
      ...structuredClone(DEFAULT_VOICE_CONFIG),
      models: [{
        modelId: "@cf/openai/whisper-large-v3-turbo", kind: "stt", name: "Whisper", enabled: true,
      }],
      defaults: {
        dictationStt: "@cf/openai/whisper-large-v3-turbo",
        conversationStt: FLUX, conversationTts: AURA2,
      },
    };
    expect(() => validateVoiceConfig(config)).toThrow("not supported");
  });
  it("rejects defaults naming a disabled, missing, or wrong-kind model", () => {
    let disabled = structuredClone(DEFAULT_VOICE_CONFIG);
    disabled.models.find(entry => entry.modelId === NOVA)!.enabled = false;
    expect(() => validateVoiceConfig(disabled)).toThrow('disabled model "@cf/deepgram/nova-3"');

    let missing = structuredClone(DEFAULT_VOICE_CONFIG);
    missing.defaults.dictationStt = "@cf/deepgram/unknown";
    expect(() => validateVoiceConfig(missing)).toThrow("no offered model");

    let wrongKind = structuredClone(DEFAULT_VOICE_CONFIG);
    wrongKind.defaults.conversationTts = FLUX;
    expect(() => validateVoiceConfig(wrongKind)).toThrow("must be a tts model");
  });
  it("rejects a default voice the model doesn't offer, and duplicate models", () => {
    let voice = structuredClone(DEFAULT_VOICE_CONFIG);
    voice.models.find(entry => entry.modelId === AURA2)!.defaultVoice = "nobody";
    expect(() => validateVoiceConfig(voice)).toThrow('not offered for "@cf/deepgram/aura-2-en"');

    let dupe = structuredClone(DEFAULT_VOICE_CONFIG);
    dupe.models.push({ modelId: FLUX, kind: "stt", name: "Flux again", enabled: true });
    expect(() => validateVoiceConfig(dupe)).toThrow('Duplicate voice model "@cf/deepgram/flux"');
  });
});

describe("parseVoiceConfig", () => {
  it("repairs garbage to the built-in defaults without throwing", () => {
    expect(parseVoiceConfig(null)).toEqual(DEFAULT_VOICE_CONFIG);
    expect(parseVoiceConfig({ models: "nope", defaults: {} })).toEqual(DEFAULT_VOICE_CONFIG);
    let handEdited = {
      models: [
        { modelId: "@cf/deepgram/unknown", kind: "stt", name: "Fake", enabled: true },
        { modelId: NOVA, kind: "stt", name: "Nova 3", enabled: true },
      ],
      defaults: { dictationStt: "@cf/deepgram/unknown", conversationStt: 42 },
    };
    let parsed = parseVoiceConfig(handEdited);
    expect(parsed.models.map(entry => entry.modelId)).toEqual([NOVA]);
    expect(parsed.defaults.dictationStt).toBe(NOVA);
    expect(parsed.defaults.conversationStt).toBe(DEFAULT_VOICE_CONFIG.defaults.conversationStt);
    expect(parsed.defaults.conversationTts).toBe(DEFAULT_VOICE_CONFIG.defaults.conversationTts);
  });
});

describe("resolveVoiceSpec", () => {
  it("prefers the user pick, then the admin default, then the built-in", () => {
    expect(resolveVoiceSpec(DEFAULT_VOICE_CONFIG, {}, "dictate")).toEqual({ stt: NOVA });
    expect(resolveVoiceSpec(DEFAULT_VOICE_CONFIG, { dictationStt: FLUX }, "dictate"))
        .toEqual({ stt: FLUX });
    let admin = structuredClone(DEFAULT_VOICE_CONFIG);
    admin.defaults.dictationStt = FLUX;
    expect(resolveVoiceSpec(admin, {}, "dictate")).toEqual({ stt: FLUX });
    // Stale prefs naming an unrunnable model degrade to the admin default, never throw.
    expect(resolveVoiceSpec(DEFAULT_VOICE_CONFIG, { dictationStt: "@cf/deepgram/retired" },
        "dictate")).toEqual({ stt: NOVA });
  });
  it("resolves the speaker down the voice chain", () => {
    let base = resolveVoiceSpec(DEFAULT_VOICE_CONFIG, {}, "conversation");
    expect(base).toEqual({ stt: FLUX, tts: { model: AURA2, speaker: "luna" } });
    let picked = resolveVoiceSpec(DEFAULT_VOICE_CONFIG, { voice: "zeus" }, "conversation");
    expect(picked.tts?.speaker).toBe("zeus");
    // A stale voice falls back to the model's default voice.
    let stale = resolveVoiceSpec(
        DEFAULT_VOICE_CONFIG, { voice: "retired-voice" }, "conversation");
    expect(stale.tts?.speaker).toBe("luna");
    // A TTS entry with no usable voices still speaks via the cross-Aura fallback.
    let bare = structuredClone(DEFAULT_VOICE_CONFIG);
    bare.models.find(entry => entry.modelId === AURA2)!.voices = [];
    delete bare.models.find(entry => entry.modelId === AURA2)!.defaultVoice;
    expect(resolveVoiceSpec(bare, {}, "conversation").tts?.speaker).toBe("asteria");
  });
});

describe("validateVoicePreferences", () => {
  it("accepts empty and null selections", () => {
    expect(validateVoicePreferences({}, DEFAULT_VOICE_CONFIG)).toEqual({
      dictationStt: null, conversationStt: null, conversationTts: null, voice: null,
    });
  });
  it("rejects unknown, disabled, and wrong-kind models", () => {
    expect(() => validateVoicePreferences(
        { dictationStt: "@cf/deepgram/unknown" }, DEFAULT_VOICE_CONFIG)).toThrow("not offered");
    let admin = structuredClone(DEFAULT_VOICE_CONFIG);
    admin.models.find(entry => entry.modelId === NOVA)!.enabled = false;
    expect(() => validateVoicePreferences({ dictationStt: NOVA }, admin)).toThrow("not offered");
    expect(() => validateVoicePreferences(
        { dictationStt: AURA2 }, DEFAULT_VOICE_CONFIG)).toThrow("can't serve dictationStt");
  });
  it("validates the voice against the effective TTS model", () => {
    expect(validateVoicePreferences({ voice: "zeus" }, DEFAULT_VOICE_CONFIG).voice).toBe("zeus");
    expect(() => validateVoicePreferences(
        { voice: "nobody" }, DEFAULT_VOICE_CONFIG)).toThrow('not offered for "@cf/deepgram/aura-2-en"');
  });
});

describe("offeredVoiceModels", () => {
  it("lists only enabled, runnable models", () => {
    let admin = structuredClone(DEFAULT_VOICE_CONFIG);
    admin.models.find(entry => entry.modelId === NOVA)!.enabled = false;
    expect(offeredVoiceModels(admin).map(entry => entry.modelId)).toEqual([FLUX, AURA2]);
  });
});
