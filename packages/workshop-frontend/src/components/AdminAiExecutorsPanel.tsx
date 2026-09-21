// A native form cannot represent this deployment-wide, revisioned executor catalog lifecycle;
// this component owns its isolated load, validation, mutation, and authoritative-reload boundary.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Input, Select } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import {
  AI_EXECUTOR_ADMIN_ERROR_CODES,
  getAiExecutorAdminErrorCode,
  type AdminApi,
  type AiExecutorProfile,
  type AiExecutorProfileInput,
  type AiExecutorProvider,
} from '@gadgets/workshop-shared/api'
import {
  buildAiExecutorProfileInput,
  createAiExecutorFormDraft,
  switchAiExecutorProvider,
  type AiExecutorFormDraft,
  type AiExecutorFormField,
} from './ai-executors-form-model'

type PanelFailure = 'unavailable' | 'retryable'
type LifecycleAction = 'verify' | 'activate' | 'disable'
type LifecycleConfirmation = {
  profile: AiExecutorProfile
  action: LifecycleAction
}

function classifyFailure(error: unknown): PanelFailure {
  const code = getAiExecutorAdminErrorCode(error)
  return code === AI_EXECUTOR_ADMIN_ERROR_CODES.featureUnavailable ||
      code === AI_EXECUTOR_ADMIN_ERROR_CODES.protocolMismatch
    ? 'unavailable'
    : 'retryable'
}

function formDraftFromProfile(profile: AiExecutorProfile): AiExecutorFormDraft {
  return {
    ...createAiExecutorFormDraft(profile.provider),
    label: profile.label,
    maxInputBytes: `${profile.maxInputBytes}`,
    maxOutputTokens: `${profile.maxOutputTokens}`,
    timeoutMs: `${profile.timeoutMs}`,
    requestsPerMinute: `${profile.requestsPerMinute}`,
    model: profile.model,
    ...('resource' in profile ? {
      resource: profile.resource,
      deployment: profile.deployment,
      apiVersion: profile.apiVersion,
    } : {}),
    ...('byokAlias' in profile && profile.byokAlias ? {byokAlias: profile.byokAlias} : {}),
  }
}

function formTitle(profile: AiExecutorProfile | null): string {
  return profile ? `Edit ${profile.label}` : 'Create executor profile'
}

function lifecycleControls(profile: AiExecutorProfile): LifecycleAction[] {
  switch (profile.lifecycle) {
    case 'draft': return ['verify']
    case 'verified': return ['activate']
    case 'active': return ['disable']
    case 'disabled': return ['verify']
  }
}

function lifecycleActionLabel(action: LifecycleAction): string {
  return action[0].toUpperCase() + action.slice(1)
}

export default function AdminAiExecutorsPanel({admin}: {admin: RpcStub<AdminApi>}) {
  const [profiles, setProfiles] = useState<AiExecutorProfile[] | null>(null)
  const [failure, setFailure] = useState<PanelFailure | null>(null)
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set())
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<AiExecutorProfile | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<LifecycleConfirmation | null>(null)
  const confirmingIds = useRef(new Set<string>())
  const listGeneration = useRef(0)

  const reload = useCallback(async (): Promise<boolean> => {
    const requestGeneration = ++listGeneration.current
    setFailure(null)
    try {
      const result = await admin.listAiExecutorProfiles()
      if (requestGeneration !== listGeneration.current) return false
      setProfiles(result)
      return true
    } catch (error) {
      if (requestGeneration !== listGeneration.current) return false
      setFailure(classifyFailure(error))
      return false
    }
  }, [admin])

  useEffect(() => {
    void reload()
    return () => { listGeneration.current += 1 }
  }, [reload])

  const mutateProfile = async (
    profile: AiExecutorProfile,
    operation: (id: string, revision: number) => Promise<AiExecutorProfile>,
  ) => {
    if (busyIds.has(profile.id)) return
    setBusyIds(previous => new Set(previous).add(profile.id))
    setNotice(null)
    try {
      await operation(profile.id, profile.revision)
      await reload()
    } catch (error) {
      if (getAiExecutorAdminErrorCode(error) === AI_EXECUTOR_ADMIN_ERROR_CODES.revisionConflict) {
        await reload()
        setNotice('This profile changed; review the latest profile before editing again.')
      } else {
        setFailure(classifyFailure(error))
      }
    } finally {
      setBusyIds(previous => {
        const next = new Set(previous)
        next.delete(profile.id)
        return next
      })
    }
  }

  const beginLifecycleConfirmation = (profile: AiExecutorProfile, action: LifecycleAction) => {
    setNotice(null)
    setConfirmation({ profile, action })
  }

  const confirmLifecycle = () => {
    if (!confirmation || confirmingIds.current.has(confirmation.profile.id)) return
    const current = confirmation
    confirmingIds.current.add(current.profile.id)
    setConfirmation(null)
    const operation = (id: string, revision: number) => {
      switch (current.action) {
        case 'verify': return admin.verifyAiExecutorProfile(id, revision)
        case 'activate': return admin.activateAiExecutorProfile(id, revision)
        case 'disable': return admin.disableAiExecutorProfile(id, revision)
      }
    }
    void mutateProfile(current.profile, operation).finally(() => confirmingIds.current.delete(current.profile.id))
  }

  if (profiles === null && failure === null) {
    return <section aria-label="AI executors"><p>Loading executor profiles…</p></section>
  }

  if (failure === 'unavailable') {
    return (
      <section aria-label="AI executors">
        <h2>AI executors</h2>
        <p>Executor administration is unavailable on this deployment.</p>
      </section>
    )
  }

  if (failure === 'retryable') {
    return (
      <section aria-label="AI executors">
        <h2>AI executors</h2>
        <p>Couldn&apos;t load executor profiles.</p>
        <Button className="text-sm" type="button" onClick={() => { void reload() }}>Retry</Button>
      </section>
    )
  }

  const closeForm = () => {
    setCreating(false)
    setEditing(null)
  }

  const loadedProfiles = profiles ?? []

  return (
    <section aria-label="AI executors" className="min-w-0 rounded-xl border border-kumo-line bg-kumo-elevated px-4 py-4 text-sm text-kumo-default sm:px-6 sm:py-5">
      <h2 className="mb-1 text-lg font-semibold text-kumo-strong">AI executors</h2>
      <p className="mb-5 text-sm text-kumo-subtle">
        Configure the verified external AI executors available to this deployment.
      </p>

      {notice && <p role="status">{notice}</p>}

      {loadedProfiles.length === 0 ? (
        <p>No executor profiles</p>
      ) : (
        <div className="space-y-3">
          {loadedProfiles.map(profile => {
            const busy = busyIds.has(profile.id)
            const rowLocked = busy || confirmation?.profile.id === profile.id
            return (
              <article key={profile.id} className="min-w-0 space-y-1 break-words rounded-lg border border-kumo-line px-4 py-3 [overflow-wrap:anywhere]">
                <h3 className="font-semibold text-kumo-strong">{profile.label}</h3>
                <p>{profile.provider} · {profile.model} · {profile.lifecycle}</p>
                <p>Revision {profile.revision}</p>
              {profile.verifiedAt && <p>Verified at {profile.verifiedAt}</p>}
              {profile.verification && (
                <div>
                  <p>Verification: {profile.verification.status}</p>
                  <p>Duration: {profile.verification.durationMs} ms</p>
                  {profile.verification.gatewayLogId && (
                    <p>Gateway log ID: {profile.verification.gatewayLogId}</p>
                  )}
                  {profile.verification.message && <p>{profile.verification.message}</p>}
                </div>
              )}
                <div className="mt-3 flex flex-wrap gap-2">
                <Button className="text-sm" type="button" disabled={rowLocked} onClick={() => {
                    setNotice(null)
                    setEditing(profile)
                    setCreating(false)
                  }}>Edit</Button>
                  {lifecycleControls(profile).map(control => (
                  <Button className="text-sm" key={control} type="button" disabled={rowLocked} onClick={() => {
                    beginLifecycleConfirmation(profile, control)
                  }}>{lifecycleActionLabel(control)}</Button>
                ))}
              </div>
              {confirmation?.profile.id === profile.id && (
                <div className="mt-3 space-y-2" role="group" aria-live="polite" aria-label={`Confirm ${lifecycleActionLabel(confirmation.action)} for ${profile.label}`}>
                  <p>Confirm {lifecycleActionLabel(confirmation.action)} for {profile.label}?</p>
                  <div className="flex flex-wrap gap-2">
                    <Button className="text-sm" type="button" variant="primary" onClick={confirmLifecycle}>Confirm</Button>
                    <Button className="text-sm" type="button" variant="secondary" onClick={() => setConfirmation(null)}>Cancel</Button>
                  </div>
                </div>
              )}
            </article>
            )
          })}
        </div>
      )}

      {!creating && !editing && (
        <Button className="mt-4 text-sm" variant="primary" type="button" onClick={() => {
          setNotice(null)
          setCreating(true)
        }}>Create profile</Button>
      )}

      {(creating || editing) && (
        <ExecutorForm
          key={editing?.id ?? 'new'}
          profile={editing}
          onCancel={closeForm}
          onSave={async input => {
            try {
              if (editing) {
                await admin.updateAiExecutorProfile(editing.id, input, editing.revision)
              } else {
                await admin.createAiExecutorProfile(input)
              }
              closeForm()
              await reload()
              return null
            } catch (error) {
              if (getAiExecutorAdminErrorCode(error) === AI_EXECUTOR_ADMIN_ERROR_CODES.revisionConflict) {
                await reload()
                closeForm()
                setNotice('This profile changed; review the latest profile before editing again.')
                return null
              }
              if (classifyFailure(error) === 'unavailable') {
                closeForm()
                setFailure('unavailable')
                return null
              }
              return 'Couldn\'t save this executor profile.'
            }
          }}
        />
      )}
    </section>
  )
}

function ExecutorForm({
  profile,
  onCancel,
  onSave,
}: {
  profile: AiExecutorProfile | null
  onCancel: () => void
  onSave: (input: AiExecutorProfileInput) => Promise<string | null>
}) {
  const [draft, setDraft] = useState<AiExecutorFormDraft>(() =>
    profile ? formDraftFromProfile(profile) : createAiExecutorFormDraft('openrouter'))
  const [errors, setErrors] = useState<Partial<Record<AiExecutorFormField, string>>>({})
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const setField = (field: AiExecutorFormField, value: string) => {
    setDraft(previous => ({...previous, [field]: value}))
    setErrors(previous => ({...previous, [field]: undefined}))
  }

  const setProvider = (provider: AiExecutorProvider) => {
    setDraft(previous => switchAiExecutorProvider(previous, provider))
    setErrors({})
  }

  const save = async () => {
    const result = buildAiExecutorProfileInput(draft)
    if (!result.ok) {
      setErrors(result.errors)
      return
    }
    setSaving(true)
    setSaveError(null)
    const error = await onSave(result.input)
    if (error) setSaveError(error)
    setSaving(false)
  }

  const textField = (field: Exclude<AiExecutorFormField, 'provider'>, label: string, type = 'text') => {
    const inputId = `ai-executor-${field}`
    const errorId = `${inputId}-error`
    const error = errors[field]
    return (
    <div className="min-w-0 space-y-1.5">
      <label className="block font-medium" id={`${inputId}-label`} htmlFor={inputId}>{label}</label>
      <Input
        className={`w-full text-sm${error ? ' ring-kumo-danger' : ''}`}
        id={inputId}
        aria-labelledby={`${inputId}-label`}
        name={field}
        type={type}
        value={draft[field]}
        onChange={event => setField(field, event.currentTarget.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
      />
      {error && <p className="text-kumo-danger" id={errorId} role="alert">{error}</p>}
    </div>
    )
  }

  return (
    <form className="mt-5 space-y-4 border-t border-kumo-line pt-4" onSubmit={event => { event.preventDefault(); void save() }}>
      <h3 className="font-semibold text-kumo-strong">{formTitle(profile)}</h3>
      <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="min-w-0 space-y-1.5">
      <label className="block font-medium" id="ai-executor-provider-label" htmlFor="ai-executor-provider">Provider</label>
      <Select id="ai-executor-provider" aria-labelledby="ai-executor-provider-label" name="provider" className="w-full text-sm" value={draft.provider} onValueChange={value => { if (value) setProvider(value as AiExecutorProvider) }}>
        <Select.Option value="aws-bedrock">Amazon Bedrock</Select.Option>
        <Select.Option value="azure-openai">Azure OpenAI</Select.Option>
        <Select.Option value="openrouter">OpenRouter</Select.Option>
      </Select>
      </div>
      {textField('label', 'Label')}
      {textField('model', 'Model')}
      {textField('maxInputBytes', 'Maximum input bytes', 'number')}
      {textField('maxOutputTokens', 'Maximum output tokens', 'number')}
      {textField('timeoutMs', 'Timeout milliseconds', 'number')}
      {textField('requestsPerMinute', 'Requests per minute', 'number')}
      {draft.provider === 'azure-openai' && <>
        {textField('resource', 'Azure resource')}
        {textField('deployment', 'Azure deployment')}
        {textField('apiVersion', 'Azure API version')}
      </>}
      {draft.provider !== 'aws-bedrock' && textField('byokAlias', 'Cloudflare BYOK alias (existing reference, optional)')}
      </div>
      {saveError && <p className="text-kumo-danger" role="alert">{saveError}</p>}
      <div className="flex flex-wrap gap-2">
        <Button className="text-sm" type="submit" variant="primary" disabled={saving}>{profile ? 'Save changes' : 'Save draft'}</Button>
        <Button className="text-sm" type="button" variant="secondary" disabled={saving} onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  )
}
