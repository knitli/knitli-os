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

  it('accepts provider configuration at 256 UTF-8 bytes and rejects one byte over', () => {
    const exactLimit = 'é'.repeat(128)
    const overLimit = `${exactLimit}a`

    expect(buildAiExecutorProfileInput({
      ...createAiExecutorFormDraft('azure-openai'),
      label: 'Azure',
      maxInputBytes: '1024',
      maxOutputTokens: '256',
      timeoutMs: '5000',
      requestsPerMinute: '10',
      model: 'gpt-4.1',
      resource: exactLimit,
      deployment: exactLimit,
      apiVersion: exactLimit,
      byokAlias: 'a'.repeat(256),
    })).toEqual({
      ok: true,
      input: {
        provider: 'azure-openai',
        label: 'Azure',
        maxInputBytes: 1024,
        maxOutputTokens: 256,
        timeoutMs: 5000,
        requestsPerMinute: 10,
        model: 'gpt-4.1',
        resource: exactLimit,
        deployment: exactLimit,
        apiVersion: exactLimit,
        byokAlias: 'a'.repeat(256),
      },
    })

    expect(buildAiExecutorProfileInput({
      ...createAiExecutorFormDraft('azure-openai'),
      label: 'Azure',
      maxInputBytes: '1024',
      maxOutputTokens: '256',
      timeoutMs: '5000',
      requestsPerMinute: '10',
      model: 'gpt-4.1',
      resource: overLimit,
      deployment: overLimit,
      apiVersion: overLimit,
      byokAlias: overLimit,
    })).toEqual({
      ok: false,
      errors: {
        resource: 'Azure resource must be 256 UTF-8 bytes or fewer.',
        deployment: 'Azure deployment must be 256 UTF-8 bytes or fewer.',
        apiVersion: 'Azure API version must be 256 UTF-8 bytes or fewer.',
        byokAlias: 'BYOK alias must be 256 UTF-8 bytes or fewer.',
      },
    })
  })

  it.each([
    ['resource', ' contoso', 'Azure resource'],
    ['deployment', 'production ', 'Azure deployment'],
    ['apiVersion', '2024-10-21\u007f', 'Azure API version'],
    ['byokAlias', 'azure\nprod', 'BYOK alias'],
  ] as const)('rejects untrimmed or controlled Azure %s', (field, value, label) => {
    const result = buildAiExecutorProfileInput({
      ...createAiExecutorFormDraft('azure-openai'),
      label: 'Azure',
      maxInputBytes: '1024',
      maxOutputTokens: '256',
      timeoutMs: '5000',
      requestsPerMinute: '10',
      model: 'gpt-4.1',
      resource: 'contoso',
      deployment: 'production',
      apiVersion: '2024-10-21',
      byokAlias: 'azure-prod',
      [field]: value,
    })

    expect(result).toEqual({
      ok: false,
      errors: {[field]: `${label} must be trimmed and contain no ASCII control characters.`},
    })
  })

  it.each([
    [' router-prod', 'untrimmed'],
    ['router\tprod', 'controlled'],
  ] as const)('rejects %s OpenRouter BYOK aliases (%s)', (byokAlias, _kind) => {
    const result = buildAiExecutorProfileInput({
      ...createAiExecutorFormDraft('openrouter'),
      label: 'OpenRouter',
      maxInputBytes: '1024',
      maxOutputTokens: '256',
      timeoutMs: '5000',
      requestsPerMinute: '10',
      model: 'openai/gpt-5-mini',
      byokAlias,
    })

    expect(result).toEqual({
      ok: false,
      errors: {byokAlias: 'BYOK alias must be trimmed and contain no ASCII control characters.'},
    })
  })

  it.each(['azure-openai', 'openrouter'] as const)(
    'rejects a non-header-safe %s BYOK alias',
    (provider) => {
      const result = buildAiExecutorProfileInput({
        ...createAiExecutorFormDraft(provider),
        label: 'Executor',
        maxInputBytes: '1024',
        maxOutputTokens: '256',
        timeoutMs: '5000',
        requestsPerMinute: '10',
        model: provider === 'azure-openai' ? 'gpt-4.1' : 'openai/gpt-5-mini',
        ...(provider === 'azure-openai'
          ? {
              resource: 'contoso',
              deployment: 'production',
              apiVersion: '2024-10-21',
            }
          : {}),
        byokAlias: 'primary-🚀',
      })

      expect(result).toEqual({
        ok: false,
        errors: {
          byokAlias:
            'BYOK alias must use only ASCII letters, digits, periods, underscores, or hyphens.',
        },
      })
    },
  )

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
