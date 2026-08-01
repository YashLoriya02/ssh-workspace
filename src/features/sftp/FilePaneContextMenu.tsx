import {
    useEffect,
    useRef,
    type ReactNode,
} from "react";

export interface FilePaneContextAction {
    type: "action";
    id: string;
    label: string;
    icon: ReactNode;
    onSelect: () => void | Promise<void>;
    danger?: boolean;
    disabled?: boolean;
    hint?: string;
}

export interface FilePaneContextSeparator {
    type: "separator";
    id: string;
}

export type FilePaneContextItem =
    | FilePaneContextAction
    | FilePaneContextSeparator;

interface FilePaneContextMenuProps {
    x: number;
    y: number;
    ariaLabel: string;
    items: readonly FilePaneContextItem[];
    onClose: () => void;
}

export function FilePaneContextMenu({
    x,
    y,
    ariaLabel,
    items,
    onClose,
}: FilePaneContextMenuProps) {
    const menuRef =
        useRef<HTMLDivElement | null>(
            null,
        );

    useEffect(() => {
        function handlePointerDown(
            event: PointerEvent,
        ): void {
            const target = event.target;

            if (
                target instanceof Node &&
                menuRef.current?.contains(
                    target,
                )
            ) {
                return;
            }

            onClose();
        }

        function handleKeyDown(
            event: KeyboardEvent,
        ): void {
            if (event.key === "Escape") {
                onClose();
            }
        }

        function handleDismiss(): void {
            onClose();
        }

        window.addEventListener(
            "pointerdown",
            handlePointerDown,
            true,
        );

        window.addEventListener(
            "keydown",
            handleKeyDown,
            true,
        );

        window.addEventListener(
            "resize",
            handleDismiss,
        );

        window.addEventListener(
            "blur",
            handleDismiss,
        );

        window.addEventListener(
            "scroll",
            handleDismiss,
            true,
        );

        return () => {
            window.removeEventListener(
                "pointerdown",
                handlePointerDown,
                true,
            );

            window.removeEventListener(
                "keydown",
                handleKeyDown,
                true,
            );

            window.removeEventListener(
                "resize",
                handleDismiss,
            );

            window.removeEventListener(
                "blur",
                handleDismiss,
            );

            window.removeEventListener(
                "scroll",
                handleDismiss,
                true,
            );
        };
    }, [onClose]);

    return (
        <div
            ref={menuRef}
            className="remote-context-menu"
            style={{
                left: x,
                top: y,
            }}
            role="menu"
            aria-label={ariaLabel}
        >
            {items.map((item) => {
                if (
                    item.type ===
                    "separator"
                ) {
                    return (
                        <div
                            key={item.id}
                            className="remote-context-menu__separator"
                            role="separator"
                        />
                    );
                }

                return (
                    <button
                        key={item.id}
                        type="button"
                        role="menuitem"
                        className={
                            item.danger
                                ? "remote-context-menu__item remote-context-menu__item--danger"
                                : "remote-context-menu__item"
                        }
                        disabled={
                            item.disabled
                        }
                        onClick={() => {
                            onClose();
                            void item.onSelect();
                        }}
                    >
                        {item.icon}

                        <span>
                            {item.label}
                        </span>

                        {item.hint && (
                            <span className="remote-context-menu__hint">
                                {item.hint}
                            </span>
                        )}
                    </button>
                );
            })}
        </div>
    );
}
