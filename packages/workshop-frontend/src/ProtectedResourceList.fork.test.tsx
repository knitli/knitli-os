// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { ObserverBindingNeed } from '@gadgets/workshop-shared/api'

vi.mock('./components/GatekeeperIcon', () => ({ GatekeeperIcon: () => <span data-testid="icon" /> }))

import { ProtectedResourceList } from './ProtectedResourceList'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const DOC_REQUIREMENT: ObserverBindingNeed = {
  gatekeeperId: 7,
  vendorId: 'google',
  resourceTitle: 'Q3 planning',
}

const MEMORY_REQUIREMENT: ObserverBindingNeed = {
  gatekeeperId: 9,
  vendorId: 'memory',
  resourceTitle: 'Knitli Memory',
  ambient: true,
}

const ALWAYS_ON_NOTE =
  'Always-on services are part of every workspace its owner has. Anyone who can’t get their own access to one can’t open this workspace.'

let root: Root | undefined
let container: HTMLElement | undefined

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

function render(requirements: ObserverBindingNeed[]): HTMLElement {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root!.render(
    <ProtectedResourceList requirements={requirements} failed={false} vendorBranding={new Map()} />,
  ))
  return container
}

describe('ProtectedResourceList always-on requirements', () => {
  it('labels always-on requirements and says what they cost a recipient', () => {
    const rendered = render([DOC_REQUIREMENT, MEMORY_REQUIREMENT])

    expect(rendered.textContent).toContain('Knitli Memory (always on)')
    expect(rendered.textContent).not.toContain('Q3 planning (always on)')
    expect(rendered.textContent).toContain(ALWAYS_ON_NOTE)
  })

  it('labels an always-on requirement nested under the workpiece that puts it in scope', () => {
    const rendered = render([{
      ...MEMORY_REQUIREMENT,
      paths: [[{ type: 'gadget', id: 4, title: 'Lookup gadget' }]],
    }])

    expect(rendered.querySelector('ul ul')?.textContent).toContain('Knitli Memory (always on)')
    expect(rendered.textContent).toContain(ALWAYS_ON_NOTE)
  })

  it('says nothing about always-on services when none is required', () => {
    const rendered = render([DOC_REQUIREMENT])

    expect(rendered.textContent).toContain('Q3 planning')
    expect(rendered.textContent).not.toContain('always on')
    expect(rendered.textContent).not.toContain('Always-on services')
  })
})
