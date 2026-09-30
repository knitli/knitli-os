// Voice curation validation and per-call resolution: user prefs over admin defaults over
// built-in defaults. Pure functions over VoiceAdminConfig, so the call path (createVoiceSession)
// and the pickers (getVoiceOptions) resolve identically.
//
// `enabled` gates the pickers, never in-flight calls: like gatekeeper resources, disabling a
// model hides it without revoking anything, so resolution ignores it and a call always succeeds.

import {
  DEFAULT_VOICE_CONFIG,
  FALLBACK_VOICE_SPEAKER,
  VOICE_ROLES,
  VoiceAdminConfig,
  VoiceDefinition,
  VoiceMode,
  VoiceModelEntry,
  VoiceModelKind,
  VoicePreferences,
  VoiceRole,
  VoiceSpec,
  isSupportedVoiceModel,
  isVoiceModelKind,
} from "@gadgets/workshop-shared/api";

/** Longest admin-authored voice/model display name the voice API accepts. */
export const MAX_VOICE_LABEL_LENGTH = 80;

/** Longest admin-authored voice/model description the voice API accepts. */
export const MAX_VOICE_DESCRIPTION_LENGTH = 280;

/** The expected model kind per role: both STT roles transcribe, the TTS role synthesizes. */
const ROLE_KIND: Record<VoiceRole, VoiceModelKind> = {
  dictationStt: "stt",
  conversationStt: "stt",
  conversationTts: "tts",
};

function cleanLabel(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${what} must not be blank.`);
  let trimmed = value.trim();
  if (trimmed.length > MAX_VOICE_LABEL_LENGTH) {
    throw new Error(`${what} too long (max ${MAX_VOICE_LABEL_LENGTH} characters).`);
  }
  return trimmed;
}

function cleanDescription(value: unknown, what: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${what} must be a string.`);
  let trimmed = value.trim();
  if (trimmed.length > MAX_VOICE_DESCRIPTION_LENGTH) {
    throw new Error(`${what} too long (max ${MAX_VOICE_DESCRIPTION_LENGTH} characters).`);
  }
  return trimmed || undefined;
}

function cleanVoices(value: unknown, modelId: string): VoiceDefinition[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`Voices for "${modelId}" must be a list.`);
  let seen = new Set<string>();
  return value.map((raw, i) => {
    let what = `Voice ${i + 1} of "${modelId}"`;
    if (!raw || typeof raw !== "object") throw new Error(`${what} must be an object.`);
    let { id, name, description } = raw as Partial<VoiceDefinition>;
    if (typeof id !== "string" || !id.trim()) throw new Error(`${what} needs a speaker id.`);
    if (seen.has(id)) throw new Error(`Duplicate voice "${id}" in "${modelId}".`);
    seen.add(id);
    return { id, name: cleanLabel(name, `${what} name`), ...(() => {
      let cleaned = cleanDescription(description, `${what} description`);
      return cleaned === undefined ? {} : { description: cleaned };
    })() };
  });
}

/**
 * Strictly validate an admin-supplied voice curation, throwing with a UI-ready message. Every
 * model id must be one the backend can run, and every default must name an enabled model of the
 * role's kind with (for TTS) a listed default voice.
 */
export function validateVoiceConfig(config: unknown): VoiceAdminConfig {
  if (!config || typeof config !== "object") throw new Error("Voice config must be an object.");
  let { models, defaults } = config as Partial<VoiceAdminConfig>;
  if (!Array.isArray(models)) throw new Error("Voice config needs a model list.");
  if (!defaults || typeof defaults !== "object") {
    throw new Error("Voice config needs a default per role.");
  }

  let seen = new Set<string>();
  let clean: VoiceModelEntry[] = models.map((raw, i) => {
    if (!raw || typeof raw !== "object") throw new Error(`Voice model ${i + 1} must be an object.`);
    let entry = raw as Partial<VoiceModelEntry>;
    if (typeof entry.modelId !== "string" || !entry.modelId) {
      throw new Error(`Voice model ${i + 1} needs a model id.`);
    }
    if (!isVoiceModelKind(entry.kind)) {
      throw new Error(`Voice model "${entry.modelId}" needs kind "stt" or "tts".`);
    }
    if (!isSupportedVoiceModel(entry.modelId, entry.kind)) {
      throw new Error(`Voice model "${entry.modelId}" is not supported.`);
    }
    if (seen.has(entry.modelId)) throw new Error(`Duplicate voice model "${entry.modelId}".`);
    seen.add(entry.modelId);
    let voices = entry.kind === "tts" ? cleanVoices(entry.voices, entry.modelId) : undefined;
    let defaultVoice = entry.kind === "tts" && typeof entry.defaultVoice === "string"
        && entry.defaultVoice ? entry.defaultVoice : undefined;
    if (defaultVoice && !voices?.some(voice => voice.id === defaultVoice)) {
      throw new Error(`Default voice "${defaultVoice}" is not offered for "${entry.modelId}".`);
    }
    let description = cleanDescription(entry.description, `Description of "${entry.modelId}"`);
    return {
      modelId: entry.modelId,
      kind: entry.kind,
      name: cleanLabel(entry.name, `Name of "${entry.modelId}"`),
      ...(description === undefined ? {} : { description }),
      enabled: entry.enabled !== false,
      ...(voices === undefined ? {} : { voices }),
      ...(defaultVoice === undefined ? {} : { defaultVoice }),
    };
  });

  let byId = new Map(clean.map(entry => [entry.modelId, entry]));
  let cleanDefaults = {} as Record<VoiceRole, string>;
  for (let role of VOICE_ROLES) {
    let id = (defaults as Partial<Record<VoiceRole, string>>)[role];
    let entry = typeof id === "string" ? byId.get(id) : undefined;
    if (!entry) throw new Error(`Default ${role} names no offered model.`);
    if (!entry.enabled) throw new Error(`Default ${role} names disabled model "${id}".`);
    if (entry.kind !== ROLE_KIND[role]) {
      throw new Error(`Default ${role} must be a ${ROLE_KIND[role]} model.`);
    }
    cleanDefaults[role] = entry.modelId;
  }
  return { models: clean, defaults: cleanDefaults };
}

// Lenient read-path parse: drop malformed and unsupported entries, repair defaults to the
// built-in ones. A hand-edited KV mirror must never wedge the call path.
function parseVoiceModel(raw: unknown): VoiceModelEntry | null {
  if (!raw || typeof raw !== "object") return null;
  let entry = raw as Partial<VoiceModelEntry>;
  if (typeof entry.modelId !== "string" || !entry.modelId) return null;
  if (!isVoiceModelKind(entry.kind)) return null;
  if (!isSupportedVoiceModel(entry.modelId, entry.kind)) return null;
  if (typeof entry.name !== "string" || !entry.name.trim()) return null;
  let clean: VoiceModelEntry = {
    modelId: entry.modelId,
    kind: entry.kind,
    name: entry.name.trim().slice(0, MAX_VOICE_LABEL_LENGTH),
    enabled: entry.enabled !== false,
  };
  if (typeof entry.description === "string" && entry.description.trim()) {
    clean.description = entry.description.trim().slice(0, MAX_VOICE_DESCRIPTION_LENGTH);
  }
  if (entry.kind === "tts" && Array.isArray(entry.voices)) {
    let seen = new Set<string>();
    let voices: VoiceDefinition[] = [];
    for (let voice of entry.voices) {
      if (!voice || typeof voice !== "object") continue;
      let { id, name, description } = voice as Partial<VoiceDefinition>;
      if (typeof id !== "string" || !id || seen.has(id)) continue;
      if (typeof name !== "string" || !name.trim()) continue;
      seen.add(id);
      voices.push({
        id,
        name: name.trim().slice(0, MAX_VOICE_LABEL_LENGTH),
        ...(typeof description === "string" && description.trim()
            ? { description: description.trim().slice(0, MAX_VOICE_DESCRIPTION_LENGTH) } : {}),
      });
    }
    clean.voices = voices;
    if (typeof entry.defaultVoice === "string" && seen.has(entry.defaultVoice)) {
      clean.defaultVoice = entry.defaultVoice;
    }
  }
  return clean;
}

/** Lenient read-path parse of a stored voice curation (see parseFormats). Never throws. */
export function parseVoiceConfig(value: unknown): VoiceAdminConfig {
  let models: VoiceModelEntry[] = [];
  let seen = new Set<string>();
  if (value && typeof value === "object" && Array.isArray((value as {models?: unknown}).models)) {
    for (let raw of (value as {models: unknown[]}).models) {
      let entry = parseVoiceModel(raw);
      if (entry && !seen.has(entry.modelId)) {
        seen.add(entry.modelId);
        models.push(entry);
      }
    }
  }
  // An empty catalog is never a valid curation (validation requires defaults naming offered
  // models), so it means the same as absent: the built-in default. Otherwise a fresh deployment
  // would resolve calls fine but show empty pickers.
  if (models.length === 0) return DEFAULT_VOICE_CONFIG;
  let byId = new Map(models.map(entry => [entry.modelId, entry]));
  let stored = value && typeof value === "object"
      ? (value as {defaults?: Partial<Record<VoiceRole, string>>}).defaults : undefined;
  let defaults = {} as Record<VoiceRole, string>;
  for (let role of VOICE_ROLES) {
    let id = stored?.[role];
    let entry = typeof id === "string" ? byId.get(id) : undefined;
    defaults[role] = entry && entry.kind === ROLE_KIND[role]
        ? entry.modelId : DEFAULT_VOICE_CONFIG.defaults[role];
  }
  return { models, defaults };
}

/** The catalog entries the pickers show: enabled models the backend can run. */
export function offeredVoiceModels(config: VoiceAdminConfig): VoiceModelEntry[] {
  return config.models.filter(entry => entry.enabled && isSupportedVoiceModel(entry.modelId, entry.kind));
}

// First candidate the backend can run as `kind`. The built-in default always qualifies, so
// resolution never fails: curation mistakes degrade to built-ins rather than breaking calls.
function resolveModelId(candidates: (string | null | undefined)[], kind: VoiceModelKind,
    role: VoiceRole): string {
  for (let id of [...candidates, DEFAULT_VOICE_CONFIG.defaults[role]]) {
    if (typeof id === "string" && id && isSupportedVoiceModel(id, kind)) return id;
  }
  return DEFAULT_VOICE_CONFIG.defaults[role];
}

/**
 * Resolve the speech models for one call: the user's pick, else the admin default, else the
 * built-in default. The speaker is the user's voice when the effective TTS model offers it, else
 * the model's default voice, else its first voice, else the cross-Aura fallback.
 */
export function resolveVoiceSpec(config: VoiceAdminConfig, prefs: VoicePreferences,
    mode: VoiceMode): VoiceSpec {
  let sttRole: VoiceRole = mode === "dictate" ? "dictationStt" : "conversationStt";
  let stt = resolveModelId([prefs[sttRole], config.defaults[sttRole]], "stt", sttRole);
  if (mode === "dictate") return { stt };

  let model = resolveModelId(
      [prefs.conversationTts, config.defaults.conversationTts], "tts", "conversationTts");
  let voices = config.models.find(entry => entry.modelId === model)?.voices ?? [];
  let speaker = [prefs.voice, config.models.find(entry => entry.modelId === model)?.defaultVoice]
      .find(id => typeof id === "string" && voices.some(voice => voice.id === id))
      ?? voices[0]?.id ?? FALLBACK_VOICE_SPEAKER;
  return { stt, tts: { model, speaker } };
}

/**
 * Validate one user's voice selection against the offered catalog, returning it normalized to
 * known keys. Unknown or disabled model ids, wrong-kind ids, and voices the effective TTS model
 * doesn't offer are rejected. Unknown keys are dropped.
 */
export function validateVoicePreferences(prefs: VoicePreferences,
    config: VoiceAdminConfig): VoicePreferences {
  if (!prefs || typeof prefs !== "object") throw new Error("Voice preferences must be an object.");
  let offered = new Map(offeredVoiceModels(config).map(entry => [entry.modelId, entry]));
  let check = (id: string | null | undefined, role: VoiceRole): string | null => {
    if (id === undefined || id === null) return null;
    let entry = offered.get(id);
    if (!entry) throw new Error(`Voice model "${id}" is not offered.`);
    if (entry.kind !== ROLE_KIND[role]) throw new Error(`Voice model "${id}" can't serve ${role}.`);
    return id;
  };
  let clean: VoicePreferences = {
    dictationStt: check(prefs.dictationStt, "dictationStt"),
    conversationStt: check(prefs.conversationStt, "conversationStt"),
    conversationTts: check(prefs.conversationTts, "conversationTts"),
  };
  // The voice is validated against the TTS model that will actually speak: the user's pick when
  // set, else the admin default (which the read path guarantees names a usable TTS model).
  let ttsId = clean.conversationTts ?? config.defaults.conversationTts;
  let voices = offered.get(ttsId)?.voices ?? [];
  if (prefs.voice !== undefined && prefs.voice !== null) {
    if (!voices.some(voice => voice.id === prefs.voice)) {
      throw new Error(`Voice "${prefs.voice}" is not offered for "${ttsId}".`);
    }
    clean.voice = prefs.voice;
  } else {
    clean.voice = null;
  }
  return clean;
}
