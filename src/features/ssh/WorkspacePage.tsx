import {
    useEffect,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
    type PointerEvent as ReactPointerEvent,
} from "react";

import {
    FileCode2,
    ImageIcon,
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

// import {
//     SshConnectionJourney,
//     type ConnectionJourneyPhase,
// } from "./SshConnectionJourney";

import {
    TransferQueue,
} from "./TransferQueue";

import {
    RemoteImageViewer,
} from "../editor/RemoteImageViewer";

const DEFAULT_TERMINAL_PANE_PERCENT = 67;
const MIN_TERMINAL_PANE_WIDTH = 400;
const MIN_FILE_PANE_WIDTH = 0;
const WORKSPACE_SPLITTER_WIDTH = 12;
const PANE_KEYBOARD_STEP = 2;

interface WorkspacePageProps {
    connectionId: string;

    title: string;
    host: string;
    port: number;
    username: string;

    isActive: boolean;
    isDisconnecting: boolean;

    onDisconnected: (
        connectionId: string,
    ) => void;
}

export function WorkspacePage({
    connectionId,
    // title,
    host,
    port,
    username,
    isActive,
    isDisconnecting,
    onDisconnected,
}: WorkspacePageProps) {
    const [
        connectionError,
        setConnectionError,
    ] = useState("");


    // const [
    //     disconnectPhase,
    //     setDisconnectPhase,
    // ] = useState<ConnectionJourneyPhase>(
    //     "idle",
    // );

    const disconnectTimerRef =
        useRef<number | null>(
            null,
        );

    const workspaceGridRef =
        useRef<HTMLElement | null>(
            null,
        );

    const isResizingWorkspaceRef =
        useRef(false);

    const [
        terminalPanePercent,
        setTerminalPanePercent,
    ] = useState(
        DEFAULT_TERMINAL_PANE_PERCENT,
    );

    const [
        isResizingWorkspace,
        setIsResizingWorkspace,
    ] = useState(false);

    const editor =
        useRemoteEditorWorkspace({
            connectionId,
        });

    const isWorkspaceView =
        editor.view ===
        "workspace";

    function getTerminalPaneBounds(): {
        minimum: number;
        maximum: number;
    } | null {
        const workspaceGrid =
            workspaceGridRef.current;

        if (!workspaceGrid) {
            return null;
        }

        const bounds =
            workspaceGrid.getBoundingClientRect();

        const availableWidth =
            bounds.width -
            WORKSPACE_SPLITTER_WIDTH;

        if (availableWidth <= 0) {
            return null;
        }

        const minimum =
            (
                MIN_TERMINAL_PANE_WIDTH /
                availableWidth
            ) * 100;

        const maximum =
            100 -
            (
                MIN_FILE_PANE_WIDTH /
                availableWidth
            ) * 100;

        if (minimum > maximum) {
            return null;
        }

        return {
            minimum,
            maximum,
        };
    }

    function clampTerminalPanePercent(
        value: number,
    ): number {
        const paneBounds =
            getTerminalPaneBounds();

        if (!paneBounds) {
            return value;
        }

        return Math.min(
            paneBounds.maximum,
            Math.max(
                paneBounds.minimum,
                value,
            ),
        );
    }

    function updateTerminalPaneFromPointer(
        clientX: number,
    ): void {
        const workspaceGrid =
            workspaceGridRef.current;

        if (!workspaceGrid) {
            return;
        }

        const bounds =
            workspaceGrid.getBoundingClientRect();

        const availableWidth =
            bounds.width -
            WORKSPACE_SPLITTER_WIDTH;

        if (availableWidth <= 0) {
            return;
        }

        const pointerPosition =
            clientX -
            bounds.left -
            WORKSPACE_SPLITTER_WIDTH / 2;

        const requestedPercent =
            (
                pointerPosition /
                availableWidth
            ) * 100;

        const nextPercent =
            clampTerminalPanePercent(
                requestedPercent,
            );

        setTerminalPanePercent(
            Math.round(
                nextPercent * 10,
            ) / 10,
        );
    }

    function finishWorkspaceResize(
        splitter:
            HTMLDivElement,
        pointerId: number,
    ): void {
        isResizingWorkspaceRef.current =
            false;

        setIsResizingWorkspace(false);

        document.body.classList.remove(
            "workspace-pane-resizing",
        );

        if (
            splitter.hasPointerCapture(
                pointerId,
            )
        ) {
            splitter.releasePointerCapture(
                pointerId,
            );
        }
    }

    function handleWorkspaceSplitterPointerDown(
        event:
            ReactPointerEvent<HTMLDivElement>,
    ): void {
        if (event.button !== 0) {
            return;
        }

        event.preventDefault();

        isResizingWorkspaceRef.current =
            true;

        setIsResizingWorkspace(true);

        document.body.classList.add(
            "workspace-pane-resizing",
        );

        event.currentTarget.setPointerCapture(
            event.pointerId,
        );

        updateTerminalPaneFromPointer(
            event.clientX,
        );
    }

    function handleWorkspaceSplitterPointerMove(
        event:
            ReactPointerEvent<HTMLDivElement>,
    ): void {
        if (
            !isResizingWorkspaceRef.current
        ) {
            return;
        }

        event.preventDefault();

        updateTerminalPaneFromPointer(
            event.clientX,
        );
    }

    function handleWorkspaceSplitterPointerUp(
        event:
            ReactPointerEvent<HTMLDivElement>,
    ): void {
        finishWorkspaceResize(
            event.currentTarget,
            event.pointerId,
        );
    }

    function handleWorkspaceSplitterKeyDown(
        event:
            ReactKeyboardEvent<HTMLDivElement>,
    ): void {
        let difference = 0;

        if (event.key === "ArrowLeft") {
            difference =
                -PANE_KEYBOARD_STEP;
        }

        if (event.key === "ArrowRight") {
            difference =
                PANE_KEYBOARD_STEP;
        }

        if (difference === 0) {
            return;
        }

        event.preventDefault();

        setTerminalPanePercent(
            (currentPercent) =>
                clampTerminalPanePercent(
                    currentPercent +
                    difference,
                ),
        );
    }

    function resetWorkspacePaneSizes():
        void {
        setTerminalPanePercent(
            clampTerminalPanePercent(
                DEFAULT_TERMINAL_PANE_PERCENT,
            ),
        );
    }

    // useEffect(() => {
    //     if (isDisconnecting) {
    //         setDisconnectPhase(
    //             "disconnecting",
    //         );
    //     }
    // }, [isDisconnecting]);

    useEffect(() => {
        return () => {
            isResizingWorkspaceRef.current =
                false;

            if (
                disconnectTimerRef.current !==
                null
            ) {
                window.clearTimeout(
                    disconnectTimerRef.current,
                );
            }

            document.body.classList.remove(
                "workspace-pane-resizing",
            );
        };
    }, []);

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

                    // setDisconnectPhase(
                    //     "disconnected",
                    // );

                    if (isDisconnecting) {
                        return;
                    }

                    if (
                        disconnectTimerRef.current !==
                        null
                    ) {
                        window.clearTimeout(
                            disconnectTimerRef.current,
                        );
                    }

                    disconnectTimerRef.current =
                        window.setTimeout(
                            () => {
                                onDisconnected(
                                    connectionId,
                                );
                            },
                            1_050,
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
        isDisconnecting,
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
            {/* {disconnectPhase !==
                "idle" && (
                <div className="workspace-disconnection-overlay">
                    <SshConnectionJourney
                        phase={
                            disconnectPhase
                        }
                        profileName={
                            title
                        }
                        host={host}
                        port={port}
                        username={
                            username
                        }
                        compact
                    />
                </div>
            )} */}

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
                        marginRight: "5px"
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
                                style={{
                                    marginRight: "5px"
                                }}
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
                                ) : tab.kind ===
                                    "image" ? (
                                    <ImageIcon
                                        size={13}
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
                <section
                    ref={workspaceGridRef}
                    className={
                        isResizingWorkspace
                            ? "workspace-grid workspace-grid--resizable workspace-grid--resizing"
                            : "workspace-grid workspace-grid--resizable"
                    }
                    style={{
                        gridTemplateColumns:
                            [
                                `minmax(${MIN_TERMINAL_PANE_WIDTH}px, ${terminalPanePercent}fr)`,

                                `${WORKSPACE_SPLITTER_WIDTH}px`,

                                `minmax(${MIN_FILE_PANE_WIDTH}px, ${100 - terminalPanePercent}fr)`,
                            ].join(" "),
                    }}
                >
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

                    <div
                        className="workspace-pane-splitter"
                        role="separator"
                        aria-label="Resize terminal and remote files"
                        aria-orientation="vertical"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={
                            Math.round(
                                terminalPanePercent,
                            )
                        }
                        tabIndex={0}
                        title="Drag to resize. Double-click to reset."
                        onPointerDown={
                            handleWorkspaceSplitterPointerDown
                        }
                        onPointerMove={
                            handleWorkspaceSplitterPointerMove
                        }
                        onPointerUp={
                            handleWorkspaceSplitterPointerUp
                        }
                        onPointerCancel={
                            handleWorkspaceSplitterPointerUp
                        }
                        onKeyDown={
                            handleWorkspaceSplitterKeyDown
                        }
                        onDoubleClick={
                            resetWorkspacePaneSizes
                        }
                    >
                        <span className="workspace-pane-splitter__line" />
                        <span className="workspace-pane-splitter__handle">
                            <i />
                            <i />
                            <i />
                        </span>
                    </div>

                    <RemoteFileExplorer
                        connectionId={
                            connectionId
                        }
                        isActive={
                            isActive &&
                            isWorkspaceView
                        }
                        onOpenFile={
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
                    editor.activeTab?.kind ===
                        "text"
                        ? editor.activeTab
                        : null
                }
                conflict={
                    editor.conflict
                }
                isVisible={
                    !isWorkspaceView &&
                    editor.activeTab?.kind ===
                    "text"
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

            <RemoteImageViewer
                connectionId={
                    connectionId
                }
                tab={
                    editor.activeTab?.kind ===
                        "image"
                        ? editor.activeTab
                        : null
                }
                isVisible={
                    !isWorkspaceView &&
                    editor.activeTab?.kind ===
                    "image"
                }
                isSessionActive={
                    isActive
                }
                onReload={async () => {
                    if (
                        editor.activePath
                    ) {
                        await editor.reloadTab(
                            editor.activePath,
                            false,
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
            />
        </main>
    );
}