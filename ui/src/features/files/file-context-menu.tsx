import { useRef } from "react";
import { Menu, MenuItem, Popover } from "react-aria-components";
import { t } from "@/lib/localization";

export type FileContextAction = {
  id: string;
  label: string;
  run: () => void;
  disabled?: boolean;
  danger?: boolean;
};
export type FileContextState = { x: number; y: number; actions: FileContextAction[] };

export function FileContextMenu({
  menu,
  onClose,
  disabled = false,
}: {
  menu?: FileContextState;
  onClose: () => void;
  disabled?: boolean;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  return (
    <>
      <span
        ref={anchor}
        aria-hidden="true"
        style={{
          position: "fixed",
          left: menu?.x ?? 0,
          top: menu?.y ?? 0,
          width: 1,
          height: 1,
          pointerEvents: "none",
        }}
      />
      <Popover
        triggerRef={anchor}
        isOpen={!!menu}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        placement="bottom start"
        offset={0}
        containerPadding={8}
        className="z-50 max-h-[calc(100dvh-1rem)] min-w-56 overflow-y-auto rounded-xl border border-border bg-surface p-1.5 text-foreground shadow-2xl outline-none"
      >
        <Menu
          aria-label={t("Opciones del archivo")}
          autoFocus="first"
          className="outline-none"
          onAction={(key) => {
            const action = menu?.actions.find((item) => item.id === key);
            onClose();
            action?.run();
          }}
        >
          {(menu?.actions ?? []).map((action) => (
            <MenuItem
              key={action.id}
              id={action.id}
              textValue={action.label}
              isDisabled={disabled || action.disabled}
              className={`cursor-default rounded-lg px-3 py-2 text-sm outline-none data-focused:bg-accent/10 data-disabled:opacity-40 ${action.danger ? "text-danger" : ""}`}
            >
              {action.label}
            </MenuItem>
          ))}
        </Menu>
      </Popover>
    </>
  );
}
