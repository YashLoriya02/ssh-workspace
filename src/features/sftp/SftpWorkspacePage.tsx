import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
    type PointerEvent as ReactPointerEvent,
} from "react";

import {
    ArrowLeftRight,
    File,
    Folder,
    FolderOpen,
} from "lucide-react";

import {
    confirm as confirmDialog,
    open as openDialog,
} from "@tauri-apps/plugin-dialog";

import {
    homeDir,
} from "@tauri-apps/api/path";

import {
    backendClient,
    type HostKeyApprovalEvent,
    type HostKeyMismatchEvent,
    type HostKeyVerifiedEvent,
} from "../../backend/backend-client";

import {
    loadConnectionProfiles,
    markProfileConnected,
    type SavedConnectionProfile,
} from "../../store/connection-profile-store";

import {
    deleteSshPassword,
    loadSshPassword,
    saveSshPassword,
} from "../../store/ssh-credential-store";

import {
    loadKnownHost,
    markKnownHostVerified,
    saveKnownHost,
} from "../../store/known-host-store";

import {
    SftpPane,
} from "./SftpPane";

import type {
    SftpPaneSide,
    SftpPaneSource,
    SftpSavedServerOption,
    SftpServerOption,
} from "./sftp-types";

import type {
    PreparedSftpTransfer,
    SftpTransferEntry,
} from "./transfers/sftp-transfer-types";

import {
    getOppositePaneSide,
} from "./transfers/transfer-path-utils";

import {
    useSftpTransferManager,
} from "./transfers/useSftpTransferManager";

import {
    SftpTransferPanel,
} from "./transfers/SftpTransferPanel";

import {
    SftpConflictDialog,
} from "./transfers/SftpConflictDialog";

import {
    SftpSavedServerCredentialDialog,
    type SftpSavedServerCredentials,
} from "./SftpSavedServerCredentialDialog";

interface ActiveSftpPaneDrag {
    sourceSide: SftpPaneSide;
    source: SftpPaneSource;
    entry: SftpTransferEntry;
}

interface PendingSftpPaneDrag
    extends ActiveSftpPaneDrag {
    pointerId: number;
    startX: number;
    startY: number;
}

interface SftpPaneDropTarget {
    side: SftpPaneSide;
    directoryPath: string;
    kind: "pane" | "directory";
}

interface SftpDragPointer {
    x: number;
    y: number;
}

interface ConnectingSavedServer {
    side: SftpPaneSide;
    profile: SavedConnectionProfile;
}

interface SavedServerCredentialRequest {
    side: SftpPaneSide;
    profile: SavedConnectionProfile;
    errorMessage: string;
}

interface SftpWorkspacePageProps {
    servers:
        readonly SftpServerOption[];

    onDisconnectServer: (
        connectionId: string,
    ) => Promise<void>;

    onServerConnected: (
        server: SftpServerOption,
    ) => void;
}

const DEFAULT_LEFT_PANE_PERCENT =
    50;

const MIN_SFTP_PANE_WIDTH =
    340;

const SFTP_SPLITTER_WIDTH =
    12;

const SFTP_KEYBOARD_RESIZE_STEP =
    2;

const INTERNAL_DRAG_START_DISTANCE =
    7;

export function SftpWorkspacePage({
    servers,
    onDisconnectServer,
    onServerConnected,
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

    const [
        savedProfiles,
        setSavedProfiles,
    ] = useState<SavedConnectionProfile[]>([]);

    const [
        savedProfilesLoading,
        setSavedProfilesLoading,
    ] = useState(true);

    const [
        connectingSavedServer,
        setConnectingSavedServer,
    ] = useState<ConnectingSavedServer | null>(
        null,
    );

    const [
        credentialRequest,
        setCredentialRequest,
    ] = useState<SavedServerCredentialRequest | null>(
        null,
    );

    const connectingSavedServerRef =
        useRef<ConnectingSavedServer | null>(
            null,
        );

    const securityErrorRef =
        useRef<string | null>(null);

    const [
        activePaneDrag,
        setActivePaneDrag,
    ] = useState<ActiveSftpPaneDrag | null>(
        null,
    );

    const [
        paneDropTarget,
        setPaneDropTarget,
    ] = useState<SftpPaneDropTarget | null>(
        null,
    );

    const [
        dragPointer,
        setDragPointer,
    ] = useState<SftpDragPointer | null>(
        null,
    );

    const pendingPaneDragRef =
        useRef<PendingSftpPaneDrag | null>(
            null,
        );

    const activePaneDragRef =
        useRef<ActiveSftpPaneDrag | null>(
            null,
        );

    const paneDropTargetRef =
        useRef<SftpPaneDropTarget | null>(
            null,
        );

    const suppressNextClickRef =
        useRef(false);

    const [
        paneRefreshVersions,
        setPaneRefreshVersions,
    ] = useState<Record<SftpPaneSide, number>>({
        left: 0,
        right: 0,
    });

    const savedServerOptions:
        SftpSavedServerOption[] =
        savedProfiles.map(
            (profile) => ({
                id: profile.id,
                name: profile.name,
                host: profile.host,
                port: profile.port,
                username: profile.username,
                authenticationType:
                    profile.authenticationType,
            }),
        );

    const handleTransferCompleted =
        useCallback(
            (
                transfer:
                    PreparedSftpTransfer,
            ): void => {
                const destinationSide =
                    transfer.destination?.side;

                if (!destinationSide) {
                    return;
                }

                setPaneRefreshVersions(
                    (
                        currentVersions,
                    ) => ({
                        ...currentVersions,
                        [destinationSide]:
                            currentVersions[
                                destinationSide
                            ] + 1,
                    }),
                );
            },
            [],
        );

    const transferManager =
        useSftpTransferManager({
            onTransferCompleted:
                handleTransferCompleted,
        });

    const refreshSavedProfiles =
        useCallback(
            async (): Promise<void> => {
                const profiles =
                    await loadConnectionProfiles();

                setSavedProfiles(profiles);
            },
            [],
        );

    useEffect(() => {
        let disposed = false;

        setSavedProfilesLoading(true);

        void loadConnectionProfiles()
            .then((profiles) => {
                if (!disposed) {
                    setSavedProfiles(profiles);
                }
            })
            .catch((error: unknown) => {
                if (!disposed) {
                    setErrorMessage(
                        error instanceof Error
                            ? error.message
                            : String(error),
                    );
                }
            })
            .finally(() => {
                if (!disposed) {
                    setSavedProfilesLoading(false);
                }
            });

        return () => {
            disposed = true;
        };
    }, []);

    useEffect(() => {
        connectingSavedServerRef.current =
            connectingSavedServer;
    }, [connectingSavedServer]);

    useEffect(() => {
        return backendClient.subscribeToEvents(
            (event) => {
                if (
                    event.type ===
                    "connection.hostKeyApprovalRequired"
                ) {
                    const hostKey =
                        event.payload as
                            HostKeyApprovalEvent;

                    const connecting =
                        connectingSavedServerRef.current;

                    if (
                        !connecting ||
                        connecting.profile.host
                            .trim()
                            .toLowerCase() !==
                            hostKey.host
                                .trim()
                                .toLowerCase() ||
                        connecting.profile.port !==
                            hostKey.port
                    ) {
                        return;
                    }

                    void (async () => {
                        try {
                            const accepted =
                                await confirmDialog(
                                    [
                                        "The server's identity has not been verified.",
                                        "",
                                        `Host: ${hostKey.host}:${hostKey.port}`,
                                        `Key type: ${hostKey.keyType}`,
                                        `Fingerprint: ${hostKey.fingerprint}`,
                                        "",
                                        "Only continue if this fingerprint belongs to the expected server.",
                                    ].join("\n"),
                                    {
                                        title:
                                            "Verify SSH Host",
                                        kind: "warning",
                                    },
                                );

                            if (!accepted) {
                                securityErrorRef.current =
                                    "SSH host verification was cancelled.";
                            }

                            await backendClient.decideHostKey(
                                hostKey.connectionId,
                                accepted,
                            );

                            if (!accepted) {
                                return;
                            }

                            try {
                                await saveKnownHost({
                                    host: hostKey.host,
                                    port: hostKey.port,
                                    keyType:
                                        hostKey.keyType,
                                    fingerprint:
                                        hostKey.fingerprint,
                                });
                            } catch (error) {
                                console.error(
                                    "SSH host was accepted, but its fingerprint could not be saved:",
                                    error,
                                );
                            }
                        } catch (error) {
                            securityErrorRef.current =
                                error instanceof Error
                                    ? error.message
                                    : String(error);
                        }
                    })();

                    return;
                }

                if (
                    event.type ===
                    "connection.hostKeyVerified"
                ) {
                    const verifiedHost =
                        event.payload as
                            HostKeyVerifiedEvent;

                    void markKnownHostVerified(
                        verifiedHost.host,
                        verifiedHost.port,
                    ).catch((error: unknown) => {
                        console.error(
                            "Unable to update known host:",
                            error,
                        );
                    });

                    return;
                }

                if (
                    event.type ===
                    "connection.hostKeyMismatch"
                ) {
                    const mismatch =
                        event.payload as
                            HostKeyMismatchEvent;

                    const connecting =
                        connectingSavedServerRef.current;

                    if (
                        !connecting ||
                        connecting.profile.host
                            .trim()
                            .toLowerCase() !==
                            mismatch.host
                                .trim()
                                .toLowerCase() ||
                        connecting.profile.port !==
                            mismatch.port
                    ) {
                        return;
                    }

                    securityErrorRef.current = [
                        "The SSH server identity has changed.",
                        "",
                        `Host: ${mismatch.host}:${mismatch.port}`,
                        "",
                        `Expected: ${mismatch.expectedFingerprint}`,
                        `Received: ${mismatch.receivedFingerprint}`,
                        "",
                        "The connection was blocked. Verify the server before trying again.",
                    ].join("\n");
                }
            },
        );
    }, []);

    useEffect(() => {
        let disposed = false;

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
            disposed = true;
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

            document.body.classList.remove(
                "sftp-entry-dragging",
            );
        };
    }, []);

    useEffect(() => {
        activePaneDragRef.current =
            activePaneDrag;

        document.body.classList.toggle(
            "sftp-entry-dragging",
            Boolean(activePaneDrag),
        );

        return () => {
            document.body.classList.remove(
                "sftp-entry-dragging",
            );
        };
    }, [activePaneDrag]);

    useEffect(() => {
        paneDropTargetRef.current =
            paneDropTarget;
    }, [paneDropTarget]);

    useEffect(() => {
        function clearPointerDrag(): void {
            pendingPaneDragRef.current =
                null;

            activePaneDragRef.current =
                null;

            paneDropTargetRef.current =
                null;

            setActivePaneDrag(null);
            setPaneDropTarget(null);
            setDragPointer(null);
        }

        function resolveDropTarget(
            clientX: number,
            clientY: number,
            drag:
                ActiveSftpPaneDrag,
        ): SftpPaneDropTarget | null {
            const element =
                document.elementFromPoint(
                    clientX,
                    clientY,
                );

            if (!(element instanceof Element)) {
                return null;
            }

            const directoryElement =
                element.closest<HTMLElement>(
                    "[data-sftp-drop-directory]",
                );

            const paneElement =
                element.closest<HTMLElement>(
                    "[data-sftp-pane-drop]",
                );

            const targetElement =
                directoryElement ??
                paneElement;

            if (!targetElement) {
                return null;
            }

            const sideValue =
                targetElement.dataset
                    .sftpPaneSide;

            if (
                sideValue !== "left" &&
                sideValue !== "right"
            ) {
                return null;
            }

            if (
                sideValue ===
                drag.sourceSide
            ) {
                return null;
            }

            const directoryPath =
                directoryElement
                    ?.dataset
                    .sftpDropDirectory ??
                paneElement
                    ?.dataset
                    .sftpCurrentDirectory;

            if (!directoryPath) {
                return null;
            }

            return {
                side: sideValue,
                directoryPath,
                kind:
                    directoryElement
                        ? "directory"
                        : "pane",
            };
        }

        function sameDropTarget(
            first:
                SftpPaneDropTarget | null,
            second:
                SftpPaneDropTarget | null,
        ): boolean {
            return (
                first?.side ===
                    second?.side &&
                first?.directoryPath ===
                    second?.directoryPath &&
                first?.kind ===
                    second?.kind
            );
        }

        function handlePointerMove(
            event: PointerEvent,
        ): void {
            const pending =
                pendingPaneDragRef.current;

            let drag =
                activePaneDragRef.current;

            if (
                !drag &&
                pending &&
                pending.pointerId ===
                    event.pointerId
            ) {
                const distance =
                    Math.hypot(
                        event.clientX -
                            pending.startX,
                        event.clientY -
                            pending.startY,
                    );

                if (
                    distance >=
                    INTERNAL_DRAG_START_DISTANCE
                ) {
                    drag = {
                        sourceSide:
                            pending.sourceSide,
                        source:
                            pending.source,
                        entry:
                            pending.entry,
                    };

                    activePaneDragRef.current =
                        drag;

                    setActivePaneDrag(
                        drag,
                    );
                }
            }

            if (!drag) {
                return;
            }

            event.preventDefault();

            setDragPointer({
                x: event.clientX,
                y: event.clientY,
            });

            const nextTarget =
                resolveDropTarget(
                    event.clientX,
                    event.clientY,
                    drag,
                );

            if (
                !sameDropTarget(
                    paneDropTargetRef.current,
                    nextTarget,
                )
            ) {
                paneDropTargetRef.current =
                    nextTarget;

                setPaneDropTarget(
                    nextTarget,
                );
            }
        }

        function handlePointerUp(
            event: PointerEvent,
        ): void {
            const pending =
                pendingPaneDragRef.current;

            if (
                pending &&
                pending.pointerId !==
                    event.pointerId
            ) {
                return;
            }

            const drag =
                activePaneDragRef.current;

            const target =
                paneDropTargetRef.current;

            if (drag) {
                event.preventDefault();
                suppressNextClickRef.current =
                    true;

                if (target) {
                    const currentDestination =
                        getSourceForSide(
                            target.side,
                        );

                    const destination:
                        SftpPaneSource =
                        currentDestination.type ===
                            "empty"
                            ? currentDestination
                            : {
                                ...currentDestination,
                                path:
                                    target.directoryPath,
                            };

                    transferManager.prepareCopy({
                        sourceSide:
                            drag.sourceSide,
                        source:
                            drag.source,
                        destinationSide:
                            target.side,
                        destination,
                        entries: [
                            drag.entry,
                        ],
                        trigger:
                            "drag-drop",
                        servers,
                    });
                }
            }

            clearPointerDrag();
        }

        function handlePointerCancel(): void {
            clearPointerDrag();
        }

        function handleClickCapture(
            event: MouseEvent,
        ): void {
            if (
                !suppressNextClickRef.current
            ) {
                return;
            }

            suppressNextClickRef.current =
                false;

            event.preventDefault();
            event.stopPropagation();
        }

        document.addEventListener(
            "pointermove",
            handlePointerMove,
            {
                capture: true,
                passive: false,
            },
        );

        document.addEventListener(
            "pointerup",
            handlePointerUp,
            true,
        );

        document.addEventListener(
            "pointercancel",
            handlePointerCancel,
            true,
        );

        document.addEventListener(
            "click",
            handleClickCapture,
            true,
        );

        window.addEventListener(
            "blur",
            handlePointerCancel,
        );

        return () => {
            document.removeEventListener(
                "pointermove",
                handlePointerMove,
                true,
            );

            document.removeEventListener(
                "pointerup",
                handlePointerUp,
                true,
            );

            document.removeEventListener(
                "pointercancel",
                handlePointerCancel,
                true,
            );

            document.removeEventListener(
                "click",
                handleClickCapture,
                true,
            );

            window.removeEventListener(
                "blur",
                handlePointerCancel,
            );
        };
    }, [
        servers,
        transferManager,
        leftSource,
        rightSource,
    ]);

    function setSourceForSide(
        side: SftpPaneSide,
        source: SftpPaneSource,
    ): void {
        if (side === "left") {
            setLeftSource(source);
        } else {
            setRightSource(source);
        }
    }

    function getSourceForSide(
        side: SftpPaneSide,
    ): SftpPaneSource {
        return side === "left"
            ? leftSource
            : rightSource;
    }

    function findActiveServerForProfile(
        profile: SavedConnectionProfile,
    ): SftpServerOption | undefined {
        return servers.find(
            (server) =>
                server.host
                    .trim()
                    .toLowerCase() ===
                    profile.host
                        .trim()
                        .toLowerCase() &&
                server.port === profile.port &&
                server.username.trim() ===
                    profile.username.trim(),
        );
    }

    function setConnectingServer(
        value: ConnectingSavedServer | null,
    ): void {
        connectingSavedServerRef.current =
            value;

        setConnectingSavedServer(value);
    }

    function openCredentialDialog(
        side: SftpPaneSide,
        profile: SavedConnectionProfile,
        error: string = "",
    ): void {
        setCredentialRequest({
            side,
            profile,
            errorMessage: error,
        });
    }

    async function connectSavedProfile(
        side: SftpPaneSide,
        profile: SavedConnectionProfile,
        credentials:
            SftpSavedServerCredentials,
        usedStoredPassword: boolean,
    ): Promise<void> {
        if (
            connectingSavedServerRef.current
        ) {
            return;
        }

        const connecting: ConnectingSavedServer = {
            side,
            profile,
        };

        setErrorMessage("");
        setCredentialRequest(null);
        securityErrorRef.current = null;
        setConnectingServer(connecting);

        try {
            await backendClient.start();

            const rememberedHost =
                await loadKnownHost(
                    profile.host,
                    profile.port,
                );

            const authentication =
                credentials.type === "password"
                    ? {
                        type: "password" as const,
                        password:
                            credentials.password,
                    }
                    : {
                        type: "privateKey" as const,
                        privateKey:
                            credentials.privateKey,

                        ...(credentials.passphrase
                            ? {
                                passphrase:
                                    credentials.passphrase,
                            }
                            : {}),
                    };

            const connectionId =
                await backendClient.connectSsh({
                    host: profile.host,
                    port: profile.port,
                    username:
                        profile.username,
                    authentication,

                    ...(rememberedHost
                        ? {
                            knownHostFingerprint:
                                rememberedHost
                                    .fingerprint,
                        }
                        : {}),
                });

            const connectedServer:
                SftpServerOption = {
                connectionId,
                title: profile.name,
                host: profile.host,
                port: profile.port,
                username: profile.username,
            };

            onServerConnected(
                connectedServer,
            );

            setSourceForSide(
                side,
                {
                    type: "remote",
                    connectionId,
                    path: null,
                },
            );

            if (
                credentials.type ===
                    "password" &&
                !usedStoredPassword
            ) {
                try {
                    if (
                        credentials
                            .rememberPassword
                    ) {
                        await saveSshPassword(
                            profile.id,
                            credentials.password,
                        );
                    } else {
                        await deleteSshPassword(
                            profile.id,
                        );
                    }
                } catch (error) {
                    setErrorMessage(
                        [
                            "Connected, but the password preference could not be updated.",
                            error instanceof Error
                                ? error.message
                                : String(error),
                        ].join(" "),
                    );
                }
            }

            try {
                await markProfileConnected(
                    profile.id,
                );

                await refreshSavedProfiles();
            } catch (error) {
                console.error(
                    "Unable to update recent saved server:",
                    error,
                );
            }
        } catch (error) {
            const securityError =
                securityErrorRef.current;

            const message =
                securityError ??
                (
                    error instanceof Error
                        ? error.message
                        : String(error)
                );

            setErrorMessage(message);

            if (!securityError) {
                openCredentialDialog(
                    side,
                    profile,
                    usedStoredPassword
                        ? [
                            "The saved password could not connect to this server.",
                            "Enter the current password and try again.",
                            message,
                        ].join(" ")
                        : message,
                );
            }
        } finally {
            setConnectingServer(null);
        }
    }

    async function selectSavedServer(
        side: SftpPaneSide,
        profileId: string,
    ): Promise<void> {
        if (
            connectingSavedServerRef.current
        ) {
            return;
        }

        const profile =
            savedProfiles.find(
                (candidate) =>
                    candidate.id ===
                    profileId,
            );

        if (!profile) {
            setErrorMessage(
                "The selected saved server could not be found.",
            );

            return;
        }

        const activeServer =
            findActiveServerForProfile(
                profile,
            );

        if (activeServer) {
            updateSource(
                side,
                {
                    type: "remote",
                    connectionId:
                        activeServer.connectionId,
                    path: null,
                },
            );

            return;
        }

        setErrorMessage("");

        if (
            profile.authenticationType ===
            "privateKey"
        ) {
            openCredentialDialog(
                side,
                profile,
            );

            return;
        }

        const loading:
            ConnectingSavedServer = {
            side,
            profile,
        };

        setConnectingServer(loading);

        try {
            const savedPassword =
                await loadSshPassword(
                    profile.id,
                );

            setConnectingServer(null);

            if (!savedPassword) {
                openCredentialDialog(
                    side,
                    profile,
                    "No saved password was found. Enter it once to connect.",
                );

                return;
            }

            await connectSavedProfile(
                side,
                profile,
                {
                    type: "password",
                    password:
                        savedPassword,
                    rememberPassword:
                        false,
                },
                true,
            );
        } catch (error) {
            setConnectingServer(null);

            openCredentialDialog(
                side,
                profile,
                error instanceof Error
                    ? error.message
                    : String(error),
            );
        }
    }

    function updateSource(
        side: SftpPaneSide,
        source: SftpPaneSource,
    ): void {
        setErrorMessage("");
        setSourceForSide(
            side,
            source,
        );

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

                    if (side === "left") {
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

                    rootPath:
                        selectedPath,

                    path:
                        selectedPath,
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

    function handleCopyToOtherPane(
        sourceSide: SftpPaneSide,
        entry: SftpTransferEntry,
    ): void {
        const destinationSide =
            getOppositePaneSide(
                sourceSide,
            );

        transferManager.prepareCopy({
            sourceSide,
            source:
                getSourceForSide(
                    sourceSide,
                ),
            destinationSide,
            destination:
                getSourceForSide(
                    destinationSide,
                ),
            entries: [entry],
            trigger:
                "context-menu",
            servers,
        });
    }

    function handleEntryPointerDown(
        sourceSide: SftpPaneSide,
        entry: SftpTransferEntry,
        pointer: {
            pointerId: number;
            clientX: number;
            clientY: number;
            button: number;
        },
    ): void {
        if (
            pointer.button !== 0 ||
            connectingSavedServerRef.current
        ) {
            return;
        }

        const source =
            getSourceForSide(
                sourceSide,
            );

        if (source.type === "empty") {
            return;
        }

        pendingPaneDragRef.current = {
            sourceSide,
            source,
            entry,
            pointerId:
                pointer.pointerId,
            startX:
                pointer.clientX,
            startY:
                pointer.clientY,
        };

        setDragPointer({
            x: pointer.clientX,
            y: pointer.clientY,
        });
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
        if (!isResizingRef.current) {
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

        if (event.key === "ArrowLeft") {
            difference =
                -SFTP_KEYBOARD_RESIZE_STEP;
        }

        if (event.key === "ArrowRight") {
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
                    onClick={swapPanes}
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

            <SftpTransferPanel
                transfers={
                    transferManager
                        .preparedTransfers
                }
                onCancel={(
                    transferId,
                ) => {
                    void transferManager
                        .cancelPreparedTransfer(
                            transferId,
                        );
                }}
                onDismiss={
                    transferManager
                        .dismissPreparedTransfer
                }
                onClear={
                    transferManager
                        .clearPreparedTransfers
                }
            />

            <SftpConflictDialog
                conflict={
                    transferManager.pendingConflict
                }
                onDecision={
                    transferManager.resolveConflict
                }
            />

            <SftpSavedServerCredentialDialog
                server={
                    credentialRequest
                        ? {
                            id:
                                credentialRequest
                                    .profile.id,
                            name:
                                credentialRequest
                                    .profile.name,
                            host:
                                credentialRequest
                                    .profile.host,
                            port:
                                credentialRequest
                                    .profile.port,
                            username:
                                credentialRequest
                                    .profile.username,
                            authenticationType:
                                credentialRequest
                                    .profile
                                    .authenticationType,
                        }
                        : null
                }
                errorMessage={
                    credentialRequest
                        ?.errorMessage ??
                    ""
                }
                isSubmitting={
                    Boolean(
                        connectingSavedServer,
                    )
                }
                onCancel={() =>
                    setCredentialRequest(
                        null,
                    )
                }
                onSubmit={(credentials) => {
                    if (!credentialRequest) {
                        return;
                    }

                    void connectSavedProfile(
                        credentialRequest.side,
                        credentialRequest.profile,
                        credentials,
                        false,
                    );
                }}
            />

            {activePaneDrag &&
                dragPointer && (
                    <div
                        className="sftp-pointer-drag-preview"
                        style={{
                            left:
                                dragPointer.x,
                            top:
                                dragPointer.y,
                        }}
                        aria-hidden="true"
                    >
                        <span>
                            {activePaneDrag
                                .entry.type ===
                            "directory" ? (
                                <Folder
                                    size={17}
                                />
                            ) : (
                                <File
                                    size={17}
                                />
                            )}
                        </span>

                        <strong>
                            {
                                activePaneDrag
                                    .entry.name
                            }
                        </strong>

                        <small>
                            Copy
                        </small>
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
                    source={leftSource}
                    refreshVersion={
                        paneRefreshVersions.left
                    }
                    servers={servers}
                    savedServers={
                        savedServerOptions
                    }
                    savedServersLoading={
                        savedProfilesLoading
                    }
                    pendingSavedServer={
                        connectingSavedServer
                            ?.side === "left"
                            ? savedServerOptions.find(
                                (server) =>
                                    server.id ===
                                    connectingSavedServer
                                        .profile.id,
                            ) ?? null
                            : null
                    }
                    serverConnectionBusy={
                        Boolean(
                            connectingSavedServer,
                        )
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
                    onSelectSavedServer={(
                        profileId,
                    ) => {
                        void selectSavedServer(
                            "left",
                            profileId,
                        );
                    }}
                    onCopyToOtherPane={(
                        entry,
                    ) =>
                        handleCopyToOtherPane(
                            "left",
                            entry,
                        )
                    }
                    draggedEntryPath={
                        activePaneDrag
                            ?.sourceSide ===
                            "left"
                            ? activePaneDrag
                                .entry.path
                            : null
                    }
                    isDropEnabled={
                        Boolean(
                            !connectingSavedServer &&
                            activePaneDrag &&
                            activePaneDrag
                                .sourceSide !==
                                "left" &&
                            leftSource.type !==
                                "empty" &&
                            leftSource.path,
                        )
                    }
                    paneDropActive={
                        paneDropTarget
                            ?.side ===
                            "left" &&
                        paneDropTarget
                            .kind ===
                            "pane"
                    }
                    dropTargetDirectoryPath={
                        paneDropTarget
                            ?.side ===
                            "left" &&
                        paneDropTarget
                            .kind ===
                            "directory"
                            ? paneDropTarget
                                .directoryPath
                            : null
                    }
                    onEntryPointerDown={(
                        entry,
                        pointer,
                    ) =>
                        handleEntryPointerDown(
                            "left",
                            entry,
                            pointer,
                        )
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
                    source={rightSource}
                    refreshVersion={
                        paneRefreshVersions.right
                    }
                    servers={servers}
                    savedServers={
                        savedServerOptions
                    }
                    savedServersLoading={
                        savedProfilesLoading
                    }
                    pendingSavedServer={
                        connectingSavedServer
                            ?.side === "right"
                            ? savedServerOptions.find(
                                (server) =>
                                    server.id ===
                                    connectingSavedServer
                                        .profile.id,
                            ) ?? null
                            : null
                    }
                    serverConnectionBusy={
                        Boolean(
                            connectingSavedServer,
                        )
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
                    onSelectSavedServer={(
                        profileId,
                    ) => {
                        void selectSavedServer(
                            "right",
                            profileId,
                        );
                    }}
                    onCopyToOtherPane={(
                        entry,
                    ) =>
                        handleCopyToOtherPane(
                            "right",
                            entry,
                        )
                    }
                    draggedEntryPath={
                        activePaneDrag
                            ?.sourceSide ===
                            "right"
                            ? activePaneDrag
                                .entry.path
                            : null
                    }
                    isDropEnabled={
                        Boolean(
                            !connectingSavedServer &&
                            activePaneDrag &&
                            activePaneDrag
                                .sourceSide !==
                                "right" &&
                            rightSource.type !==
                                "empty" &&
                            rightSource.path,
                        )
                    }
                    paneDropActive={
                        paneDropTarget
                            ?.side ===
                            "right" &&
                        paneDropTarget
                            .kind ===
                            "pane"
                    }
                    dropTargetDirectoryPath={
                        paneDropTarget
                            ?.side ===
                            "right" &&
                        paneDropTarget
                            .kind ===
                            "directory"
                            ? paneDropTarget
                                .directoryPath
                            : null
                    }
                    onEntryPointerDown={(
                        entry,
                        pointer,
                    ) =>
                        handleEntryPointerDown(
                            "right",
                            entry,
                            pointer,
                        )
                    }
                />
            </section>
        </main>
    );
}
