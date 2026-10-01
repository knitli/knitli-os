// Admin panel for the deployment's voice curation: which speech models are offered, the
// default per role, and each TTS model's voices. Users pick within the offered set; calls resolve
// the user's pick, then these defaults, then built-ins.
//
// Every edit replaces the whole curation (AdminApi.setVoiceConfig) and re-reads it, like the
// formats panel: voice is edited rarely, so re-reading beats an optimistic local copy.

import { useState } from 'react'
import { Button, Input, Radio, Select, Switch, useKumoToastManager } from '@cloudflare/kumo'
import { Play, Plus, Stop, Trash } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type {
  AdminApi,
  VoiceAdminConfig,
  VoiceModelEntry,
  VoiceModelKind,
  VoiceRole,
} from '@gadgets/workshop-shared/api'
import { AURA2_VOICES, SUPPORTED_VOICE_MODELS } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../../AuthContext'
import { useVoicePreview } from '../../../hooks/useVoicePreview'

const ROLE_SECTIONS: { role: VoiceRole; title: string; blurb: string; kind: VoiceModelKind }[] = [
  {
    role: 'dictationStt',
    title: 'Dictation',
    blurb: 'Transcribes dictated text into the composer.',
    kind: 'stt',
  },
  {
    role: 'conversationStt',
    title: 'Conversation input',
    blurb: 'Hears the user during voice conversations.',
    kind: 'stt',
  },
  {
    role: 'conversationTts',
    title: 'Agent voice',
    blurb: 'Speaks agent responses during voice conversations.',
    kind: 'tts',
  },
]

export const AdminVoicePanel = ({
  admin,
  voice,
  onChanged,
}: {
  admin: RpcStub<AdminApi>
  voice: VoiceAdminConfig
  /** Re-fetch after a mutation (see AdminFormatsPanel). */
  onChanged: () => Promise<void>
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const { isPlaying, play } = useVoicePreview(authenticatedApi)
  const [busy, setBusy] = useState(false)
  const [addModelId, setAddModelId] = useState<string | undefined>(undefined)

  // Every mutation funnels through here, so the panel can't issue overlapping writes and always
  // re-reads the authoritative curation afterwards.
  const mutate = async (op: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    try {
      await op()
      await onChanged()
    } catch (err) {
      // Validation messages are written for this surface, so show them verbatim.
      toasts.add({
        title: err instanceof Error ? err.message : "Couldn't update voice settings",
        variant: 'error',
      })
    } finally {
      setBusy(false)
    }
  }

  const setConfig = (next: VoiceAdminConfig) => mutate(() => admin.setVoiceConfig(next))

  const preview = async (modelId: string, voiceId: string) => {
    try {
      await play(modelId, voiceId)
    } catch (err) {
      console.error('Voice preview failed:', err)
      toasts.add({ title: "Couldn't play the voice preview", variant: 'error' })
    }
  }

  const removeModel = (modelId: string) => {
    if (Object.values(voice.defaults).includes(modelId)) {
      toasts.add({ title: 'Change the defaults using this model first.', variant: 'error' })
      return
    }
    return setConfig({ ...voice, models: voice.models.filter((entry) => entry.modelId !== modelId) })
  }

  const addable = SUPPORTED_VOICE_MODELS.filter(
    (supported) => !voice.models.some((entry) => entry.modelId === supported.modelId),
  )

  const addModel = () => {
    const supported = addable.find((entry) => entry.modelId === addModelId)
    if (!supported) return
    const entry: VoiceModelEntry = {
      modelId: supported.modelId,
      kind: supported.kind,
      name: supported.name,
      description: supported.description,
      enabled: true,
      // Aura 2's speakers are fixed by the provider, so seed the full list; other models start
      // empty and the admin adds the speakers they want to offer.
      ...(supported.modelId === '@cf/deepgram/aura-2-en'
        ? {
            voices: AURA2_VOICES.map((id) => ({
              id,
              name: id.charAt(0).toUpperCase() + id.slice(1),
            })),
            defaultVoice: 'luna',
          }
        : {}),
    }
    setAddModelId(undefined)
    return setConfig({ ...voice, models: [...voice.models, entry] })
  }

  return (
    <div className="grid gap-6">
      <div className="rounded-xl border border-kumo-line bg-kumo-elevated p-6">
        <h2 className="mb-1 text-lg font-semibold text-kumo-strong">Speech models</h2>
        <p className="mb-5 text-sm text-kumo-subtle">
          The transcription and voice models people can choose for dictation and conversation.
          Turning a model off hides it from the pickers; calls already running are unaffected.
        </p>

        <div className="mb-5 flex flex-col gap-2">
          {voice.models.map((entry) => (
            <div
              key={entry.modelId}
              className="flex items-center gap-3 rounded-lg border border-kumo-line bg-kumo-base p-3"
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-kumo-default">{entry.name}</span>
                  <span className="shrink-0 rounded bg-kumo-tint px-1.5 py-0.5 text-xs text-kumo-subtle">
                    {entry.kind === 'stt' ? 'Transcription' : 'Voice'}
                  </span>
                  {!entry.enabled && (
                    <span className="shrink-0 rounded bg-kumo-tint px-1.5 py-0.5 text-xs text-kumo-subtle">
                      Off
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block truncate font-mono text-[0.9em] text-kumo-subtle">
                  {entry.modelId}
                </span>
                {entry.description && (
                  <span className="mt-0.5 block truncate text-xs text-kumo-subtle">
                    {entry.description}
                  </span>
                )}
              </span>
              <Switch
                aria-label={`${entry.name} offered`}
                checked={entry.enabled}
                disabled={busy}
                onCheckedChange={(enabled) =>
                  setConfig({
                    ...voice,
                    models: voice.models.map((candidate) =>
                      candidate.modelId === entry.modelId ? { ...candidate, enabled } : candidate,
                    ),
                  })
                }
              />
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => removeModel(entry.modelId)}
                aria-label={`Remove ${entry.name}`}
              >
                <Trash size={14} />
              </Button>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-52 flex-1">
            <Select
              aria-label="Choose a model to offer"
              placeholder="Choose a model to offer"
              value={addModelId}
              onValueChange={(value) => setAddModelId(value as string | undefined)}
              renderValue={(id) =>
                addable.find((entry) => entry.modelId === id)?.name ?? (id as string)
              }
            >
              {addable.map((entry) => (
                <Select.Option key={entry.modelId} value={entry.modelId}>
                  {entry.name}
                </Select.Option>
              ))}
            </Select>
          </div>
          <Button variant="secondary" disabled={busy || !addModelId} onClick={addModel}>
            <Plus size={14} className="mr-1.5" />
            Offer model
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-kumo-line bg-kumo-elevated p-6">
        <h2 className="mb-1 text-lg font-semibold text-kumo-strong">Defaults</h2>
        <p className="mb-5 text-sm text-kumo-subtle">
          The models used until someone picks their own. Only offered models can be defaults.
        </p>
        <div className="grid gap-6">
          {ROLE_SECTIONS.map((section) => {
            const options = voice.models.filter(
              (entry) => entry.enabled && entry.kind === section.kind,
            )
            return (
              <div key={section.role} className="grid gap-1.5">
                <div className="grid gap-1.5">
                  <h3 className="text-sm font-medium text-kumo-default">{section.title}</h3>
                  <p className="text-sm text-kumo-subtle">{section.blurb}</p>
                </div>
                {options.length === 0 ? (
                  <p className="text-sm text-kumo-subtle">
                    No offered {section.kind === 'stt' ? 'transcription' : 'voice'} model.
                  </p>
                ) : (
                  <Radio.Group
                    appearance="card"
                    value={voice.defaults[section.role]}
                    onValueChange={(modelId) =>
                      setConfig({
                        ...voice,
                        defaults: { ...voice.defaults, [section.role]: modelId },
                      })
                    }
                    disabled={busy}
                  >
                    <Radio.Legend className="sr-only">{section.title}</Radio.Legend>
                    {options.map((entry) => (
                      <Radio.Item
                        key={entry.modelId}
                        value={entry.modelId}
                        label={entry.name}
                        description={entry.description}
                      />
                    ))}
                  </Radio.Group>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {voice.models
        .filter((entry) => entry.kind === 'tts')
        .map((entry) => (
          <TtsVoicesCard
            key={entry.modelId}
            entry={entry}
            busy={busy}
            isPlaying={(voiceId) => isPlaying(entry.modelId, voiceId)}
            onPreview={(voiceId) => preview(entry.modelId, voiceId)}
            onChange={(next) =>
              setConfig({
                ...voice,
                models: voice.models.map((candidate) =>
                  candidate.modelId === entry.modelId ? next : candidate,
                ),
              })
            }
          />
        ))}
    </div>
  )
}

// One TTS model's speakers: who people can pick, which one is the default, and how each sounds.
function TtsVoicesCard({
  entry,
  busy,
  isPlaying,
  onPreview,
  onChange,
}: {
  entry: VoiceModelEntry
  busy: boolean
  isPlaying: (voiceId: string) => boolean
  onPreview: (voiceId: string) => void
  onChange: (next: VoiceModelEntry) => void
}) {
  const voices = entry.voices ?? []
  const [speaker, setSpeaker] = useState<string | undefined>(undefined)
  const [speakerId, setSpeakerId] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  // Aura 2's speakers are a fixed provider list, so offer the remaining ones; any other model
  // takes a free-form speaker id.
  const fixedSpeakers =
    entry.modelId === '@cf/deepgram/aura-2-en'
      ? AURA2_VOICES.filter((id) => !voices.some((voice) => voice.id === id))
      : null
  const newId = fixedSpeakers ? (speaker ?? '') : speakerId.trim()
  const newName = name.trim() || (newId ? newId.charAt(0).toUpperCase() + newId.slice(1) : '')

  const addVoice = () => {
    if (!newId || !newName) return
    onChange({
      ...entry,
      voices: [
        ...voices,
        {
          id: newId,
          name: newName,
          ...(description.trim() ? { description: description.trim() } : {}),
        },
      ],
      // The first voice becomes the default so the model is immediately usable.
      ...(voices.length === 0 ? { defaultVoice: newId } : {}),
    })
    setSpeaker(undefined)
    setSpeakerId('')
    setName('')
    setDescription('')
  }

  return (
    <div className="rounded-xl border border-kumo-line bg-kumo-elevated p-6">
      <h2 className="mb-1 text-lg font-semibold text-kumo-strong">Voices for {entry.name}</h2>
      <p className="mb-5 text-sm text-kumo-subtle">
        The speakers people can choose for this model. Play one to hear the sample it reads.
        {!entry.enabled && ' This model is turned off, so its voices are hidden from the pickers.'}
      </p>

      {voices.length === 0 ? (
        <p className="mb-5 rounded-lg border border-kumo-line bg-kumo-base px-4 py-5 text-center text-sm text-kumo-subtle">
          No voices yet. Until you add one, calls use the fallback speaker.
        </p>
      ) : (
        <div className="mb-5 flex max-h-96 flex-col gap-2 overflow-y-auto">
          {voices.map((voice) => {
            const playing = isPlaying(voice.id)
            const isDefault = entry.defaultVoice === voice.id
            return (
              <div
                key={voice.id}
                className="flex items-center gap-3 rounded-lg border border-kumo-line bg-kumo-base p-3"
              >
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => onPreview(voice.id)}
                  aria-label={playing ? `Stop previewing ${voice.name}` : `Preview ${voice.name}`}
                >
                  {playing ? <Stop size={14} /> : <Play size={14} />}
                </Button>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-kumo-default">
                      {voice.name}
                    </span>
                    {isDefault && (
                      <span className="shrink-0 rounded bg-kumo-tint px-1.5 py-0.5 text-xs text-kumo-subtle">
                        Default
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-[0.9em] text-kumo-subtle">
                    {voice.id}
                  </span>
                  {voice.description && (
                    <span className="mt-0.5 block truncate text-xs text-kumo-subtle">
                      {voice.description}
                    </span>
                  )}
                </span>
                {!isDefault && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => onChange({ ...entry, defaultVoice: voice.id })}
                  >
                    Make default
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    onChange({
                      ...entry,
                      voices: voices.filter((candidate) => candidate.id !== voice.id),
                      // Removing the default clears it; resolution falls back to the first voice.
                      ...(isDefault ? { defaultVoice: undefined } : {}),
                    })
                  }
                  aria-label={`Remove ${voice.name}`}
                >
                  <Trash size={14} />
                </Button>
              </div>
            )
          })}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2">
        {fixedSpeakers ? (
          <div className="min-w-40 flex-1">
            <Select
              aria-label="Choose a speaker"
              placeholder="Choose a speaker"
              value={speaker}
              onValueChange={(value) => {
                const id = value as string | undefined
                setSpeaker(id)
                if (id && !name.trim()) setName(id.charAt(0).toUpperCase() + id.slice(1))
              }}
              renderValue={(id) => (id as string)}
              disabled={busy || fixedSpeakers.length === 0}
            >
              {fixedSpeakers.map((id) => (
                <Select.Option key={id} value={id}>
                  {id}
                </Select.Option>
              ))}
            </Select>
          </div>
        ) : (
          <div className="min-w-40 flex-1">
            <Input
              value={speakerId}
              onChange={(e) => setSpeakerId(e.target.value)}
              placeholder="Speaker id"
              aria-label="Speaker id"
              disabled={busy}
            />
          </div>
        )}
        <div className="min-w-40 flex-1">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Display name"
            aria-label="Display name"
            disabled={busy}
          />
        </div>
        <div className="min-w-40 flex-1">
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            aria-label="Description (optional)"
            disabled={busy}
          />
        </div>
        <Button variant="secondary" disabled={busy || !newId || !newName} onClick={addVoice}>
          <Plus size={14} className="mr-1.5" />
          Add voice
        </Button>
      </div>
    </div>
  )
}
