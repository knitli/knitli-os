import {
  type AiExecutorProfileInput,
  type AiExecutorProvider,
  MAX_EXECUTOR_PROFILE_LABEL_BYTES,
  MAX_EXECUTOR_PROFILE_MODEL_BYTES,
} from '@gadgets/workshop-shared/api'

const ENCODER = new TextEncoder()

export type AiExecutorFormDraft = {
  provider: AiExecutorProvider
  label: string
  maxInputBytes: string
  maxOutputTokens: string
  timeoutMs: string
  requestsPerMinute: string
  model: string
  resource: string
  deployment: string
  apiVersion: string
  byokAlias: string
}

export type AiExecutorFormField = keyof AiExecutorFormDraft

export type AiExecutorFormResult =
  | { ok: true; input: AiExecutorProfileInput }
  | { ok: false; errors: Partial<Record<AiExecutorFormField, string>> }

export function createAiExecutorFormDraft(provider: AiExecutorProvider): AiExecutorFormDraft {
  return {
    provider,
    label: '',
    maxInputBytes: '',
    maxOutputTokens: '',
    timeoutMs: '',
    requestsPerMinute: '',
    model: '',
    resource: '',
    deployment: '',
    apiVersion: '',
    byokAlias: '',
  }
}

export function switchAiExecutorProvider(
  draft: AiExecutorFormDraft,
  provider: AiExecutorProvider,
): AiExecutorFormDraft {
  return {
    ...createAiExecutorFormDraft(provider),
    label: draft.label,
    maxInputBytes: draft.maxInputBytes,
    maxOutputTokens: draft.maxOutputTokens,
    timeoutMs: draft.timeoutMs,
    requestsPerMinute: draft.requestsPerMinute,
    model: draft.model,
  }
}

function isProvider(value: unknown): value is AiExecutorProvider {
  return value === 'aws-bedrock' || value === 'azure-openai' || value === 'openrouter'
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value.trim())) return undefined
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : undefined
}

function requiredText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text === '' ? undefined : text
}

function exceedsUtf8ByteLimit(value: string, maximumBytes: number): boolean {
  return ENCODER.encode(value).byteLength > maximumBytes
}

function draftValue(draft: unknown, field: AiExecutorFormField): unknown {
  return typeof draft === 'object' && draft !== null
    ? (draft as Record<string, unknown>)[field]
    : undefined
}

export function buildAiExecutorProfileInput(draft: unknown): AiExecutorFormResult {
  const errors: Partial<Record<AiExecutorFormField, string>> = {}
  const label = requiredText(draftValue(draft, 'label'))
  const maxInputBytes = positiveInteger(draftValue(draft, 'maxInputBytes'))
  const maxOutputTokens = positiveInteger(draftValue(draft, 'maxOutputTokens'))
  const timeoutMs = positiveInteger(draftValue(draft, 'timeoutMs'))
  const requestsPerMinute = positiveInteger(draftValue(draft, 'requestsPerMinute'))
  const model = requiredText(draftValue(draft, 'model'))
  const providerValue = draftValue(draft, 'provider')

  if (!label) {
    errors.label = 'Enter a label.'
  } else if (exceedsUtf8ByteLimit(label, MAX_EXECUTOR_PROFILE_LABEL_BYTES)) {
    errors.label = `Label must be ${MAX_EXECUTOR_PROFILE_LABEL_BYTES} UTF-8 bytes or fewer.`
  }
  if (!maxInputBytes) errors.maxInputBytes = 'Enter a positive whole number.'
  if (!maxOutputTokens) errors.maxOutputTokens = 'Enter a positive whole number.'
  if (!timeoutMs) errors.timeoutMs = 'Enter a positive whole number.'
  if (!requestsPerMinute) errors.requestsPerMinute = 'Enter a positive whole number.'
  if (!model) {
    errors.model = 'Enter a model.'
  } else if (exceedsUtf8ByteLimit(model, MAX_EXECUTOR_PROFILE_MODEL_BYTES)) {
    errors.model = `Model must be ${MAX_EXECUTOR_PROFILE_MODEL_BYTES} UTF-8 bytes or fewer.`
  }
  if (!isProvider(providerValue)) errors.provider = 'Choose a provider.'

  const provider = isProvider(providerValue) ? providerValue : undefined
  const resource = requiredText(draftValue(draft, 'resource'))
  const deployment = requiredText(draftValue(draft, 'deployment'))
  const apiVersion = requiredText(draftValue(draft, 'apiVersion'))
  const byokAlias = requiredText(draftValue(draft, 'byokAlias'))

  if (provider === 'azure-openai') {
    if (!resource) errors.resource = 'Enter an Azure resource.'
    if (!deployment) errors.deployment = 'Enter an Azure deployment.'
    if (!apiVersion) errors.apiVersion = 'Enter an Azure API version.'
  }

  if (Object.keys(errors).length > 0 || !label || !maxInputBytes || !maxOutputTokens ||
      !timeoutMs || !requestsPerMinute || !model || !provider) {
    return {ok: false, errors}
  }

  const common = {label, maxInputBytes, maxOutputTokens, timeoutMs, requestsPerMinute, model}
  switch (provider) {
    case 'aws-bedrock':
      return {ok: true, input: {...common, provider}}
    case 'azure-openai':
      return {
        ok: true,
        input: {
          ...common,
          provider,
          resource: resource!,
          deployment: deployment!,
          apiVersion: apiVersion!,
          ...(byokAlias ? {byokAlias} : {}),
        },
      }
    case 'openrouter':
      return {ok: true, input: {...common, provider, ...(byokAlias ? {byokAlias} : {})}}
  }
}
