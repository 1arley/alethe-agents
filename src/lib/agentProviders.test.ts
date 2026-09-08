import { afterEach, describe, expect, it } from 'vitest'

import {
  agentAccentToken,
  agentAccentVar,
  agentLabel,
  agentProviderContributions,
  allAgentTypes,
  findAgentProvider,
  isAgentEnabled,
  isBuiltinAgentType,
  isKnownAgentType,
  parseAgentType,
  resolveAgentCliCommand,
  resolveUnrestrictedFlag,
  type AgentProviderContribution,
} from './agentProviders'
import type { Disposable } from './plugins/types'

const CURSOR: AgentProviderContribution = {
  id: 'cursor',
  label: 'Cursor CLI',
  cliCommand: 'cursor-agent',
  unrestrictedFlag: '--force',
  accentToken: '--agent-cursor',
}

const registered: Disposable[] = []

function register(contribution: AgentProviderContribution): Disposable {
  const handle = agentProviderContributions.add('test-plugin', contribution)
  registered.push(handle)
  return handle
}

afterEach(() => {
  while (registered.length) registered.pop()?.dispose()
})

describe('builtin agent types', () => {
  it('resolves labels, CLI commands and unrestricted flags from the built-in tables', () => {
    expect(isBuiltinAgentType('claude')).toBe(true)
    expect(agentLabel('claude')).toBe('Claude Code')
    expect(resolveAgentCliCommand('claude')).toBe('claude')
    expect(resolveUnrestrictedFlag('claude')).toBe('--dangerously-skip-permissions')

    expect(resolveAgentCliCommand('antigravity')).toBe('agy')
    expect(resolveAgentCliCommand('kiro')).toBe('kiro-cli')
    expect(resolveAgentCliCommand('shell')).toBeUndefined()
    expect(resolveUnrestrictedFlag('shell')).toBeNull()
    expect(agentAccentToken('claude')).toBe('--agent-claude')
  })

  it('lists every built-in before any contribution', () => {
    expect(allAgentTypes()).toContain('shell')
    register(CURSOR)
    expect(allAgentTypes().at(-1)).toBe('cursor')
  })
})

describe('contributed agent providers', () => {
  it('resolves everything the contribution declares', () => {
    register(CURSOR)

    expect(isBuiltinAgentType('cursor')).toBe(false)
    expect(isKnownAgentType('cursor')).toBe(true)
    expect(findAgentProvider('cursor')?.label).toBe('Cursor CLI')
    expect(agentLabel('cursor')).toBe('Cursor CLI')
    expect(resolveAgentCliCommand('cursor')).toBe('cursor-agent')
    expect(resolveUnrestrictedFlag('cursor')).toBe('--force')
    expect(agentAccentToken('cursor')).toBe('--agent-cursor')
    expect(allAgentTypes()).toContain('cursor')
  })

  it('falls back per field when the contribution omits it', () => {
    register({ id: 'aider', label: 'Aider' })

    expect(resolveAgentCliCommand('aider')).toBeUndefined()
    expect(resolveUnrestrictedFlag('aider')).toBeNull()
    expect(agentAccentToken('aider')).toBe('--agent-shell')
  })

  it('ignores an accent token that is not a custom property', () => {
    register({ id: 'weird', label: 'Weird', accentToken: 'agent-weird' })

    expect(agentAccentToken('weird')).toBe('--agent-shell')
  })

  it('stops resolving once the contribution is disposed', () => {
    const handle = register(CURSOR)
    expect(isKnownAgentType('cursor')).toBe(true)

    handle.dispose()

    expect(isKnownAgentType('cursor')).toBe(false)
    expect(findAgentProvider('cursor')).toBeUndefined()
    expect(agentLabel('cursor')).toBe('cursor')
    expect(resolveAgentCliCommand('cursor')).toBeUndefined()
    expect(allAgentTypes()).not.toContain('cursor')
    expect(parseAgentType('cursor')).toBeNull()
  })
})

describe('unknown agent ids', () => {
  it('degrades to the id, no command, no flag and the default accent', () => {
    expect(isKnownAgentType('nonesuch')).toBe(false)
    expect(agentLabel('nonesuch')).toBe('nonesuch')
    expect(resolveAgentCliCommand('nonesuch')).toBeUndefined()
    expect(resolveUnrestrictedFlag('nonesuch')).toBeNull()
    expect(agentAccentToken('nonesuch')).toBe('--agent-shell')
    expect(agentAccentVar('nonesuch')).toBe('var(--agent-shell, var(--agent-shell))')
  })
})

describe('parseAgentType', () => {
  it('accepts built-ins and rejects anything unknown', () => {
    expect(parseAgentType('claude')).toBe('claude')
    expect(parseAgentType('  CODEX  ')).toBe('codex')
    expect(parseAgentType('nonesuch')).toBeNull()
    expect(parseAgentType('')).toBeNull()
    expect(parseAgentType(null)).toBeNull()
    expect(parseAgentType(undefined)).toBeNull()
  })

  it('accepts a contributed id, including one that is not lowercase', () => {
    register(CURSOR)
    register({ id: 'Zed', label: 'Zed' })

    expect(parseAgentType('cursor')).toBe('cursor')
    expect(parseAgentType(' CURSOR ')).toBe('cursor')
    expect(parseAgentType('Zed')).toBe('Zed')
  })
})

describe('isAgentEnabled', () => {
  it('honours the stored flag and defaults contributed providers to on', () => {
    register(CURSOR)

    expect(isAgentEnabled({ claude: true }, 'claude')).toBe(true)
    expect(isAgentEnabled({ claude: false }, 'claude')).toBe(false)
    expect(isAgentEnabled({}, 'claude')).toBe(false)
    expect(isAgentEnabled({}, 'cursor')).toBe(true)
    expect(isAgentEnabled({ cursor: false }, 'cursor')).toBe(false)
  })
})
