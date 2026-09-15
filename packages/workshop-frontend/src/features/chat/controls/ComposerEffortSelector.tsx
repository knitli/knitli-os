import { DropdownMenu } from "@cloudflare/kumo";
import { CaretDown, Check } from "@phosphor-icons/react";

export type ComposerEffortSelectorProps = {
  /** The effort levels the selected model offers, in increasing order. */
  levels: readonly string[];
  /** The level presented as the default (annotates the Auto option). */
  defaultLevel: string;
  /** The chat's stored override, or null for the model's default. */
  selectedEffort: string | null;
  onEffortChange: (effort: string | null) => void;
};

const displayLevel = (level: string) =>
    level.length > 0 ? level[0].toUpperCase() + level.slice(1) : level;

export const ComposerEffortSelector = ({
  levels,
  defaultLevel,
  selectedEffort,
  onEffortChange,
}: ComposerEffortSelectorProps) => {
  const selectedEffortLabel =
    selectedEffort == null ? `Auto (${displayLevel(defaultLevel)})` : displayLevel(selectedEffort);

  const itemClassName =
    "!h-auto rounded-xl !px-2 !py-1.5 text-[12px] leading-4 font-normal tracking-[-0.15px] text-kumo-subtle transition-colors data-highlighted:bg-kumo-tint/70 data-highlighted:text-kumo-default";

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <button
            type="button"
            className="group inline-flex h-10 min-w-0 max-w-[110px] cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[14px] leading-5 text-kumo-subtle transition-[background-color,color,transform] duration-150 ease-out hover:bg-kumo-tint hover:text-kumo-default focus-visible:bg-kumo-tint focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.97] data-[popup-open]:bg-kumo-tint data-[popup-open]:text-kumo-default sm:h-8 sm:max-w-[180px] sm:text-[13px]"
            aria-label="Select reasoning effort"
          >
            <span className="min-w-0 truncate">{selectedEffortLabel}</span>
            <CaretDown
              size={12}
              weight="bold"
              className="flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out group-data-[popup-open]:rotate-180"
            />
          </button>
        }
      />
      <DropdownMenu.Content className="themed-floating-shadow-lg !z-[1100] !min-w-[190px] rounded-2xl border border-kumo-line/70 bg-kumo-base p-1">
        <DropdownMenu.Item onClick={() => onEffortChange(null)} className={itemClassName}>
          <span className="min-w-0 flex-1 truncate">Auto ({displayLevel(defaultLevel)})</span>
          {selectedEffort == null && (
            <Check size={12} weight="bold" className="ml-3 flex-shrink-0 text-kumo-inactive" />
          )}
        </DropdownMenu.Item>
        <div className="my-1 border-t border-kumo-line/70" />
        {levels.map((level) => {
          const active = selectedEffort === level;
          return (
            <DropdownMenu.Item
              key={level}
              onClick={() => onEffortChange(level)}
              className={itemClassName}
            >
              <span className="min-w-0 flex-1 truncate">{displayLevel(level)}</span>
              {active && (
                <Check size={12} weight="bold" className="ml-3 flex-shrink-0 text-kumo-inactive" />
              )}
            </DropdownMenu.Item>
          );
        })}
      </DropdownMenu.Content>
    </DropdownMenu>
  );
};
