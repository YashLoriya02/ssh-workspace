import {
    useEffect,
    useRef,
    useState,
    type ChangeEvent,
} from "react";

import {
    FolderOpen,
    HardDrive,
    MoreHorizontal,
    RefreshCw,
    Server,
    Unplug,
    X,
} from "lucide-react";

import type {
    SftpPaneSide,
    SftpPaneSource,
    SftpServerOption,
} from "./sftp-types";

import {
    LocalFileBrowser,
} from "./LocalFileBrowser";

import {
    RemoteFileBrowser,
} from "./RemoteFileBrowser";

import type {
    SftpTransferEntry,
} from "./transfers/sftp-transfer-types";

interface SftpPaneProps {
    side: SftpPaneSide;

    source: SftpPaneSource;
    servers: readonly SftpServerOption[];
    refreshVersion: number;

    onSourceChange: (
        source: SftpPaneSource,
    ) => void;

    onChooseLocalFolder:
    () => Promise<void>;

    onClear: () => void;

    onDisconnectServer: (
        connectionId: string,
    ) => Promise<void>;

    onCopyToOtherPane: (
        entry: SftpTransferEntry,
    ) => void;

    /*
     * This will be provided when the actual
     * local/remote browser is connected.
     */
    onRefresh?: () => void;
}

function getSourceValue(
    source: SftpPaneSource,
): string {
    if (source.type === "remote") {
        return `remote:${source.connectionId}`;
    }

    return source.type;
}

export function SftpPane({
    side,
    source,
    servers,
    refreshVersion,
    onSourceChange,
    onChooseLocalFolder,
    onClear,
    onDisconnectServer,
    onCopyToOtherPane,
    // onRefresh,
}: SftpPaneProps) {
    const [
        isMenuOpen,
        setIsMenuOpen,
    ] = useState(false);

    const [
        localRefreshVersion,
        setLocalRefreshVersion,
    ] = useState(0);

    const [
        remoteRefreshVersion,
        setRemoteRefreshVersion,
    ] = useState(0);

    const [
        isDisconnecting,
        setIsDisconnecting,
    ] = useState(false);

    const menuRootRef =
        useRef<HTMLDivElement | null>(
            null,
        );

    const sideLabel =
        side === "left"
            ? "Left"
            : "Right";

    const selectedServer =
        source.type === "remote"
            ? servers.find(
                (server) =>
                    server.connectionId ===
                    source.connectionId,
            )
            : undefined;

    useEffect(() => {
        if (!isMenuOpen) {
            return;
        }

        function handlePointerDown(
            event: PointerEvent,
        ): void {
            const target =
                event.target;

            if (
                !(target instanceof Node) ||
                menuRootRef.current
                    ?.contains(target)
            ) {
                return;
            }

            setIsMenuOpen(false);
        }

        function handleKeyDown(
            event: KeyboardEvent,
        ): void {
            if (event.key === "Escape") {
                setIsMenuOpen(false);
            }
        }

        window.addEventListener(
            "pointerdown",
            handlePointerDown,
        );

        window.addEventListener(
            "keydown",
            handleKeyDown,
        );

        return () => {
            window.removeEventListener(
                "pointerdown",
                handlePointerDown,
            );

            window.removeEventListener(
                "keydown",
                handleKeyDown,
            );
        };
    }, [isMenuOpen]);

    function handleSourceSelect(
        event:
            ChangeEvent<HTMLSelectElement>,
    ): void {
        const value =
            event.target.value;

        setIsMenuOpen(false);

        if (value === "empty") {
            onSourceChange({
                type: "empty",
            });

            return;
        }

        if (value === "local") {
            onSourceChange({
                type: "local",
                rootPath: null,
                path: null,
            });

            return;
        }

        const remotePrefix =
            "remote:";

        if (
            value.startsWith(
                remotePrefix,
            )
        ) {
            onSourceChange({
                type: "remote",

                connectionId:
                    value.slice(
                        remotePrefix.length,
                    ),

                path: null,
            });
        }
    }

    async function handleDisconnect():
        Promise<void> {
        if (
            !selectedServer ||
            isDisconnecting
        ) {
            return;
        }

        const confirmed =
            window.confirm(
                [
                    `Disconnect "${selectedServer.title}"?`,
                    "",
                    "This will also close its terminal session and remove it from Active Sessions.",
                ].join("\n"),
            );

        if (!confirmed) {
            return;
        }

        setIsMenuOpen(false);
        setIsDisconnecting(true);

        try {
            await onDisconnectServer(
                selectedServer.connectionId,
            );
        } finally {
            setIsDisconnecting(false);
        }
    }

    const sourceTitle =
        source.type === "local"
            ? "Local Computer"
            : source.type === "remote"
                ? selectedServer?.title ??
                "Remote Server"
                : "No source selected";

    const sourceSubtitle =
        source.type === "local"
            ? source.path ??
            "Choose a local folder"
            : source.type === "remote"
                ? source.path ??
                (
                    selectedServer
                        ? [
                            `${selectedServer.username}@${selectedServer.host}`,

                            selectedServer.port !==
                                22
                                ? `:${selectedServer.port}`
                                : "",
                        ].join("")
                        : "Remote session unavailable"
                )
                : "Select a source from the dropdown";

    const sourceIcon =
        source.type === "local"
            ? (
                <HardDrive
                    size={17}
                    aria-hidden="true"
                />
            )
            : source.type === "remote"
                ? (
                    <Server
                        size={17}
                        aria-hidden="true"
                    />
                )
                : (
                    <FolderOpen
                        size={17}
                        aria-hidden="true"
                    />
                );

    const canRefresh =
        (
            source.type === "local" &&
            Boolean(source.path)
        ) ||
        (
            source.type === "remote" &&
            Boolean(selectedServer)
        );

    function handlePaneRefresh():
        void {
        if (
            source.type === "local" &&
            source.path
        ) {
            setLocalRefreshVersion(
                (
                    currentVersion,
                ) =>
                    currentVersion +
                    1,
            );

            return;
        }

        if (
            source.type === "remote" &&
            selectedServer
        ) {
            setRemoteRefreshVersion(
                (
                    currentVersion,
                ) =>
                    currentVersion +
                    1,
            );
        }
    }

    return (
        <section
            className={
                `sftp-pane ` +
                `sftp-pane--${source.type}`
            }
            aria-label={
                `${sideLabel} SFTP pane`
            }
        >
            <header className="sftp-pane__header">
                <div className="sftp-pane__source">
                    <span className="sftp-pane__source-icon">
                        {sourceIcon}
                    </span>

                    <div className="sftp-pane__source-text">
                        <strong>
                            {sourceTitle}
                        </strong>

                        <span
                            title={
                                sourceSubtitle
                            }
                        >
                            {sourceSubtitle}
                        </span>
                    </div>
                </div>

                <div className="sftp-pane__header-actions">
                    <button
                        type="button"
                        className="sftp-pane__icon-button"
                        onClick={
                            handlePaneRefresh
                        }
                        disabled={
                            !canRefresh
                        }
                        title={
                            canRefresh
                                ? "Refresh current directory"
                                : "Refresh becomes available when directory browsing is connected"
                        }
                        aria-label="Refresh pane"
                    >
                        <RefreshCw
                            size={15}
                            aria-hidden="true"
                        />
                    </button>

                    <button
                        type="button"
                        className="sftp-pane__icon-button"
                        onClick={
                            onClear
                        }
                        disabled={
                            source.type ===
                            "empty"
                        }
                        title="Clear this pane"
                        aria-label={
                            `Clear ${sideLabel.toLowerCase()} pane`
                        }
                    >
                        <X
                            size={15}
                            aria-hidden="true"
                        />
                    </button>

                    {source.type ===
                        "remote" &&
                        selectedServer && (
                            <div
                                ref={
                                    menuRootRef
                                }
                                className="sftp-pane__menu-root"
                            >
                                <button
                                    type="button"
                                    className={
                                        isMenuOpen
                                            ? "sftp-pane__icon-button sftp-pane__icon-button--active"
                                            : "sftp-pane__icon-button"
                                    }
                                    onClick={() =>
                                        setIsMenuOpen(
                                            (
                                                current,
                                            ) =>
                                                !current,
                                        )
                                    }
                                    title="Remote server actions"
                                    aria-label="Remote server actions"
                                    aria-expanded={
                                        isMenuOpen
                                    }
                                >
                                    <MoreHorizontal
                                        size={16}
                                        aria-hidden="true"
                                    />
                                </button>

                                {isMenuOpen && (
                                    <div
                                        className="sftp-pane__menu"
                                        role="menu"
                                    >
                                        <button
                                            type="button"
                                            role="menuitem"
                                            onClick={() => {
                                                setIsMenuOpen(
                                                    false,
                                                );

                                                onClear();
                                            }}
                                        >
                                            <X
                                                size={14}
                                                aria-hidden="true"
                                            />

                                            Detach from server
                                        </button>

                                        <button
                                            type="button"
                                            role="menuitem"
                                            className="sftp-pane__menu-danger"
                                            onClick={() => {
                                                void handleDisconnect();
                                            }}
                                            disabled={
                                                isDisconnecting
                                            }
                                        >
                                            <Unplug
                                                size={14}
                                                aria-hidden="true"
                                            />

                                            {isDisconnecting
                                                ? "Disconnecting…"
                                                : "Disconnect server"}
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}
                </div>
            </header>

            <div className="sftp-pane__selector">
                <label>
                    <span>
                        Source
                    </span>

                    <div className="select-wrapper">
                        <select
                            value={
                                getSourceValue(
                                    source,
                                )
                            }
                            onChange={
                                handleSourceSelect
                            }
                            aria-label={
                                `${sideLabel} pane source`
                            }
                        >
                            <option value="empty">
                                Empty
                            </option>

                            <option value="local">
                                Local Computer
                            </option>

                            <optgroup label="Active Servers">
                                {servers.length ===
                                    0 ? (
                                    <option
                                        value="no-active-servers"
                                        disabled
                                    >
                                        No active servers
                                    </option>
                                ) : (
                                    servers.map(
                                        (
                                            server,
                                        ) => (
                                            <option
                                                key={
                                                    server.connectionId
                                                }
                                                value={
                                                    `remote:${server.connectionId}`
                                                }
                                            >
                                                {server.title}
                                                {" — "}
                                                {server.username}
                                                @
                                                {server.host}
                                            </option>
                                        ),
                                    )
                                )}
                            </optgroup>
                        </select>
                    </div>
                </label>
            </div >

            <div className="sftp-pane__body">
                {source.type ===
                    "empty" && (
                        <div className="sftp-pane__empty-state">
                            <span className="sftp-pane__empty-icon">
                                <FolderOpen
                                    size={28}
                                    aria-hidden="true"
                                />
                            </span>

                            <strong>
                                Choose a source
                            </strong>

                            <p>
                                Open a local folder or
                                select an active SSH
                                server.
                            </p>
                        </div>
                    )}

                {source.type === "local" && (
                    source.rootPath &&
                        source.path ? (
                        <LocalFileBrowser
                            rootPath={
                                source.rootPath
                            }
                            currentPath={
                                source.path
                            }
                            refreshVersion={
                                localRefreshVersion +
                                refreshVersion
                            }
                            onPathChange={(
                                nextPath,
                            ) =>
                                onSourceChange({
                                    ...source,
                                    path:
                                        nextPath,
                                })
                            }
                            onChooseFolder={
                                onChooseLocalFolder
                            }
                            onCopyToOtherPane={
                                onCopyToOtherPane
                            }
                        />
                    ) : (
                        <div className="sftp-pane__empty-state">
                            <span className="sftp-pane__empty-icon sftp-pane__empty-icon--local">
                                <HardDrive
                                    size={28}
                                    aria-hidden="true"
                                />
                            </span>

                            <strong>
                                Open a local folder
                            </strong>

                            <p>
                                Choose the directory you
                                want to browse and transfer
                                files from.
                            </p>

                            <button
                                type="button"
                                className="sftp-pane__primary-action"
                                onClick={() => {
                                    void onChooseLocalFolder();
                                }}
                            >
                                <FolderOpen
                                    size={15}
                                    aria-hidden="true"
                                />

                                Choose folder
                            </button>
                        </div>
                    )
                )}

                {source.type ===
                    "remote" && (
                        selectedServer ? (
                            <RemoteFileBrowser
                                connectionId={
                                    selectedServer
                                        .connectionId
                                }
                                currentPath={
                                    source.path
                                }
                                refreshVersion={
                                    remoteRefreshVersion +
                                    refreshVersion
                                }
                                onPathChange={(
                                    nextPath,
                                ) =>
                                    onSourceChange({
                                        ...source,

                                        path:
                                            nextPath,
                                    })
                                }
                                onCopyToOtherPane={
                                    onCopyToOtherPane
                                }
                            />
                        ) : (
                            <div className="sftp-pane__empty-state">
                                <span className="sftp-pane__empty-icon sftp-pane__empty-icon--remote">
                                    <Server
                                        size={28}
                                        aria-hidden="true"
                                    />
                                </span>

                                <strong>
                                    Remote server unavailable
                                </strong>

                                <p>
                                    This SSH session is no
                                    longer active. Select
                                    another server from the
                                    source dropdown.
                                </p>
                            </div>
                        )
                    )}
            </div>

            <footer className="sftp-pane__footer">
                <span>
                    {sideLabel} section
                </span>

                <span>
                    {source.type === "empty"
                        ? "Not connected"
                        : source.type === "local"
                            ? "Local filesystem"
                            : "Remote filesystem"}
                </span>
            </footer>
        </section >
    );
}