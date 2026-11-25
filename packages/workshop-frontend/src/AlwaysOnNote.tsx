import type { ObserverBindingNeed } from '@gadgets/workshop-shared/api'

/** Suffix that marks an always-on (ambient) requirement's title in the Protected-resources list. */
export const alwaysOnSuffix = (requirement: ObserverBindingNeed) =>
  requirement.ambient ? ' (always on)' : null

/** Says what an always-on requirement costs a recipient; renders nothing when none is listed. */
export const AlwaysOnNote = ({ requirements }: { requirements: ObserverBindingNeed[] }) =>
  requirements.some(requirement => requirement.ambient) ? (
    <p className="mt-2 text-[12px] leading-[16px] tracking-[-0.15px] text-kumo-subtle">
      Always-on services are part of every workspace its owner has. Anyone who can’t get their
      own access to one can’t open this workspace.
    </p>
  ) : null
