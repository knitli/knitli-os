import { describe, expect, it } from 'vitest'
import {
  buildAiExecutorProfileInput,
  createAiExecutorFormDraft,
  switchAiExecutorProvider,
} from './ai-executors-form-model'

describe('AI executor form model', () => {
  it('constructs each provider’s exact public input shape', () => {
    const common = {
      label: 'Primary executor',
      maxInputBytes: '1024',
      maxOutputTokens: '256',
      timeoutMs: '5000',
      requestsPerMinute: '10',
    }

    expect(buildAiExecutorProfileInput({
      ...common,
      provider: 'aws-bedrock',
      model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      byokAlias: 'must-not-pass-to-bedrock',
    })).toEqual({
      ok: true,
      input: {
        ...common,
        maxInputBytes: 1024,
        maxOutputTokens: 256,
        timeoutMs: 5000,
        requestsPerMinute: 10,
        provider: 'aws-bedrock',
        model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      },
    })

    expect(buildAiExecutorProfileInput({
      ...common,
      provider: 'azure-openai',
      model: 'gpt-4.1',
      resource: 'contoso',
      deployment: 'production',
      apiVersion: '2024-10-21',
      byokAlias: 'azure-prod',
    })).toEqual({
      ok: true,
      input: {
        ...common,
        maxInputBytes: 1024,
        maxOutputTokens: 256,
        timeoutMs: 5000,
        requestsPerMinute: 10,
        provider: 'azure-openai',
        model: 'gpt-4.1',
        resource: 'contoso',
        deployment: 'production',
        apiVersion: '2024-10-21',
        byokAlias: 'azure-prod',
      },
    })

    expect(buildAiExecutorProfileInput({
      ...common,
      provider: 'openrouter',
      model: 'openai/gpt-5-mini',
      byokAlias: 'router-prod',
    })).toEqual({
      ok: true,
      input: {
        ...common,
        maxInputBytes: 1024,
        maxOutputTokens: 256,
        timeoutMs: 5000,
        requestsPerMinute: 10,
        provider: 'openrouter',
        model: 'openai/gpt-5-mini',
        byokAlias: 'router-prod',
      },
    })
  })

  it('rejects missing provider fields and non-positive or non-finite integer limits', () => {
    const result = buildAiExecutorProfileInput({
      ...createAiExecutorFormDraft('azure-openai'),
      label: '  ',
      maxInputBytes: '1.5',
      maxOutputTokens: '0',
      timeoutMs: 'Infinity',
      requestsPerMinute: '-1',
      model: '',
      resource: '',
      deployment: '',
      apiVersion: '',
    })

    expect(result).toEqual({
      ok: false,
      errors: {
        label: 'Enter a label.',
        maxInputBytes: 'Enter a positive whole number.',
        maxOutputTokens: 'Enter a positive whole number.',
        timeoutMs: 'Enter a positive whole number.',
        requestsPerMinute: 'Enter a positive whole number.',
        model: 'Enter a model.',
        resource: 'Enter an Azure resource.',
        deployment: 'Enter an Azure deployment.',
        apiVersion: 'Enter an Azure API version.',
      },
    })
  })

  it('accepts labels and models at their exact UTF-8 byte limits', () => {
    const result = buildAiExecutorProfileInput({
      ...createAiExecutorFormDraft('openrouter'),
      label: 'é'.repeat(50),
      maxInputBytes: '1024',
      maxOutputTokens: '256',
      timeoutMs: '5000',
      requestsPerMinute: '10',
      model: 'é'.repeat(128),
    })

    expect(result).toEqual({
      ok: true,
      input: {
        provider: 'openrouter',
        label: 'é'.repeat(50),
        maxInputBytes: 1024,
        maxOutputTokens: 256,
        timeoutMs: 5000,
        requestsPerMinute: 10,
        model: 'é'.repeat(128),
      },
    })
  })

  it('rejects labels and models over their UTF-8 byte limits', () => {
    const result = buildAiExecutorProfileInput({
      ...createAiExecutorFormDraft('openrouter'),
      label: `${'é'.repeat(50)}a`,
      maxInputBytes: '1024',
      maxOutputTokens: '256',
      timeoutMs: '5000',
      requestsPerMinute: '10',
      model: `${'é'.repeat(128)}a`,
    })

    expect(result).toEqual({
      ok: false,
      errors: {
        label: 'Label must be 100 UTF-8 bytes or fewer.',
        model: 'Model must be 256 UTF-8 bytes or fewer.',
      },
    })
  })

  it('switches providers without retaining Azure or BYOK fields', () => {
    const azure = {
      ...createAiExecutorFormDraft('azure-openai'),
      model: 'gpt-4.1',
      resource: 'contoso',
      deployment: 'production',
      apiVersion: '2024-10-21',
      byokAlias: 'azure-prod',
    }

    expect(switchAiExecutorProvider(azure, 'aws-bedrock')).toEqual({
      ...createAiExecutorFormDraft('aws-bedrock'),
      label: azure.label,
      maxInputBytes: azure.maxInputBytes,
      maxOutputTokens: azure.maxOutputTokens,
      timeoutMs: azure.timeoutMs,
      requestsPerMinute: azure.requestsPerMinute,
      model: azure.model,
    })
  })

  it('omits hostile transport, credential, and raw-error keys from returned input', () => {
    const result = buildAiExecutorProfileInput({
      label: 'OpenRouter',
      maxInputBytes: '1024',
      maxOutputTokens: '256',
      timeoutMs: '5000',
      requestsPerMinute: '10',
      provider: 'openrouter',
      model: 'openai/gpt-5-mini',
      endpoint: 'https://attacker.invalid',
      apiUrl: 'https://attacker.invalid',
      token: 'secret-token',
      secret: 'secret-value',
      headers: { authorization: 'Bearer secret' },
      rawBody: 'provider response',
      resource: 'stale-resource',
      deployment: 'stale-deployment',
      apiVersion: 'stale-version',
    })

    expect(result).toEqual({
      ok: true,
      input: {
        label: 'OpenRouter',
        maxInputBytes: 1024,
        maxOutputTokens: 256,
        timeoutMs: 5000,
        requestsPerMinute: 10,
        provider: 'openrouter',
        model: 'openai/gpt-5-mini',
      },
    })
  })
})
