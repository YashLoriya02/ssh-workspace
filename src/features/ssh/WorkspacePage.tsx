import {
    useEffect,
    useState,
} from "react";

import {
    FileCode2,
    Loader,
    SquareTerminal,
    X,
} from "lucide-react";

import {
    backendClient,
} from "../../backend/backend-client";

import {
    RemoteEditorWorkspace,
} from "../editor/RemoteEditorWorkspace";

import {
    isRemoteEditorTabDirty,
} from "../editor/editor-types";

import {
    useRemoteEditorWorkspace,
} from "../editor/useRemoteEditorWorkspace";

import {
    RemoteFileExplorer,
} from "./RemoteFileExplorer";

import {
    SshTerminal,
} from "./SshTerminal";

import {
    TransferQueue,
} from "./TransferQueue";

interface WorkspacePageProps {
    connectionId: string;

    host: string;
    port: number;
    username: string;

    isActive: boolean;

    onDisconnected: (
        connectionId: string,
    ) => void;
}

export function WorkspacePage({
    connectionId,
    host,
    port,
    username,
    isActive,
    onDisconnected,
}: WorkspacePageProps) {
    const [
        connectionError,
        setConnectionError,
    ] = useState("");

    const editor =
        useRemoteEditorWorkspace({
            connectionId,
        });

    const isWorkspaceView =
        editor.view ===
        "workspace";

    useEffect(() => {
        return backendClient.subscribeToEvents(
            (event) => {
                if (
                    event.type ===
                    "connection.disconnected"
                ) {
                    const payload =
                        event.payload as {
                            connectionId?: string;
                        };

                    if (
                        payload.connectionId !==
                        connectionId
                    ) {
                        return;
                    }

                    onDisconnected(
                        connectionId,
                    );

                    return;
                }

                if (
                    event.type ===
                    "connection.error"
                ) {
                    const payload =
                        event.payload as {
                            connectionId?: string;
                            message?: string;
                        };

                    if (
                        payload.connectionId !==
                        connectionId
                    ) {
                        return;
                    }

                    setConnectionError(
                        payload.message ??
                        "The SSH connection encountered an error.",
                    );
                }
            },
        );
    }, [
        connectionId,
        onDisconnected,
    ]);

    return (
        <main
            className={
                isWorkspaceView
                    ? "workspace-page"
                    : "workspace-page workspace-page--editor"
            }
        >
            {connectionError && (
                <div className="workspace-error">
                    {connectionError}
                </div>
            )}

            <nav
                className="workspace-view-tabs"
                aria-label="Workspace views"
            >
                <button
                    type="button"
                    style={{
                        marginRight: "10px"
                    }}
                    className={
                        isWorkspaceView
                            ? "workspace-view-tab workspace-view-tab--active"
                            : "workspace-view-tab"
                    }
                    onClick={
                        editor.showWorkspace
                    }
                >
                    <SquareTerminal
                        size={14}
                    />

                    <span>
                        Workspace
                    </span>
                </button>

                {editor.tabs.map(
                    (tab) => {
                        const dirty =
                            isRemoteEditorTabDirty(
                                tab,
                            );

                        const active =
                            editor.view ===
                            "editor" &&
                            editor.activePath ===
                            tab.path;

                        return (
                            <button
                                key={tab.path}
                                type="button"
                                className={
                                    active
                                        ? "workspace-view-tab workspace-view-tab--editor workspace-view-tab--active"
                                        : "workspace-view-tab workspace-view-tab--editor"
                                }
                                title={tab.path}
                                onClick={() =>
                                    editor.selectTab(
                                        tab.path,
                                    )
                                }
                            >
                                {tab.status ===
                                    "loading" ? (
                                    <Loader
                                        size={13}
                                        className="loader"
                                    />
                                ) : (
                                    <FileCode2
                                        size={13}
                                    />
                                )}

                                <span className="workspace-view-tab__label">
                                    {tab.name}
                                </span>

                                {dirty && (
                                    <span
                                        className="workspace-view-tab__dirty"
                                        title="Unsaved changes"
                                    >
                                        •
                                    </span>
                                )}

                                <span
                                    role="button"
                                    tabIndex={0}
                                    className="workspace-view-tab__close"
                                    aria-label={`Close ${tab.name}`}
                                    onClick={(event) => {
                                        event.stopPropagation();

                                        void editor.closeTab(
                                            tab.path,
                                        );
                                    }}
                                    onKeyDown={(event) => {
                                        if (
                                            event.key ===
                                            "Enter" ||
                                            event.key ===
                                            " "
                                        ) {
                                            event.preventDefault();
                                            event.stopPropagation();

                                            void editor.closeTab(
                                                tab.path,
                                            );
                                        }
                                    }}
                                >
                                    <X size={12} />
                                </span>
                            </button>
                        );
                    },
                )}
            </nav>

            <div
                className={
                    isWorkspaceView
                        ? "workspace-content"
                        : "workspace-content workspace-content--hidden"
                }
            >
                <section className="workspace-grid">
                    <SshTerminal
                        connectionId={
                            connectionId
                        }
                        isActive={
                            isActive &&
                            isWorkspaceView
                        }
                        host={host}
                        port={port}
                        username={
                            username
                        }
                    />

                    <RemoteFileExplorer
                        connectionId={
                            connectionId
                        }
                        isActive={
                            isActive &&
                            isWorkspaceView
                        }
                        onEditFile={
                            editor.openFile
                        }
                        externalFileChange={
                            editor.lastSavedFileChange
                        }
                    />
                </section>

                <TransferQueue
                    connectionId={
                        connectionId
                    }
                />
            </div>

            <RemoteEditorWorkspace
                tab={
                    editor.activeTab
                }
                conflict={
                    editor.conflict
                }
                isVisible={
                    !isWorkspaceView
                }
                isSessionActive={
                    isActive
                }
                onChange={(value) => {
                    if (
                        editor.activePath
                    ) {
                        editor.updateContent(
                            editor.activePath,
                            value,
                        );
                    }
                }}
                onSave={async () => {
                    if (
                        editor.activePath
                    ) {
                        await editor.saveTab(
                            editor.activePath,
                        );
                    }
                }}
                onReload={async () => {
                    if (
                        editor.activePath
                    ) {
                        await editor.reloadTab(
                            editor.activePath,
                        );
                    }
                }}
                onRetry={async () => {
                    if (
                        editor.activePath
                    ) {
                        await editor.reloadTab(
                            editor.activePath,
                            false,
                        );
                    }
                }}
                onSaveConflictAnyway={
                    editor.saveConflictAnyway
                }
                onReloadConflict={
                    editor.reloadConflict
                }
                onCancelConflict={
                    editor.cancelConflict
                }
            />
        </main>
    );
}