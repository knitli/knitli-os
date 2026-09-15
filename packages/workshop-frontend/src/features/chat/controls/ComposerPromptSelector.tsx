import { useState } from "react";
import { Dialog, DropdownMenu } from "@cloudflare/kumo";
import { CaretDown, Check } from "@phosphor-icons/react";
import { X } from "@phosphor-icons/react";
import { WorkshopButton, WorkshopIconButton } from "../../../components/WorkshopControls";

export type PromptPresetOption = {
  id: string;
  name: string;
};

export type ComposerPromptSelectorProps = {
  /** The deployment's presets (the built-in default is implicit, never listed). */
  presets: readonly PromptPresetOption[];
  /** The chat's stored preset id, or null for the built-in default. An id absent from
   * `presets` (deleted since) displays as the default, matching the fail-closed runtime. */
  selectedPromptId: string | null;
  onPromptChange: (promptId: string | null) => void;
  /**
   * When true (an existing chat), switching asks for confirmation first: the swap busts the
   * Anthropic prefix cache. New chats switch silently -- nothing is cached yet.
   */
  requireConfirm: boolean;
};

/** The built-in prompt's display name, shared by the trigger, menu, and dialog. */
const BUILTIN_LABEL = "Gadget builder";

export const ComposerPromptSelector = ({
  presets,
  selectedPromptId,
  onPromptChange,
  requireConfirm,
}: ComposerPromptSelectorProps) => {
  const [pendingPromptId, setPendingPromptId] = useState<string | null | undefined>(undefined);

  const selectedPreset =
    selectedPromptId === null ? undefined : presets.find((preset) => preset.id === selectedPromptId);
  const selectedLabel = selectedPreset?.name ?? BUILTIN_LABEL;
  const pendingPreset =
    pendingPromptId === undefined || pendingPromptId === null
      ? undefined
      : presets.find((preset) => preset.id === pendingPromptId);
  // A pending id that vanished mid-confirm resolves to the default label rather than blank.
  const pendingLabel =
    pendingPromptId === undefined ? "" : (pendingPreset?.name ?? BUILTIN_LABEL);

  const requestChange = (promptId: string | null) => {
    // Selecting what is already effective (including stale ids displaying as default) is a no-op.
    const effectiveCurrent = selectedPreset === undefined ? null : selectedPromptId;
    if (promptId === effectiveCurrent) return;
    if (requireConfirm) {
      setPendingPromptId(promptId);
    } else {
      onPromptChange(promptId);
    }
  };

  const itemClassName =
    "!h-auto rounded-xl !px-2 !py-1.5 text-[12px] leading-4 font-normal tracking-[-0.15px] text-kumo-subtle transition-colors data-highlighted:bg-kumo-tint/70 data-highlighted:text-kumo-default";

  return (
    <>
      <DropdownMenu>
        <DropdownMenu.Trigger
          render={
            <button
              type="button"
              className="group inline-flex h-10 min-w-0 max-w-[110px] cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[14px] leading-5 text-kumo-subtle transition-[background-color,color,transform] duration-150 ease-out hover:bg-kumo-tint hover:text-kumo-default focus-visible:bg-kumo-tint focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.97] data-[popup-open]:bg-kumo-tint data-[popup-open]:text-kumo-default sm:h-8 sm:max-w-[180px] sm:text-[13px]"
              aria-label="Select prompt"
            >
              <span className="min-w-0 truncate">{selectedLabel}</span>
              <CaretDown
                size={12}
                weight="bold"
                className="flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out group-data-[popup-open]:rotate-180"
              />
            </button>
          }
        />
        <DropdownMenu.Content className="themed-floating-shadow-lg !z-[1100] !min-w-[190px] rounded-2xl border border-kumo-line/70 bg-kumo-base p-1">
          <DropdownMenu.Item onClick={() => requestChange(null)} className={itemClassName}>
            <span className="min-w-0 flex-1 truncate">{BUILTIN_LABEL}</span>
            {selectedPreset === undefined && (
              <Check size={12} weight="bold" className="ml-3 flex-shrink-0 text-kumo-inactive" />
            )}
          </DropdownMenu.Item>
          <div className="my-1 border-t border-kumo-line/70" />
          {presets.map((preset) => {
            const active = selectedPromptId === preset.id;
            return (
              <DropdownMenu.Item
                key={preset.id}
                onClick={() => requestChange(preset.id)}
                className={itemClassName}
              >
                <span className="min-w-0 flex-1 truncate">{preset.name}</span>
                {active && (
                  <Check size={12} weight="bold" className="ml-3 flex-shrink-0 text-kumo-inactive" />
                )}
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu>

      <Dialog.Root
        open={pendingPromptId !== undefined}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setPendingPromptId(undefined);
        }}
      >
        <Dialog
          className="responsive-dialog !z-[1000] !w-[min(440px,calc(100vw-32px))] overflow-hidden bg-kumo-base p-0 !top-[20%] !-translate-y-0"
          size="sm"
        >
          <div className="flex items-start justify-between gap-4 border-b border-kumo-line px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="text-[15px] leading-5 font-medium tracking-[-0.3px] text-kumo-default">
                Switch prompt to “{pendingLabel}”?
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                Switching prompts clears the model&apos;s cached context for this chat. The next
                turn starts fresh under the new prompt.
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

          <div className="flex items-center justify-end gap-2 border-t border-kumo-line bg-kumo-base px-5 py-3">
            <Dialog.Close
              render={(props) => (
                <WorkshopButton {...props} className="!h-9">
                  Cancel
                </WorkshopButton>
              )}
            />
            <WorkshopButton
              tone="primary"
              onClick={() => {
                if (pendingPromptId !== undefined) onPromptChange(pendingPromptId);
                setPendingPromptId(undefined);
              }}
              className="!h-9 min-w-[64px]"
            >
              Switch prompt
            </WorkshopButton>
          </div>
        </Dialog>
      </Dialog.Root>
    </>
  );
};
