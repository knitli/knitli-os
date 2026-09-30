import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Dialog, Loader, Radio, Select, useKumoToastManager } from '@cloudflare/kumo'
import { Play, Stop, X } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type {
  AuthenticatedApi,
  VoiceModelKind,
  VoiceOptions,
  VoicePreferences,
  VoiceRole,
} from '@gadgets/workshop-shared/api'
import { useVoicePreview } from '../../../hooks/useVoicePreview'
import { WorkshopIconButton } from '../../../components/WorkshopControls'

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
    blurb: 'Hears you during voice conversations.',
    kind: 'stt',
  },
  {
    role: 'conversationTts',
    title: 'Agent voice',
    blurb: 'Speaks agent responses during voice conversations.',
    kind: 'tts',
  },
]

/**
 * The user's voice selection within the deployment's offered catalog. Each control applies
 * immediately (like the admin toggles); "Reset to defaults" clears every pick back to null.
 */
export const VoiceSettingsDialog = ({
  open,
  onOpenChange,
  api,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  api: RpcStub<AuthenticatedApi> | null
}) => {
  const toasts = useKumoToastManager()
  const { isPlaying, play } = useVoicePreview(api)
  const [options, setOptions] = useState<VoiceOptions | null>(null)
  const [saving, setSaving] = useState(false)
  const portalRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open || !api) return
    let cancelled = false
    setOptions(null)
    api.getVoiceOptions().then(
      (loaded) => {
        if (!cancelled) setOptions(loaded)
      },
      (err) => {
        console.error('Failed to load voice options:', err)
        if (!cancelled) {
          toasts.add({ title: "Couldn't load voice settings", variant: 'error' })
          onOpenChange(false)
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [open, api, onOpenChange, toasts])

  const save = useCallback(
    async (next: VoicePreferences) => {
      if (!api || !options || saving) return
      setSaving(true)
      try {
        await api.setVoicePreferences(next)
        setOptions({ ...options, preferences: next })
      } catch (err) {
        toasts.add({
          title: err instanceof Error ? err.message : "Couldn't save voice settings",
          variant: 'error',
        })
        // Re-read: a rejected write may mean the offered catalog changed underneath.
        api.getVoiceOptions().then(setOptions, () => {})
      } finally {
        setSaving(false)
      }
    },
    [api, options, saving, toasts],
  )

  const preview = async (modelId: string, voiceId: string) => {
    try {
      await play(modelId, voiceId)
    } catch (err) {
      console.error('Voice preview failed:', err)
      toasts.add({ title: "Couldn't play the voice preview", variant: 'error' })
    }
  }

  const effectiveTts =
    options?.preferences.conversationTts ?? options?.defaults.conversationTts ?? null
  const ttsEntry = options?.models.find((entry) => entry.modelId === effectiveTts)
  const effectiveVoice =
    options?.preferences.voice ?? ttsEntry?.defaultVoice ?? ttsEntry?.voices?.[0]?.id ?? null

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog className="responsive-dialog !w-[min(560px,calc(100vw-32px))]">
        <div className="flex items-start justify-between gap-4 border-b border-kumo-line px-5 py-4">
          <div className="min-w-0">
            <Dialog.Title className="text-[15px] leading-5 font-medium text-kumo-default">
              Voice settings
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-[12px] leading-4 font-normal text-kumo-subtle">
              Which models transcribe you and which voice answers back.
            </Dialog.Description>
          </div>
          <Dialog.Close
            render={(props) => (
              <WorkshopIconButton {...props} className="!h-7 !w-7" aria-label="Close">
                <X size={16} />
              </WorkshopIconButton>
            )}
          />
        </div>

        <div ref={portalRef} className="grid max-h-[60vh] gap-6 overflow-y-auto px-5 py-4">
          {!options ? (
            <div className="flex justify-center py-6">
              <Loader size="base" />
            </div>
          ) : (
            <>
              {ROLE_SECTIONS.map((section) => {
                const choices = options.models.filter((entry) => entry.kind === section.kind)
                if (choices.length === 0) return null
                return (
                  <div key={section.role} className="grid gap-1.5">
                    <div className="grid gap-1.5">
                      <h3 className="text-sm font-medium text-kumo-default">{section.title}</h3>
                      <p className="text-sm text-kumo-subtle">{section.blurb}</p>
                    </div>
                    <Radio.Group
                      value={options.preferences[section.role] ?? options.defaults[section.role]}
                      onValueChange={(modelId) =>
                        save({ ...options.preferences, [section.role]: modelId })
                      }
                      disabled={saving}
                    >
                      <Radio.Legend className="sr-only">{section.title}</Radio.Legend>
                      {choices.map((entry) => (
                        <Radio.Item
                          key={entry.modelId}
                          value={entry.modelId}
                          label={
                            <>
                              {entry.name}
                              {options.defaults[section.role] === entry.modelId && (
                                <span className="ml-2 text-xs text-kumo-subtle">Default</span>
                              )}
                            </>
                          }
                        />
                      ))}
                    </Radio.Group>
                  </div>
                )
              })}

              {ttsEntry && (ttsEntry.voices?.length ?? 0) > 0 && (
                <div className="grid gap-1.5">
                  <div className="grid gap-1.5">
                    <h3 className="text-sm font-medium text-kumo-default">Voice</h3>
                    <p className="text-sm text-kumo-subtle">
                      The speaker for {ttsEntry.name}. Play one to hear its sample.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <Select
                        aria-label="Voice"
                        container={portalRef}
                        value={effectiveVoice}
                        onValueChange={(value) =>
                          save({ ...options.preferences, voice: value as string })
                        }
                        renderValue={(id) =>
                          ttsEntry.voices?.find((voice) => voice.id === id)?.name ?? (id as string)
                        }
                        disabled={saving}
                      >
                        {ttsEntry.voices?.map((voice) => (
                          <Select.Option key={voice.id} value={voice.id}>
                            {voice.name}
                          </Select.Option>
                        ))}
                      </Select>
                    </div>
                    {effectiveVoice && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={saving}
                        onClick={() => preview(ttsEntry.modelId, effectiveVoice)}
                        aria-label={
                          isPlaying(ttsEntry.modelId, effectiveVoice)
                            ? 'Stop preview'
                            : 'Preview voice'
                        }
                      >
                        {isPlaying(ttsEntry.modelId, effectiveVoice) ? (
                          <Stop size={14} />
                        ) : (
                          <Play size={14} />
                        )}
                      </Button>
                    )}
                  </div>
                </div>
              )}

              <div className="flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={saving}
                  onClick={() =>
                    save({ dictationStt: null, conversationStt: null, conversationTts: null, voice: null })
                  }
                >
                  Reset to defaults
                </Button>
              </div>
            </>
          )}
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
