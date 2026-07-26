import {
    FolderOpen,
    Plus,
    Server,
    SquareTerminal,
} from "lucide-react";

import type {
    BackendStatus,
} from "../backend/backend-client";

export type AppArea =
    | "connections"
    | "sftp"
    | "sessions";

interface AppHeaderProps {
    currentArea: AppArea;
    activeSessionCount: number;
    backendStatus: BackendStatus;
    shortcutModifierLabel: string;

    onOpenConnections: () => void;
    onOpenSessions: () => void;
    onOpenSftp: () => void;
}

function getBackendLabel(
    status: BackendStatus,
): string {
    switch (status) {
        case "connected":
            return "Backend ready";

        case "starting":
            return "Starting backend";

        case "error":
            return "Backend error";

        case "stopped":
        default:
            return "Backend idle";
    }
}

export function AppHeader({
    currentArea,
    activeSessionCount,
    backendStatus,
    shortcutModifierLabel,
    onOpenConnections,
    onOpenSessions,
    onOpenSftp,
}: AppHeaderProps) {
    return (
        <header className="app-header">
            <div className="app-header__inner">
                <button
                    type="button"
                    className="app-brand"
                    onClick={onOpenConnections}
                    title="SSH Workspace"
                >
                    <span className="app-brand__logo">
                        <SquareTerminal
                            size={21}
                            aria-hidden="true"
                        />
                    </span>

                    <span className="app-brand__text">
                        <strong>
                            SSH Workspace
                        </strong>

                        <small>
                            Secure remote access
                        </small>
                    </span>
                </button>

                <nav
                    className="app-navigation"
                    aria-label="Application navigation"
                >
                    <button
                        type="button"
                        className={
                            currentArea === "connections"
                                ? "app-navigation__item app-navigation__item--active"
                                : "app-navigation__item"
                        }
                        aria-current={
                            currentArea === "connections"
                                ? "page"
                                : undefined
                        }
                        onClick={onOpenConnections}
                    >
                        <Plus
                            size={15}
                            aria-hidden="true"
                        />

                        <span>
                            Add Connection
                        </span>

                        <kbd className="app-navigation__shortcut">
                            {shortcutModifierLabel}+T
                        </kbd>
                    </button>

                    <button
                        type="button"
                        className={
                            currentArea === "sessions"
                                ? "app-navigation__item app-navigation__item--active"
                                : "app-navigation__item"
                        }
                        aria-current={
                            currentArea === "sessions"
                                ? "page"
                                : undefined
                        }
                        onClick={onOpenSessions}
                    >
                        <Server
                            size={15}
                            aria-hidden="true"
                        />

                        <span>
                            Active Sessions
                        </span>

                        <span className="app-navigation__count">
                            {activeSessionCount}
                        </span>
                    </button>

                    <button
                        type="button"
                        className={
                            currentArea === "sftp"
                                ? "app-navigation__item app-navigation__item--active"
                                : "app-navigation__item"
                        }
                        aria-current={
                            currentArea === "sftp"
                                ? "page"
                                : undefined
                        }
                        onClick={
                            onOpenSftp
                        }
                    >
                        <FolderOpen
                            size={15}
                            aria-hidden="true"
                        />

                        <span>
                            SFTP
                        </span>
                    </button>
                </nav>

                <div
                    className={
                        `app-backend-status ` +
                        `app-backend-status--${backendStatus}`
                    }
                    title={getBackendLabel(
                        backendStatus,
                    )}
                >
                    <span className="app-backend-status__dot" />

                    <span className="app-backend-status__label">
                        {getBackendLabel(
                            backendStatus,
                        )}
                    </span>
                </div>
            </div>
        </header>
    );
}
