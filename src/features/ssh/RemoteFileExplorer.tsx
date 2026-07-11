import {
    useCallback,
    useEffect,
    useMemo,
    useState,
    useRef,
    type FormEvent,
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
import { ArrowUp, Download, Loader, RefreshCcw } from "lucide-react";

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
}

interface Breadcrumb {
    label: string;
    path: string;
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

    const breadcrumbs = useMemo(
        () =>
            listing
                ? buildBreadcrumbs(listing.path)
                : [],
        [listing],
    );

    const dropTargetRef =
        useRef<HTMLElement | null>(null);

    const [isDraggingFiles, setIsDraggingFiles] =
        useState(false);

    const [isUploading, setIsUploading] =
        useState(false);

    const uploadFiles = useCallback(
        async (
            localPaths: string[],
        ): Promise<void> => {
            if (!listing) {
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
                            listing.entries.find(
                                (entry) =>
                                    entry.name === name,
                            );

                        return {
                            localPath,
                            name,
                            existingEntry,
                            remotePath: joinRemotePath(
                                listing.path,
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

    async function handleChooseFiles(): Promise<void> {
        setErrorMessage("");

        try {
            const selected = await openDialog({
                title: "Select files to upload",
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

            await uploadFiles(localPaths);
        } catch (error) {
            setErrorMessage(
                error instanceof Error
                    ? error.message
                    : String(error),
            );
        }
    }

    useEffect(() => {
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
    }, [uploadFiles]);

    const loadDirectory = useCallback(
        async (remotePath?: string): Promise<void> => {
            setLoading(true);
            setErrorMessage("");
            setSelectedPath(null);

            try {
                const result =
                    await backendClient.listRemoteDirectory(
                        connectionId,
                        remotePath,
                    );

                setListing(result);
                setPathInput(result.path);
            } catch (error) {
                setErrorMessage(
                    error instanceof Error
                        ? error.message
                        : String(error),
                );
            } finally {
                setLoading(false);
            }
        },
        [connectionId],
    );

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
                    event.payload as TransferEventPayload;

                if (
                    transfer.connectionId !==
                    connectionId ||
                    transfer.direction !== "upload"
                ) {
                    return;
                }

                void loadDirectory(
                    listing?.path,
                );
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
        if (entry.type !== "directory") {
            return;
        }

        void loadDirectory(entry.path);
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

            <div className="file-list-container">
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
        </section>
    );
}
