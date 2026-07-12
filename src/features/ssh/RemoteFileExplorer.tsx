import {
    useCallback,
    useEffect,
    useMemo,
    useState,
    useRef,
    type FormEvent,
    type MouseEvent as ReactMouseEvent,
} from "react";

import {
    backendClient,
    type RemoteDirectoryListing,
    type RemoteFileEntry,
} from "../../backend/backend-client";

import {
    confirm as confirmDialog,
    open as openDialog,
    save,
} from "@tauri-apps/plugin-dialog";

import {
    ArrowUp,
    CheckCircle,
    Copy,
    Download,
    FileText,
    FolderOpen,
    FolderPlus,
    Info,
    Loader,
    Pencil,
    RefreshCcw,
    Trash2,
    Upload,
    X,
} from "lucide-react";

import {
    getCurrentWebview,
} from "@tauri-apps/api/webview";

import {
    getCurrentWindow,
} from "@tauri-apps/api/window";

import type {
    TransferEventPayload,
} from "../../backend/backend-client";

interface RemoteFileExplorerProps {
    connectionId: string;
    isActive: boolean;

    onEditFile: (
        entry: RemoteFileEntry,
    ) => void;

    externalFileChange?: {
        path: string;
        version: number;
    } | null;
}

interface Breadcrumb {
    label: string;
    path: string;
}

interface LoadDirectoryOptions {
    forceRefresh?: boolean;
}

interface RemoteContextMenuState {
    x: number;
    y: number;
    entry: RemoteFileEntry | null;
}

interface RemoteDetailsDialogState {
    entry: RemoteFileEntry;
    loading: boolean;
    error: string;
}

interface RemoteRenameDialogState {
    entry: RemoteFileEntry;
    name: string;
    error: string;
}

interface NewFolderDialogState {
    parentPath: string;
    name: string;
    error: string;
}

const DEFAULT_DIRECTORY_CACHE_KEY =
    "__default_remote_directory__";

function getDirectoryCacheKey(
    remotePath?: string,
): string {
    const normalizedPath =
        remotePath?.trim();

    return normalizedPath ||
        DEFAULT_DIRECTORY_CACHE_KEY;
}

function getRemoteParentDirectory(
    remotePath: string,
): string {
    const normalizedPath =
        remotePath.replace(
            /\/+$/u,
            "",
        );

    if (
        !normalizedPath ||
        normalizedPath === "/"
    ) {
        return "/";
    }

    const lastSlashIndex =
        normalizedPath.lastIndexOf("/");

    if (lastSlashIndex < 0) {
        return ".";
    }

    if (lastSlashIndex === 0) {
        return "/";
    }

    return normalizedPath.slice(
        0,
        lastSlashIndex,
    );
}

function getRemoteEntryTypeLabel(
    type: RemoteFileEntry["type"],
): string {
    switch (type) {
        case "directory":
            return "Directory";

        case "file":
            return "File";

        case "symlink":
            return "Symbolic link";

        default:
            return "Other";
    }
}

function validateRemoteName(
    value: string,
): string | null {
    const name = value.trim();

    if (!name) {
        return "Enter a name.";
    }

    if (
        name === "." ||
        name === ".."
    ) {
        return `"${name}" cannot be used as a file or folder name.`;
    }

    if (name.includes("/")) {
        return "Names cannot contain a forward slash.";
    }

    if (name.includes("\0")) {
        return "Names cannot contain a null character.";
    }

    return null;
}

async function copyTextToClipboard(
    value: string,
): Promise<void> {
    if (
        navigator.clipboard &&
        window.isSecureContext
    ) {
        await navigator.clipboard.writeText(
            value,
        );

        return;
    }

    const textarea =
        document.createElement("textarea");

    textarea.value = value;
    textarea.readOnly = true;

    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";

    document.body.appendChild(
        textarea,
    );

    textarea.select();

    const copied =
        document.execCommand("copy");

    textarea.remove();

    if (!copied) {
        throw new Error(
            "Unable to copy the remote path.",
        );
    }
}

function formatFileSize(bytes: number): string {
    if (bytes === 0) {
        return "0 B";
    }

    const units = [
        "B",
        "KB",
        "MB",
        "GB",
        "TB",
    ];

    const unitIndex = Math.min(
        Math.floor(
            Math.log(bytes) / Math.log(1024),
        ),
        units.length - 1,
    );

    const value =
        bytes / Math.pow(1024, unitIndex);

    return `${value.toFixed(
        unitIndex === 0 ? 0 : 1,
    )} ${units[unitIndex]}`;
}

function getLocalFileName(
    localPath: string,
): string {
    const segments =
        localPath.split(/[\\/]/u);

    return (
        segments[segments.length - 1] ||
        "unnamed-file"
    );
}

function joinRemotePath(
    remoteDirectory: string,
    filename: string,
): string {
    const cleanedDirectory =
        remoteDirectory === "/"
            ? ""
            : remoteDirectory.replace(
                /\/+$/u,
                "",
            );

    return `${cleanedDirectory}/${filename}`;
}

function formatModifiedTime(
    timestamp: number | null,
): string {
    if (timestamp === null) {
        return "—";
    }

    return new Date(
        timestamp * 1000,
    ).toLocaleString();
}

function getFileIcon(
    entry: RemoteFileEntry,
): string {
    switch (entry.type) {
        case "directory":
            return "📁";

        case "symlink":
            return "🔗";

        case "file":
            return "📄";

        default:
            return "◻";
    }
}

function buildBreadcrumbs(
    remotePath: string,
): Breadcrumb[] {
    const breadcrumbs: Breadcrumb[] = [
        {
            label: "/",
            path: "/",
        },
    ];

    const segments = remotePath
        .split("/")
        .filter(Boolean);

    let accumulatedPath = "";

    for (const segment of segments) {
        accumulatedPath += `/${segment}`;

        breadcrumbs.push({
            label: segment,
            path: accumulatedPath,
        });
    }

    return breadcrumbs;
}

export function RemoteFileExplorer({
    connectionId,
    isActive,
    onEditFile,
    externalFileChange,
}: RemoteFileExplorerProps) {
    const [listing, setListing] =
        useState<RemoteDirectoryListing | null>(
            null,
        );

    const [pathInput, setPathInput] =
        useState(".");

    const [loading, setLoading] =
        useState(true);

    const [errorMessage, setErrorMessage] =
        useState("");

    const [selectedPath, setSelectedPath] =
        useState<string | null>(null);

    const [
        contextMenu,
        setContextMenu,
    ] = useState<RemoteContextMenuState | null>(
        null,
    );

    const [
        detailsDialog,
        setDetailsDialog,
    ] = useState<RemoteDetailsDialogState | null>(
        null,
    );

    const [
        renameDialog,
        setRenameDialog,
    ] = useState<RemoteRenameDialogState | null>(
        null,
    );

    const [
        newFolderDialog,
        setNewFolderDialog,
    ] = useState<NewFolderDialogState | null>(
        null,
    );

    const [
        isMutating,
        setIsMutating,
    ] = useState(false);

    const [
        toastMessage,
        setToastMessage,
    ] = useState("");

    const toastTimerRef =
        useRef<ReturnType<typeof setTimeout> | null>(
            null,
        );

    const breadcrumbs = useMemo(
        () =>
            listing
                ? buildBreadcrumbs(listing.path)
                : [],
        [listing],
    );

    const directoryCacheRef =
        useRef<
            Map<
                string,
                RemoteDirectoryListing
            >
        >(
            new Map(),
        );

    const latestDirectoryRequestRef =
        useRef(0);

    const dropTargetRef =
        useRef<HTMLElement | null>(null);

    const [isDraggingFiles, setIsDraggingFiles] =
        useState(false);

    const [isUploading, setIsUploading] =
        useState(false);

    function showToast(
        message: string,
    ): void {
        if (toastTimerRef.current) {
            clearTimeout(
                toastTimerRef.current,
            );
        }

        setToastMessage(message);

        toastTimerRef.current =
            setTimeout(() => {
                setToastMessage("");
                toastTimerRef.current = null;
            }, 2_500);
    }

    useEffect(() => {
        return () => {
            if (toastTimerRef.current) {
                clearTimeout(
                    toastTimerRef.current,
                );
            }
        };
    }, []);

    useEffect(() => {
        if (!contextMenu) {
            return;
        }

        function handleOutsidePointerDown(
            event: PointerEvent,
        ): void {
            if (
                event.target instanceof Element &&
                event.target.closest(
                    ".remote-context-menu",
                )
            ) {
                return;
            }

            setContextMenu(null);
        }

        function handleKeyDown(
            event: KeyboardEvent,
        ): void {
            if (event.key === "Escape") {
                setContextMenu(null);
            }
        }

        function handleDismiss(): void {
            setContextMenu(null);
        }

        document.addEventListener(
            "pointerdown",
            handleOutsidePointerDown,
        );

        document.addEventListener(
            "keydown",
            handleKeyDown,
        );

        document.addEventListener(
            "scroll",
            handleDismiss,
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

        return () => {
            document.removeEventListener(
                "pointerdown",
                handleOutsidePointerDown,
            );

            document.removeEventListener(
                "keydown",
                handleKeyDown,
            );

            document.removeEventListener(
                "scroll",
                handleDismiss,
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
        };
    }, [contextMenu]);

    useEffect(() => {
        if (!isActive) {
            setContextMenu(null);
        }
    }, [isActive]);

    const uploadFiles = useCallback(
        async (
            localPaths: string[],
            destinationListing:
                RemoteDirectoryListing | null =
                listing,
        ): Promise<void> => {
            if (!destinationListing) {
                setErrorMessage(
                    "Wait for the remote directory to load before uploading.",
                );

                return;
            }

            const uniqueLocalPaths = [
                ...new Set(localPaths),
            ];

            if (uniqueLocalPaths.length === 0) {
                return;
            }

            setErrorMessage("");
            setIsUploading(true);

            try {
                const candidates =
                    uniqueLocalPaths.map((localPath) => {
                        const name =
                            getLocalFileName(localPath);

                        const existingEntry =
                            destinationListing.entries.find(
                                (entry) =>
                                    entry.name === name,
                            );

                        return {
                            localPath,
                            name,
                            existingEntry,
                            remotePath: joinRemotePath(
                                destinationListing.path,
                                name,
                            ),
                        };
                    });

                const directoryConflicts =
                    candidates.filter(
                        (candidate) =>
                            candidate.existingEntry?.type ===
                            "directory",
                    );

                if (directoryConflicts.length > 0) {
                    throw new Error(
                        [
                            "Cannot upload because remote directories exist with these names:",
                            ...directoryConflicts.map(
                                (candidate) =>
                                    candidate.name,
                            ),
                        ].join("\n"),
                    );
                }

                const fileConflicts =
                    candidates.filter(
                        (candidate) =>
                            candidate.existingEntry?.type ===
                            "file",
                    );

                let overwriteExistingFiles = false;

                if (fileConflicts.length > 0) {
                    overwriteExistingFiles =
                        await confirmDialog(
                            [
                                `${fileConflicts.length} remote file(s) already exist.`,
                                "",
                                ...fileConflicts
                                    .slice(0, 8)
                                    .map(
                                        (candidate) =>
                                            `• ${candidate.name}`,
                                    ),
                                ...(fileConflicts.length > 8
                                    ? [
                                        `• and ${fileConflicts.length - 8} more`,
                                    ]
                                    : []),
                                "",
                                "Replace the existing files?",
                            ].join("\n"),
                            {
                                title:
                                    "Replace remote files?",
                                kind: "warning",
                            },
                        );
                }

                const candidatesToUpload =
                    candidates.filter((candidate) => {
                        if (
                            candidate.existingEntry?.type !==
                            "file"
                        ) {
                            return true;
                        }

                        return overwriteExistingFiles;
                    });

                if (
                    candidatesToUpload.length === 0
                ) {
                    return;
                }

                const results =
                    await Promise.allSettled(
                        candidatesToUpload.map(
                            (candidate) =>
                                backendClient.uploadLocalFile(
                                    connectionId,
                                    candidate.localPath,
                                    candidate.remotePath,
                                    Boolean(
                                        candidate.existingEntry,
                                    ) &&
                                    overwriteExistingFiles,
                                ),
                        ),
                    );

                const failures = results
                    .map((result, index) => ({
                        result,
                        candidate:
                            candidatesToUpload[index],
                    }))
                    .filter(
                        (
                            item,
                        ): item is {
                            result: PromiseRejectedResult;
                            candidate:
                            (typeof candidatesToUpload)[number];
                        } =>
                            item.result.status ===
                            "rejected" &&
                            item.candidate !== undefined,
                    );

                if (failures.length > 0) {
                    setErrorMessage(
                        failures
                            .map(
                                ({ result, candidate }) =>
                                    `${candidate.name}: ${result.reason instanceof Error
                                        ? result.reason.message
                                        : String(result.reason)
                                    }`,
                            )
                            .join("\n"),
                    );
                }
            } catch (error) {
                setErrorMessage(
                    error instanceof Error
                        ? error.message
                        : String(error),
                );
            } finally {
                setIsUploading(false);
            }
        },
        [
            connectionId,
            listing,
        ],
    );

    async function handleChooseFiles(
        targetDirectoryPath?: string,
    ): Promise<void> {
        setErrorMessage("");
        setContextMenu(null);

        try {
            const selected =
                await openDialog({
                    title:
                        "Select files to upload",

                    multiple: true,
                    directory: false,
                });

            if (!selected) {
                return;
            }

            const localPaths =
                Array.isArray(selected)
                    ? selected
                    : [selected];

            let destinationListing =
                listing;

            if (
                targetDirectoryPath &&
                listing?.path !==
                targetDirectoryPath
            ) {
                const cacheKey =
                    getDirectoryCacheKey(
                        targetDirectoryPath,
                    );

                destinationListing =
                    directoryCacheRef.current.get(
                        cacheKey,
                    ) ?? null;

                if (!destinationListing) {
                    destinationListing =
                        await backendClient.listRemoteDirectory(
                            connectionId,
                            targetDirectoryPath,
                        );

                    directoryCacheRef.current.set(
                        cacheKey,
                        destinationListing,
                    );

                    directoryCacheRef.current.set(
                        getDirectoryCacheKey(
                            destinationListing.path,
                        ),
                        destinationListing,
                    );
                }
            }

            await uploadFiles(
                localPaths,
                destinationListing,
            );
        } catch (error) {
            setErrorMessage(
                error instanceof Error
                    ? error.message
                    : String(error),
            );
        }
    }

    useEffect(() => {
        if (!isActive) {
            setIsDraggingFiles(false);
            return;
        }

        let unlisten:
            | (() => void)
            | undefined;

        let disposed = false;

        void (async () => {
            const webview =
                getCurrentWebview();

            const scaleFactor =
                await getCurrentWindow()
                    .scaleFactor();

            const removeListener =
                await webview.onDragDropEvent(
                    (event) => {
                        const payload = event.payload;

                        if (payload.type === "leave") {
                            setIsDraggingFiles(false);
                            return;
                        }

                        const target =
                            dropTargetRef.current;

                        if (!target) {
                            setIsDraggingFiles(false);
                            return;
                        }

                        /*
                         * Tauri supplies drag positions in physical
                         * pixels. DOM rectangles use logical/CSS pixels.
                         */
                        const logicalX =
                            payload.position.x /
                            scaleFactor;

                        const logicalY =
                            payload.position.y /
                            scaleFactor;

                        const rectangle =
                            target.getBoundingClientRect();

                        const isInsideExplorer =
                            logicalX >= rectangle.left &&
                            logicalX <= rectangle.right &&
                            logicalY >= rectangle.top &&
                            logicalY <= rectangle.bottom;

                        if (
                            payload.type === "enter" ||
                            payload.type === "over"
                        ) {
                            setIsDraggingFiles(
                                isInsideExplorer,
                            );

                            return;
                        }

                        if (payload.type === "drop") {
                            setIsDraggingFiles(false);

                            if (!isInsideExplorer) {
                                return;
                            }

                            void uploadFiles(
                                payload.paths,
                            );
                        }
                    },
                );

            if (disposed) {
                removeListener();
                return;
            }

            unlisten = removeListener;
        })().catch((error: unknown) => {
            setErrorMessage(
                error instanceof Error
                    ? error.message
                    : String(error),
            );
        });

        return () => {
            disposed = true;
            unlisten?.();
        };
    }, [uploadFiles, isActive]);

    const loadDirectory = useCallback(
        async (
            remotePath?: string,
            options: LoadDirectoryOptions = {},
        ): Promise<void> => {
            const requestId =
                latestDirectoryRequestRef.current + 1;

            latestDirectoryRequestRef.current =
                requestId;

            const cacheKey =
                getDirectoryCacheKey(
                    remotePath,
                );

            const cachedListing =
                directoryCacheRef.current.get(
                    cacheKey,
                );

            setErrorMessage("");
            setSelectedPath(null);
            setContextMenu(null);

            /*
             * Return immediately from the session cache.
             * This also invalidates any older request that
             * may still be running.
             */
            if (
                cachedListing &&
                !options.forceRefresh
            ) {
                setListing(
                    cachedListing,
                );

                setPathInput(
                    cachedListing.path,
                );

                setLoading(false);
                return;
            }

            setLoading(true);

            try {
                const result =
                    await backendClient.listRemoteDirectory(
                        connectionId,
                        remotePath,
                    );

                /*
                 * Store the result under both:
                 *
                 * 1. The requested path
                 * 2. The canonical path returned by SFTP
                 *
                 * This is especially useful for the initial
                 * home-directory request where remotePath is
                 * undefined.
                 */
                directoryCacheRef.current.set(
                    cacheKey,
                    result,
                );

                directoryCacheRef.current.set(
                    getDirectoryCacheKey(
                        result.path,
                    ),
                    result,
                );

                /*
                 * Ignore an older response if the user has
                 * already opened another directory.
                 */
                if (
                    requestId !==
                    latestDirectoryRequestRef.current
                ) {
                    return;
                }

                setListing(result);
                setPathInput(result.path);
            } catch (error) {
                if (
                    requestId !==
                    latestDirectoryRequestRef.current
                ) {
                    return;
                }

                setErrorMessage(
                    error instanceof Error
                        ? error.message
                        : String(error),
                );
            } finally {
                if (
                    requestId ===
                    latestDirectoryRequestRef.current
                ) {
                    setLoading(false);
                }
            }
        },
        [connectionId],
    );

    const invalidateCachedDirectory =
        useCallback(
            (
                remoteDirectoryPath: string,
            ): void => {
                const cache =
                    directoryCacheRef.current;

                for (
                    const [
                        cacheKey,
                        cachedListing,
                    ] of cache.entries()
                ) {
                    if (
                        cacheKey ===
                        getDirectoryCacheKey(
                            remoteDirectoryPath,
                        ) ||
                        cachedListing.path ===
                        remoteDirectoryPath
                    ) {
                        cache.delete(
                            cacheKey,
                        );
                    }
                }
            },
            [],
        );

    const invalidateCachedTree =
        useCallback(
            (
                remoteRootPath: string,
            ): void => {
                const normalizedRoot =
                    remoteRootPath === "/"
                        ? "/"
                        : remoteRootPath.replace(
                            /\/+$/u,
                            "",
                        );

                const cache =
                    directoryCacheRef.current;

                for (
                    const [
                        cacheKey,
                        cachedListing,
                    ] of cache.entries()
                ) {
                    const cachedPath =
                        cachedListing.path;

                    const belongsToTree =
                        cachedPath ===
                        normalizedRoot ||
                        cachedPath.startsWith(
                            `${normalizedRoot}/`,
                        );

                    const keyBelongsToTree =
                        cacheKey !==
                        DEFAULT_DIRECTORY_CACHE_KEY &&
                        (
                            cacheKey ===
                            normalizedRoot ||
                            cacheKey.startsWith(
                                `${normalizedRoot}/`,
                            )
                        );

                    if (
                        belongsToTree ||
                        keyBelongsToTree
                    ) {
                        cache.delete(
                            cacheKey,
                        );
                    }
                }
            },
            [],
        );

    useEffect(() => {
        if (!externalFileChange) {
            return;
        }

        const parentPath =
            getRemoteParentDirectory(
                externalFileChange.path,
            );

        invalidateCachedDirectory(
            parentPath,
        );

        if (
            listing?.path ===
            parentPath
        ) {
            void loadDirectory(
                parentPath,
                {
                    forceRefresh: true,
                },
            );
        }
    }, [
        externalFileChange,
        invalidateCachedDirectory,
        listing?.path,
        loadDirectory,
    ]);

    useEffect(() => {
        return backendClient.subscribeToEvents(
            (event) => {
                if (
                    event.type !==
                    "transfer.completed"
                ) {
                    return;
                }

                const transfer =
                    event.payload as
                    TransferEventPayload;

                if (
                    transfer.connectionId !==
                    connectionId ||
                    transfer.direction !==
                    "upload"
                ) {
                    return;
                }

                const uploadedDirectory =
                    getRemoteParentDirectory(
                        transfer.remotePath,
                    );

                directoryCacheRef.current.delete(
                    getDirectoryCacheKey(
                        uploadedDirectory,
                    ),
                );

                if (
                    listing?.path ===
                    uploadedDirectory
                ) {
                    void loadDirectory(
                        uploadedDirectory,
                        {
                            forceRefresh: true,
                        },
                    );
                }
            },
        );
    }, [
        connectionId,
        listing?.path,
        loadDirectory,
    ]);

    async function handleDownload(
        entry: RemoteFileEntry,
    ): Promise<void> {
        if (entry.type !== "file") {
            return;
        }

        setErrorMessage("");

        try {
            const localPath = await save({
                title: `Download ${entry.name}`,
                defaultPath: entry.name,
            });

            // User closed the Save dialog.
            if (!localPath) {
                return;
            }

            await backendClient.downloadRemoteFile(
                connectionId,
                entry.path,
                localPath,
            );
        } catch (error) {
            setErrorMessage(
                error instanceof Error
                    ? error.message
                    : String(error),
            );
        }
    }

    useEffect(() => {
        void loadDirectory();
    }, [loadDirectory]);

    function handlePathSubmit(
        event: FormEvent<HTMLFormElement>,
    ): void {
        event.preventDefault();

        void loadDirectory(pathInput);
    }

    function handleEntryOpen(
        entry: RemoteFileEntry,
    ): void {
        if (
            entry.type ===
            "directory"
        ) {
            void loadDirectory(
                entry.path,
            );

            return;
        }

        if (
            entry.type === "file"
        ) {
            onEditFile(entry);
        }
    }

    function handleContextMenuOpen(
        event:
            ReactMouseEvent<HTMLElement>,
        entry: RemoteFileEntry | null,
    ): void {
        event.preventDefault();
        event.stopPropagation();

        if (
            loading ||
            isMutating ||
            !listing
        ) {
            return;
        }

        const estimatedWidth = 224;

        const estimatedHeight =
            entry
                ? 340
                : 220;

        const margin = 8;

        const x = Math.max(
            margin,
            Math.min(
                event.clientX,
                window.innerWidth -
                estimatedWidth -
                margin,
            ),
        );

        const y = Math.max(
            margin,
            Math.min(
                event.clientY,
                window.innerHeight -
                estimatedHeight -
                margin,
            ),
        );

        setSelectedPath(
            entry?.path ?? null,
        );

        setContextMenu({
            x,
            y,
            entry,
        });
    }

    async function handleCopyRemotePath(
        remotePath: string,
    ): Promise<void> {
        setContextMenu(null);
        setErrorMessage("");

        try {
            await copyTextToClipboard(
                remotePath,
            );

            showToast(
                "Remote path copied",
            );
        } catch (error) {
            setErrorMessage(
                error instanceof Error
                    ? error.message
                    : String(error),
            );
        }
    }

    async function handleShowDetails(
        entry: RemoteFileEntry,
    ): Promise<void> {
        setContextMenu(null);

        setDetailsDialog({
            entry,
            loading: true,
            error: "",
        });

        try {
            const freshEntry =
                await backendClient.statRemotePath(
                    connectionId,
                    entry.path,
                );

            setDetailsDialog({
                entry: freshEntry,
                loading: false,
                error: "",
            });
        } catch (error) {
            setDetailsDialog({
                entry,
                loading: false,

                error:
                    error instanceof Error
                        ? error.message
                        : String(error),
            });
        }
    }

    function handleOpenRenameDialog(
        entry: RemoteFileEntry,
    ): void {
        setContextMenu(null);

        setRenameDialog({
            entry,
            name: entry.name,
            error: "",
        });
    }

    async function handleRenameSubmit(
        event: FormEvent<HTMLFormElement>,
    ): Promise<void> {
        event.preventDefault();

        if (
            !renameDialog ||
            isMutating
        ) {
            return;
        }

        const validationError =
            validateRemoteName(
                renameDialog.name,
            );

        if (validationError) {
            setRenameDialog({
                ...renameDialog,
                error: validationError,
            });

            return;
        }

        const newName =
            renameDialog.name.trim();

        if (
            newName ===
            renameDialog.entry.name
        ) {
            setRenameDialog(null);
            return;
        }

        const parentPath =
            getRemoteParentDirectory(
                renameDialog.entry.path,
            );

        const destinationPath =
            joinRemotePath(
                parentPath,
                newName,
            );

        const alreadyExists =
            listing?.path ===
            parentPath &&
            listing.entries.some(
                (entry) =>
                    entry.name ===
                    newName &&
                    entry.path !==
                    renameDialog.entry.path,
            );

        if (alreadyExists) {
            setRenameDialog({
                ...renameDialog,

                error:
                    `"${newName}" already exists in this directory.`,
            });

            return;
        }

        setIsMutating(true);
        setErrorMessage("");

        try {
            await backendClient.renameRemotePath(
                connectionId,
                renameDialog.entry.path,
                destinationPath,
            );

            invalidateCachedDirectory(
                parentPath,
            );

            invalidateCachedTree(
                renameDialog.entry.path,
            );

            invalidateCachedTree(
                destinationPath,
            );

            setRenameDialog(null);
            setSelectedPath(null);

            if (
                listing?.path ===
                parentPath
            ) {
                await loadDirectory(
                    parentPath,
                    {
                        forceRefresh: true,
                    },
                );
            }

            showToast(
                `Renamed to ${newName}`,
            );
        } catch (error) {
            setRenameDialog((current) =>
                current
                    ? {
                        ...current,

                        error:
                            error instanceof
                                Error
                                ? error.message
                                : String(
                                    error,
                                ),
                    }
                    : null,
            );
        } finally {
            setIsMutating(false);
        }
    }

    async function handleDeleteEntry(
        entry: RemoteFileEntry,
    ): Promise<void> {
        setContextMenu(null);

        const isDirectory =
            entry.type === "directory";

        const confirmed =
            await confirmDialog(
                [
                    isDirectory
                        ? `Delete folder "${entry.name}"?`
                        : `Delete "${entry.name}"?`,

                    "",

                    isDirectory
                        ? "Only empty folders can currently be deleted."
                        : "This action cannot be undone.",

                    "",
                    entry.path,
                ].join("\n"),
                {
                    title:
                        isDirectory
                            ? "Delete remote folder?"
                            : "Delete remote file?",

                    kind: "warning",
                },
            );

        if (!confirmed) {
            return;
        }

        setIsMutating(true);
        setErrorMessage("");

        const parentPath =
            getRemoteParentDirectory(
                entry.path,
            );

        try {
            if (isDirectory) {
                await backendClient.deleteRemoteDirectory(
                    connectionId,
                    entry.path,
                );
            } else {
                await backendClient.deleteRemoteFile(
                    connectionId,
                    entry.path,
                );
            }

            invalidateCachedDirectory(
                parentPath,
            );

            invalidateCachedTree(
                entry.path,
            );

            setSelectedPath(null);

            if (
                listing?.path ===
                parentPath
            ) {
                await loadDirectory(
                    parentPath,
                    {
                        forceRefresh: true,
                    },
                );
            }

            showToast(
                isDirectory
                    ? `Deleted folder ${entry.name}`
                    : `Deleted ${entry.name}`,
            );
        } catch (error) {
            setErrorMessage(
                error instanceof Error
                    ? error.message
                    : String(error),
            );
        } finally {
            setIsMutating(false);
        }
    }

    function handleOpenNewFolderDialog(
        parentPath: string,
    ): void {
        setContextMenu(null);

        setNewFolderDialog({
            parentPath,
            name: "",
            error: "",
        });
    }

    async function handleCreateFolderSubmit(
        event: FormEvent<HTMLFormElement>,
    ): Promise<void> {
        event.preventDefault();

        if (
            !newFolderDialog ||
            isMutating
        ) {
            return;
        }

        const validationError =
            validateRemoteName(
                newFolderDialog.name,
            );

        if (validationError) {
            setNewFolderDialog({
                ...newFolderDialog,
                error: validationError,
            });

            return;
        }

        const folderName =
            newFolderDialog.name.trim();

        const remotePath =
            joinRemotePath(
                newFolderDialog.parentPath,
                folderName,
            );

        const alreadyExists =
            listing?.path ===
            newFolderDialog.parentPath &&
            listing.entries.some(
                (entry) =>
                    entry.name ===
                    folderName,
            );

        if (alreadyExists) {
            setNewFolderDialog({
                ...newFolderDialog,

                error:
                    `"${folderName}" already exists in this directory.`,
            });

            return;
        }

        setIsMutating(true);
        setErrorMessage("");

        try {
            await backendClient.createRemoteDirectory(
                connectionId,
                remotePath,
            );

            invalidateCachedDirectory(
                newFolderDialog.parentPath,
            );

            invalidateCachedTree(
                remotePath,
            );

            const parentPath =
                newFolderDialog.parentPath;

            setNewFolderDialog(null);

            if (
                listing?.path ===
                parentPath
            ) {
                await loadDirectory(
                    parentPath,
                    {
                        forceRefresh: true,
                    },
                );
            }

            showToast(
                `Created folder ${folderName}`,
            );
        } catch (error) {
            setNewFolderDialog(
                (current) =>
                    current
                        ? {
                            ...current,

                            error:
                                error instanceof
                                    Error
                                    ? error.message
                                    : String(
                                        error,
                                    ),
                        }
                        : null,
            );
        } finally {
            setIsMutating(false);
        }
    }

    return (
        <section
            ref={dropTargetRef}
            className={
                isDraggingFiles
                    ? "file-explorer-panel file-explorer-panel--dragging"
                    : "file-explorer-panel"
            }
        >
            {toastMessage && (
                <div className="file-explorer-toast">
                    <CheckCircle size={20} />
                    {toastMessage}
                </div>
            )}

            {isDraggingFiles && (
                <div className="file-drop-overlay">
                    <div className="file-drop-overlay__icon">
                        <Download size={16} />
                    </div>

                    <strong>
                        Upload to {listing?.path ?? "remote directory"}
                    </strong>

                    <span>
                        Release the files to start uploading
                    </span>
                </div>
            )}

            <header className="file-explorer-header">
                <div>
                    <div className="file-explorer-title">
                        Remote files
                    </div>

                    <div className="file-explorer-subtitle">
                        SFTP
                    </div>
                </div>

                <div className="file-explorer-header__actions">
                    <button
                        type="button"
                        className="upload-button"
                        onClick={() =>
                            void handleChooseFiles()
                        }
                        disabled={
                            loading ||
                            isUploading ||
                            !listing
                        }
                    >
                        {isUploading
                            ? "Starting…"
                            : "Upload"}
                    </button>

                    <button
                        type="button"
                        className="icon-button"
                        onClick={() =>
                            void loadDirectory(
                                listing?.path,
                                {
                                    forceRefresh: true,
                                },
                            )
                        }
                        disabled={loading}
                        title="Refresh directory"
                    >
                        <RefreshCcw size={16} />
                    </button>
                </div>
            </header>

            <div className="file-explorer-toolbar">
                <button
                    type="button"
                    className="icon-button"
                    disabled={
                        loading ||
                        !listing?.parentPath
                    }
                    onClick={() => {
                        if (listing?.parentPath) {
                            void loadDirectory(
                                listing.parentPath,
                            );
                        }
                    }}
                    title="Parent directory"
                >
                    <ArrowUp size={16} />
                </button>

                <form
                    className="remote-path-form"
                    onSubmit={handlePathSubmit}
                >
                    <input
                        value={pathInput}
                        onChange={(event) =>
                            setPathInput(
                                event.target.value,
                            )
                        }
                        disabled={loading}
                        spellCheck={false}
                        aria-label="Remote path"
                    />
                </form>
            </div>

            {breadcrumbs.length > 0 && (
                <nav
                    className="breadcrumbs"
                    aria-label="Remote path"
                >
                    {breadcrumbs.map(
                        (breadcrumb, index) => (
                            <span
                                key={breadcrumb.path}
                                className="breadcrumb-item"
                            >
                                {index > 0 && (
                                    <span className="breadcrumb-separator">
                                        /
                                    </span>
                                )}

                                <button
                                    type="button"
                                    onClick={() =>
                                        void loadDirectory(
                                            breadcrumb.path,
                                        )
                                    }
                                    disabled={loading}
                                >
                                    {breadcrumb.label}
                                </button>
                            </span>
                        ),
                    )}
                </nav>
            )}

            {errorMessage && (
                <div className="file-explorer-error">
                    {errorMessage}
                </div>
            )}

            <div
                className="file-list-container"
                onContextMenu={(event) =>
                    handleContextMenuOpen(
                        event,
                        null,
                    )
                }
            >
                {loading ? (
                    <div className="file-explorer-empty">
                        <Loader className="loader" />
                        Loading directory…
                    </div>
                ) : listing &&
                    listing.entries.length > 0 ? (
                    <table className="file-list">
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th>Size</th>
                                <th>Modified</th>
                                <th>Mode</th>
                                <th aria-label="Actions" />
                            </tr>
                        </thead>

                        <tbody>
                            {listing.entries.map(
                                (entry) => (
                                    <tr
                                        key={entry.path}
                                        className={
                                            selectedPath ===
                                                entry.path
                                                ? "file-row file-row--selected"
                                                : "file-row"
                                        }
                                        onClick={() =>
                                            setSelectedPath(
                                                entry.path,
                                            )
                                        }
                                        onDoubleClick={() =>
                                            handleEntryOpen(entry)
                                        }
                                        onContextMenu={(event) =>
                                            handleContextMenuOpen(
                                                event,
                                                entry,
                                            )
                                        }
                                    >
                                        <td>
                                            <button
                                                type="button"
                                                className="file-name-button"
                                                onDoubleClick={() =>
                                                    handleEntryOpen(
                                                        entry,
                                                    )
                                                }
                                            >
                                                <span
                                                    className="file-icon"
                                                    aria-hidden="true"
                                                >
                                                    {getFileIcon(
                                                        entry,
                                                    )}
                                                </span>

                                                <span className="file-name">
                                                    {entry.name}
                                                </span>
                                            </button>
                                        </td>

                                        <td>
                                            {entry.type ===
                                                "directory"
                                                ? "—"
                                                : formatFileSize(
                                                    entry.size,
                                                )}
                                        </td>

                                        <td>
                                            {formatModifiedTime(
                                                entry.modifiedAt,
                                            )}
                                        </td>

                                        <td>
                                            {entry.permissions ??
                                                "—"}
                                        </td>

                                        <td className="file-actions-cell">
                                            {entry.type === "file" && (
                                                <Download
                                                    size={16}
                                                    className="file-download-button"
                                                    onClick={(event) => {
                                                        event.stopPropagation();

                                                        void handleDownload(entry);
                                                    }}
                                                />
                                            )}
                                        </td>
                                    </tr>
                                ),
                            )}
                        </tbody>
                    </table>
                ) : (
                    <div className="file-explorer-empty">
                        This directory is empty.
                    </div>
                )}
            </div>

            <footer className="file-explorer-footer">
                <span>
                    {listing
                        ? `${listing.entries.length} items`
                        : "No directory loaded"}
                </span>

                {selectedPath && (
                    <span
                        className="selected-file-path"
                        title={selectedPath}
                    >
                        {selectedPath}
                    </span>
                )}
            </footer>

            {contextMenu && (
                <div
                    className="remote-context-menu"
                    style={{
                        left: contextMenu.x,
                        top: contextMenu.y,
                    }}
                    role="menu"
                    aria-label="Remote file actions"
                >
                    {contextMenu.entry ? (
                        <>
                            {contextMenu.entry.type ===
                                "directory" && (
                                    <>
                                        <button
                                            type="button"
                                            className="remote-context-menu__item"
                                            onClick={() => {
                                                const entry =
                                                    contextMenu.entry;

                                                setContextMenu(
                                                    null,
                                                );

                                                handleEntryOpen(
                                                    entry!,
                                                );
                                            }}
                                        >
                                            <FolderOpen size={15} />
                                            Open
                                        </button>

                                        <button
                                            type="button"
                                            className="remote-context-menu__item"
                                            onClick={() =>
                                                void handleChooseFiles(
                                                    contextMenu
                                                        .entry
                                                        ?.path,
                                                )
                                            }
                                        >
                                            <Upload size={15} />
                                            Upload Here
                                        </button>

                                        <button
                                            type="button"
                                            className="remote-context-menu__item"
                                            onClick={() =>
                                                handleOpenNewFolderDialog(
                                                    contextMenu
                                                        .entry
                                                        ?.path ??
                                                    listing?.path ??
                                                    "/",
                                                )
                                            }
                                        >
                                            <FolderPlus size={15} />
                                            New Folder
                                        </button>
                                    </>
                                )}

                            {contextMenu.entry.type ===
                                "file" && (
                                    <>
                                        <button
                                            type="button"
                                            className="remote-context-menu__item"
                                            onClick={() => {
                                                const entry =
                                                    contextMenu.entry;

                                                setContextMenu(null);

                                                onEditFile(entry!);
                                            }}
                                        >
                                            <FileText size={15} />
                                            Edit
                                        </button>

                                        <button
                                            type="button"
                                            className="remote-context-menu__item"
                                            onClick={() => {
                                                const entry =
                                                    contextMenu.entry;

                                                setContextMenu(
                                                    null,
                                                );

                                                void handleDownload(
                                                    entry!,
                                                );
                                            }}
                                        >
                                            <Download size={15} />
                                            Download
                                        </button>
                                    </>
                                )}

                            <div className="remote-context-menu__separator" />

                            <button
                                type="button"
                                className="remote-context-menu__item"
                                onClick={() =>
                                    handleOpenRenameDialog(
                                        contextMenu.entry!,
                                    )
                                }
                            >
                                <Pencil size={15} />
                                Rename
                            </button>

                            <button
                                type="button"
                                className="remote-context-menu__item remote-context-menu__item--danger"
                                onClick={() =>
                                    void handleDeleteEntry(
                                        contextMenu.entry!,
                                    )
                                }
                            >
                                <Trash2 size={15} />
                                Delete
                            </button>

                            <div className="remote-context-menu__separator" />

                            <button
                                type="button"
                                className="remote-context-menu__item"
                                onClick={() =>
                                    void handleCopyRemotePath(
                                        contextMenu
                                            .entry
                                            ?.path ??
                                        "",
                                    )
                                }
                            >
                                <Copy size={15} />
                                Copy Remote Path
                            </button>

                            <button
                                type="button"
                                className="remote-context-menu__item"
                                onClick={() =>
                                    void handleShowDetails(
                                        contextMenu.entry!,
                                    )
                                }
                            >
                                <Info size={15} />
                                Details
                            </button>
                        </>
                    ) : (
                        <>
                            <button
                                type="button"
                                className="remote-context-menu__item"
                                onClick={() =>
                                    void handleChooseFiles()
                                }
                            >
                                <Upload size={15} />
                                Upload Files
                            </button>

                            <button
                                type="button"
                                className="remote-context-menu__item"
                                onClick={() =>
                                    handleOpenNewFolderDialog(
                                        listing?.path ??
                                        "/",
                                    )
                                }
                            >
                                <FolderPlus size={15} />
                                New Folder
                            </button>

                            <button
                                type="button"
                                className="remote-context-menu__item"
                                onClick={() => {
                                    setContextMenu(null);

                                    void loadDirectory(
                                        listing?.path,
                                        {
                                            forceRefresh:
                                                true,
                                        },
                                    );
                                }}
                            >
                                <RefreshCcw size={15} />
                                Refresh
                            </button>

                            <div className="remote-context-menu__separator" />

                            <button
                                type="button"
                                className="remote-context-menu__item"
                                onClick={() =>
                                    void handleCopyRemotePath(
                                        listing?.path ??
                                        "",
                                    )
                                }
                            >
                                <Copy size={15} />
                                Copy Current Path
                            </button>
                        </>
                    )}
                </div>
            )}

            {detailsDialog && (
                <div
                    className="remote-dialog-backdrop"
                    onMouseDown={(event) => {
                        if (
                            event.target ===
                            event.currentTarget
                        ) {
                            setDetailsDialog(null);
                        }
                    }}
                >
                    <section
                        className="remote-dialog"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="remote-details-title"
                    >
                        <header className="remote-dialog__header">
                            <div>
                                <h2 id="remote-details-title">
                                    Details
                                </h2>

                                <p>
                                    {detailsDialog.entry.name}
                                </p>
                            </div>

                            <button
                                type="button"
                                className="remote-dialog__close"
                                onClick={() =>
                                    setDetailsDialog(null)
                                }
                                aria-label="Close details"
                            >
                                <X size={17} />
                            </button>
                        </header>

                        <div className="remote-dialog__body">
                            {detailsDialog.loading ? (
                                <div className="remote-dialog__loading">
                                    <Loader className="loader" />
                                    Loading fresh details…
                                </div>
                            ) : (
                                <>
                                    {detailsDialog.error && (
                                        <div className="remote-dialog__error">
                                            {detailsDialog.error}
                                        </div>
                                    )}

                                    <dl className="remote-details-grid">
                                        <dt>Name</dt>
                                        <dd>
                                            {detailsDialog.entry.name}
                                        </dd>

                                        <dt>Type</dt>
                                        <dd>
                                            {getRemoteEntryTypeLabel(
                                                detailsDialog
                                                    .entry
                                                    .type,
                                            )}
                                        </dd>

                                        <dt>Remote path</dt>
                                        <dd className="remote-details-path">
                                            {detailsDialog.entry.path}
                                        </dd>

                                        <dt>Size</dt>
                                        <dd>
                                            {formatFileSize(
                                                detailsDialog
                                                    .entry
                                                    .size,
                                            )}
                                            {" · "}
                                            {detailsDialog.entry.size.toLocaleString()}
                                            {" bytes"}
                                        </dd>

                                        <dt>Modified</dt>
                                        <dd>
                                            {formatModifiedTime(
                                                detailsDialog
                                                    .entry
                                                    .modifiedAt,
                                            )}
                                        </dd>

                                        <dt>Permissions</dt>
                                        <dd>
                                            {detailsDialog.entry.permissions ??
                                                "—"}
                                        </dd>

                                        <dt>Owner UID</dt>
                                        <dd>
                                            {detailsDialog.entry.uid ??
                                                "—"}
                                        </dd>

                                        <dt>Group GID</dt>
                                        <dd>
                                            {detailsDialog.entry.gid ??
                                                "—"}
                                        </dd>
                                    </dl>
                                </>
                            )}
                        </div>
                    </section>
                </div>
            )}

            {renameDialog && (
                <div className="remote-dialog-backdrop">
                    <form
                        className="remote-dialog remote-dialog--small"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="remote-rename-title"
                        onSubmit={(event) =>
                            void handleRenameSubmit(
                                event,
                            )
                        }
                    >
                        <header className="remote-dialog__header">
                            <div>
                                <h2 id="remote-rename-title">
                                    Rename
                                </h2>

                                <p>
                                    {renameDialog.entry.path}
                                </p>
                            </div>

                            <button
                                type="button"
                                className="remote-dialog__close"
                                disabled={isMutating}
                                onClick={() =>
                                    setRenameDialog(null)
                                }
                                aria-label="Close rename dialog"
                            >
                                <X size={17} />
                            </button>
                        </header>

                        <div className="remote-dialog__body">
                            <label>
                                <span>New name</span>

                                <input
                                    autoFocus
                                    value={renameDialog.name}
                                    disabled={isMutating}
                                    onChange={(event) =>
                                        setRenameDialog({
                                            ...renameDialog,

                                            name:
                                                event.target
                                                    .value,

                                            error: "",
                                        })
                                    }
                                />
                            </label>

                            {renameDialog.error && (
                                <div className="remote-dialog__error">
                                    {renameDialog.error}
                                </div>
                            )}
                        </div>

                        <footer className="remote-dialog__actions">
                            <button
                                type="button"
                                className="secondary-button"
                                disabled={isMutating}
                                onClick={() =>
                                    setRenameDialog(null)
                                }
                            >
                                Cancel
                            </button>

                            <button
                                type="submit"
                                disabled={isMutating}
                            >
                                {isMutating
                                    ? "Renaming…"
                                    : "Rename"}
                            </button>
                        </footer>
                    </form>
                </div>
            )}

            {newFolderDialog && (
                <div className="remote-dialog-backdrop">
                    <form
                        className="remote-dialog remote-dialog--small"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="remote-new-folder-title"
                        onSubmit={(event) =>
                            void handleCreateFolderSubmit(
                                event,
                            )
                        }
                    >
                        <header className="remote-dialog__header">
                            <div>
                                <h2 id="remote-new-folder-title">
                                    New Folder
                                </h2>

                                <p>
                                    Inside{" "}
                                    {newFolderDialog.parentPath}
                                </p>
                            </div>

                            <button
                                type="button"
                                className="remote-dialog__close"
                                disabled={isMutating}
                                onClick={() =>
                                    setNewFolderDialog(null)
                                }
                                aria-label="Close new-folder dialog"
                            >
                                <X size={17} />
                            </button>
                        </header>

                        <div className="remote-dialog__body">
                            <label>
                                <span>Folder name</span>

                                <input
                                    autoFocus
                                    value={
                                        newFolderDialog.name
                                    }
                                    disabled={isMutating}
                                    placeholder="new-folder"
                                    onChange={(event) =>
                                        setNewFolderDialog({
                                            ...newFolderDialog,

                                            name:
                                                event.target
                                                    .value,

                                            error: "",
                                        })
                                    }
                                />
                            </label>

                            {newFolderDialog.error && (
                                <div className="remote-dialog__error">
                                    {newFolderDialog.error}
                                </div>
                            )}
                        </div>

                        <footer className="remote-dialog__actions">
                            <button
                                type="button"
                                className="secondary-button"
                                disabled={isMutating}
                                onClick={() =>
                                    setNewFolderDialog(null)
                                }
                            >
                                Cancel
                            </button>

                            <button
                                type="submit"
                                disabled={isMutating}
                            >
                                {isMutating
                                    ? "Creating…"
                                    : "Create Folder"}
                            </button>
                        </footer>
                    </form>
                </div>
            )}
        </section>
    );
}
