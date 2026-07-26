import {
    useEffect,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
    type PointerEvent as ReactPointerEvent,
} from "react";

import {
    ArrowLeftRight,
    FolderOpen,
} from "lucide-react";

import {
    homeDir,
} from "@tauri-apps/api/path";

import {
    open as openDialog,
} from "@tauri-apps/plugin-dialog";

import {
    SftpPane,
} from "./SftpPane";

import type {
    SftpPaneSide,
    SftpPaneSource,
    SftpServerOption,
} from "./sftp-types";

interface SftpWorkspacePageProps {
    servers:
    readonly SftpServerOption[];

    onDisconnectServer: (
        connectionId: string,
    ) => Promise<void>;
}

const DEFAULT_LEFT_PANE_PERCENT =
    50;

const MIN_SFTP_PANE_WIDTH =
    340;

const SFTP_SPLITTER_WIDTH =
    12;

const SFTP_KEYBOARD_RESIZE_STEP =
    2;

export function SftpWorkspacePage({
    servers,
    onDisconnectServer,
}: SftpWorkspacePageProps) {
    const gridRef =
        useRef<HTMLElement | null>(
            null,
        );

    const isResizingRef =
        useRef(false);

    const [
        leftSource,
        setLeftSource,
    ] = useState<SftpPaneSource>({
        type: "local",
        rootPath: null,
        path: null,
    });

    const [
        rightSource,
        setRightSource,
    ] = useState<SftpPaneSource>({
        type: "empty",
    });

    const [
        leftPanePercent,
        setLeftPanePercent,
    ] = useState(
        DEFAULT_LEFT_PANE_PERCENT,
    );

    const [
        isResizing,
        setIsResizing,
    ] = useState(false);

    const [
        errorMessage,
        setErrorMessage,
    ] = useState("");

    useEffect(() => {
        let disposed =
            false;

        void homeDir()
            .then(
                (
                    localHomePath,
                ) => {
                    if (disposed) {
                        return;
                    }

                    setLeftSource(
                        (
                            currentSource,
                        ) =>
                            currentSource.type ===
                                "local" &&
                                !currentSource.path
                                ? {
                                    type:
                                        "local",

                                    rootPath:
                                        localHomePath,

                                    path:
                                        localHomePath,
                                }
                                : currentSource,
                    );
                },
            )
            .catch(
                (
                    error:
                        unknown,
                ) => {
                    if (!disposed) {
                        setErrorMessage(
                            error instanceof
                                Error
                                ? error.message
                                : String(
                                    error,
                                ),
                        );
                    }
                },
            );

        return () => {
            disposed =
                true;
        };
    }, []);

    /*
     * Remove a remote source from either pane
     * when its SSH session closes elsewhere.
     */
    useEffect(() => {
        const activeConnectionIds =
            new Set(
                servers.map(
                    (server) =>
                        server.connectionId,
                ),
            );

        setLeftSource(
            (currentSource) =>
                currentSource.type ===
                    "remote" &&
                    !activeConnectionIds.has(
                        currentSource.connectionId,
                    )
                    ? {
                        type: "empty",
                    }
                    : currentSource,
        );

        setRightSource(
            (currentSource) =>
                currentSource.type ===
                    "remote" &&
                    !activeConnectionIds.has(
                        currentSource.connectionId,
                    )
                    ? {
                        type: "empty",
                    }
                    : currentSource,
        );
    }, [servers]);

    useEffect(() => {
        return () => {
            isResizingRef.current =
                false;

            document.body.classList.remove(
                "workspace-pane-resizing",
            );
        };
    }, []);

    function updateSource(
        side: SftpPaneSide,
        source: SftpPaneSource,
    ): void {
        setErrorMessage("");

        if (side === "left") {
            setLeftSource(
                source,
            );
        } else {
            setRightSource(
                source,
            );
        }

        /*
         * Selecting Local Computer from either dropdown
         * opens the user's home folder automatically.
         */
        if (
            source.type !== "local" ||
            source.path
        ) {
            return;
        }

        void homeDir()
            .then(
                (
                    localHomePath,
                ) => {
                    const resolvedSource:
                        SftpPaneSource = {
                        type:
                            "local",

                        rootPath:
                            localHomePath,

                        path:
                            localHomePath,
                    };

                    if (
                        side === "left"
                    ) {
                        setLeftSource(
                            (
                                currentSource,
                            ) =>
                                currentSource.type ===
                                    "local" &&
                                    !currentSource.path
                                    ? resolvedSource
                                    : currentSource,
                        );
                    } else {
                        setRightSource(
                            (
                                currentSource,
                            ) =>
                                currentSource.type ===
                                    "local" &&
                                    !currentSource.path
                                    ? resolvedSource
                                    : currentSource,
                        );
                    }
                },
            )
            .catch(
                (
                    error:
                        unknown,
                ) => {
                    setErrorMessage(
                        error instanceof
                            Error
                            ? error.message
                            : String(error),
                    );
                },
            );
    }

    function clearSource(
        side: SftpPaneSide,
    ): void {
        updateSource(
            side,
            {
                type: "empty",
            },
        );
    }

    async function chooseLocalFolder(
        side: SftpPaneSide,
    ): Promise<void> {
        setErrorMessage("");

        try {
            const selected =
                await openDialog({
                    title:
                        side === "left"
                            ? "Choose folder for left pane"
                            : "Choose folder for right pane",

                    directory: true,
                    multiple: false,
                });

            const selectedPath =
                Array.isArray(selected)
                    ? selected[0]
                    : selected;

            if (!selectedPath) {
                return;
            }

            updateSource(
                side,
                {
                    type: "local",
                    rootPath: selectedPath,
                    path: selectedPath,
                },
            );
        } catch (error) {
            setErrorMessage(
                error instanceof Error
                    ? error.message
                    : String(error),
            );
        }
    }

    async function disconnectServer(
        connectionId: string,
    ): Promise<void> {
        setErrorMessage("");

        try {
            await onDisconnectServer(
                connectionId,
            );

            setLeftSource(
                (currentSource) =>
                    currentSource.type ===
                        "remote" &&
                        currentSource.connectionId ===
                        connectionId
                        ? {
                            type: "empty",
                        }
                        : currentSource,
            );

            setRightSource(
                (currentSource) =>
                    currentSource.type ===
                        "remote" &&
                        currentSource.connectionId ===
                        connectionId
                        ? {
                            type: "empty",
                        }
                        : currentSource,
            );
        } catch (error) {
            setErrorMessage(
                error instanceof Error
                    ? error.message
                    : String(error),
            );

            throw error;
        }
    }

    function swapPanes(): void {
        setErrorMessage("");

        const previousLeft =
            leftSource;

        setLeftSource(
            rightSource,
        );

        setRightSource(
            previousLeft,
        );
    }

    function getPaneBounds(): {
        minimum: number;
        maximum: number;
    } | null {
        const grid =
            gridRef.current;

        if (!grid) {
            return null;
        }

        const bounds =
            grid.getBoundingClientRect();

        const availableWidth =
            bounds.width -
            SFTP_SPLITTER_WIDTH;

        if (availableWidth <= 0) {
            return null;
        }

        const minimum =
            (
                MIN_SFTP_PANE_WIDTH /
                availableWidth
            ) * 100;

        const maximum =
            100 -
            (
                MIN_SFTP_PANE_WIDTH /
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

    function clampPanePercent(
        value: number,
    ): number {
        const bounds =
            getPaneBounds();

        if (!bounds) {
            return value;
        }

        return Math.min(
            bounds.maximum,
            Math.max(
                bounds.minimum,
                value,
            ),
        );
    }

    function updatePaneFromPointer(
        clientX: number,
    ): void {
        const grid =
            gridRef.current;

        if (!grid) {
            return;
        }

        const bounds =
            grid.getBoundingClientRect();

        const availableWidth =
            bounds.width -
            SFTP_SPLITTER_WIDTH;

        if (availableWidth <= 0) {
            return;
        }

        const pointerPosition =
            clientX -
            bounds.left -
            SFTP_SPLITTER_WIDTH / 2;

        const requestedPercent =
            (
                pointerPosition /
                availableWidth
            ) * 100;

        const nextPercent =
            clampPanePercent(
                requestedPercent,
            );

        setLeftPanePercent(
            Math.round(
                nextPercent * 10,
            ) / 10,
        );
    }

    function handleSplitterPointerDown(
        event:
            ReactPointerEvent<HTMLDivElement>,
    ): void {
        if (event.button !== 0) {
            return;
        }

        event.preventDefault();

        isResizingRef.current =
            true;

        setIsResizing(true);

        document.body.classList.add(
            "workspace-pane-resizing",
        );

        event.currentTarget
            .setPointerCapture(
                event.pointerId,
            );

        updatePaneFromPointer(
            event.clientX,
        );
    }

    function handleSplitterPointerMove(
        event:
            ReactPointerEvent<HTMLDivElement>,
    ): void {
        if (
            !isResizingRef.current
        ) {
            return;
        }

        event.preventDefault();

        updatePaneFromPointer(
            event.clientX,
        );
    }

    function finishResize(
        splitter: HTMLDivElement,
        pointerId: number,
    ): void {
        isResizingRef.current =
            false;

        setIsResizing(false);

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

    function handleSplitterPointerUp(
        event:
            ReactPointerEvent<HTMLDivElement>,
    ): void {
        finishResize(
            event.currentTarget,
            event.pointerId,
        );
    }

    function handleSplitterKeyDown(
        event:
            ReactKeyboardEvent<HTMLDivElement>,
    ): void {
        let difference = 0;

        if (
            event.key ===
            "ArrowLeft"
        ) {
            difference =
                -SFTP_KEYBOARD_RESIZE_STEP;
        }

        if (
            event.key ===
            "ArrowRight"
        ) {
            difference =
                SFTP_KEYBOARD_RESIZE_STEP;
        }

        if (difference === 0) {
            return;
        }

        event.preventDefault();

        setLeftPanePercent(
            (currentPercent) =>
                clampPanePercent(
                    currentPercent +
                    difference,
                ),
        );
    }

    return (
        <main className="sftp-workspace-page">
            <header className="sftp-workspace-topbar">
                <div className="sftp-workspace-topbar__title">
                    <span className="sftp-workspace-topbar__icon">
                        <FolderOpen
                            size={20}
                            aria-hidden="true"
                        />
                    </span>

                    <div>
                        <h1>
                            SFTP Transfer
                        </h1>

                        <p>
                            Browse two locations and
                            transfer files between
                            local folders and SSH
                            servers.
                        </p>
                    </div>
                </div>

                <button
                    type="button"
                    className="sftp-swap-button"
                    onClick={
                        swapPanes
                    }
                    title="Swap left and right pane sources"
                >
                    <ArrowLeftRight
                        size={15}
                        aria-hidden="true"
                    />

                    Swap panes
                </button>
            </header>

            {errorMessage && (
                <div className="sftp-workspace-error">
                    {errorMessage}
                </div>
            )}

            <section
                ref={gridRef}
                className={
                    isResizing
                        ? "sftp-dual-pane-grid workspace-grid--resizable workspace-grid--resizing"
                        : "sftp-dual-pane-grid workspace-grid--resizable"
                }
                style={{
                    gridTemplateColumns:
                        [
                            `minmax(${MIN_SFTP_PANE_WIDTH}px, ${leftPanePercent}fr)`,

                            `${SFTP_SPLITTER_WIDTH}px`,

                            `minmax(${MIN_SFTP_PANE_WIDTH}px, ${100 - leftPanePercent}fr)`,
                        ].join(" "),
                }}
            >
                <SftpPane
                    side="left"
                    source={
                        leftSource
                    }
                    servers={
                        servers
                    }
                    onSourceChange={(
                        source,
                    ) =>
                        updateSource(
                            "left",
                            source,
                        )
                    }
                    onChooseLocalFolder={() =>
                        chooseLocalFolder(
                            "left",
                        )
                    }
                    onClear={() =>
                        clearSource(
                            "left",
                        )
                    }
                    onDisconnectServer={
                        disconnectServer
                    }
                />

                <div
                    className="workspace-pane-splitter"
                    role="separator"
                    aria-label="Resize SFTP panes"
                    aria-orientation="vertical"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={
                        Math.round(
                            leftPanePercent,
                        )
                    }
                    tabIndex={0}
                    title="Drag to resize. Double-click to reset."
                    onPointerDown={
                        handleSplitterPointerDown
                    }
                    onPointerMove={
                        handleSplitterPointerMove
                    }
                    onPointerUp={
                        handleSplitterPointerUp
                    }
                    onPointerCancel={
                        handleSplitterPointerUp
                    }
                    onKeyDown={
                        handleSplitterKeyDown
                    }
                    onDoubleClick={() =>
                        setLeftPanePercent(
                            DEFAULT_LEFT_PANE_PERCENT,
                        )
                    }
                >
                    <span className="workspace-pane-splitter__line" />

                    <span className="workspace-pane-splitter__handle">
                        <i />
                        <i />
                        <i />
                    </span>
                </div>

                <SftpPane
                    side="right"
                    source={
                        rightSource
                    }
                    servers={
                        servers
                    }
                    onSourceChange={(
                        source,
                    ) =>
                        updateSource(
                            "right",
                            source,
                        )
                    }
                    onChooseLocalFolder={() =>
                        chooseLocalFolder(
                            "right",
                        )
                    }
                    onClear={() =>
                        clearSource(
                            "right",
                        )
                    }
                    onDisconnectServer={
                        disconnectServer
                    }
                />
            </section>
        </main>
    );
}
