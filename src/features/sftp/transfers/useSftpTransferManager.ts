import {
    useCallback,
    useEffect,
    useRef,
    useState,
} from "react";

import {
    exists,
    lstat,
    mkdir,
    open,
    readDir,
    remove,
    rename,
} from "@tauri-apps/plugin-fs";

import {
    join,
} from "@tauri-apps/api/path";

import {
    backendClient,
    type TransferEventPayload,
} from "../../../backend/backend-client";

import type {
    PendingSftpConflict,
    PrepareSftpTransferInput,
    PreparedSftpTransfer,
    SftpConflictDecision,
    SftpTransferEntryType,
    UseSftpTransferManagerOptions,
} from "./sftp-transfer-types";

import {
    joinRemotePath,
    prepareSftpTransfer,
} from "./transfer-path-utils";

const MAX_TRANSFERS = 8;
const LOCAL_COPY_CHUNK_SIZE = 1024 * 1024;
const PROGRESS_UPDATE_INTERVAL_MS = 90;

const BACKEND_TRANSFER_EVENT_TYPES =
    new Set([
        "transfer.started",
        "transfer.progress",
        "transfer.completed",
        "transfer.failed",
        "transfer.cancelled",
    ]);

type ConflictMode =
    | "ask"
    | "replace-all"
    | "skip-all";

interface BackendTransferWaiter {
    promise: Promise<TransferEventPayload>;
    dispose: () => void;
}

interface LocalTransferControl {
    cancelled: boolean;
}

interface ProgressSample {
    timestamp: number;
    transferredBytes: number;
    bytesPerSecond: number;
}

interface TransferManifestItem {
    type: "file" | "directory";
    sourcePath: string;
    relativePath: string;
    name: string;
    size: number;
}

interface TransferManifestResult {
    items: TransferManifestItem[];
    skippedSymlinkCount: number;
    scanErrors: string[];
}

interface DestinationPathInfo {
    type: SftpTransferEntryType;
}

interface ConflictWaiter {
    conflict: PendingSftpConflict;
    resolve: (
        decision: SftpConflictDecision,
    ) => void;
}

class TransferCancelledError extends Error {
    constructor(
        message = "The transfer was cancelled.",
    ) {
        super(message);
        this.name = "TransferCancelledError";
    }
}

function getErrorMessage(
    error: unknown,
): string {
    return error instanceof Error
        ? error.message
        : String(error);
}

function clampProgressPercent(
    transferredBytes: number,
    totalBytes: number,
): number {
    if (totalBytes <= 0) {
        return 0;
    }

    return Math.min(
        100,
        Math.max(
            0,
            (
                transferredBytes /
                totalBytes
            ) * 100,
        ),
    );
}

function normalizeRelativePath(
    value: string,
): string {
    return value
        .replace(/\\/gu, "/")
        .replace(/^\/+|\/+$/gu, "");
}

function relativePathIsInside(
    candidate: string,
    parent: string,
): boolean {
    const normalizedCandidate =
        normalizeRelativePath(candidate);
    const normalizedParent =
        normalizeRelativePath(parent);

    return (
        normalizedCandidate ===
        normalizedParent ||
        normalizedCandidate.startsWith(
            `${normalizedParent}/`,
        )
    );
}

function getNameFromRelativePath(
    relativePath: string,
): string {
    const segments =
        normalizeRelativePath(
            relativePath,
        ).split("/");

    return segments.at(-1) ?? relativePath;
}

function isRemoteMissingError(
    error: unknown,
): boolean {
    return /no such file|not found|does not exist|enoent/iu.test(
        getErrorMessage(error),
    );
}

function isConnectionUnavailableError(
    error: unknown,
): boolean {
    return /connection.*(?:closed|missing|not found|not active|unavailable)|not connected|channel.*closed|econnreset|socket.*closed/iu.test(
        getErrorMessage(error),
    );
}

function withoutBackendTransferId(
    transfer: PreparedSftpTransfer,
): PreparedSftpTransfer {
    const nextTransfer = {
        ...transfer,
    };

    delete nextTransfer.backendTransferId;

    return nextTransfer;
}

function typeFromLocalInfo(
    info: Awaited<ReturnType<typeof lstat>>,
): SftpTransferEntryType {
    if (info.isSymlink) {
        return "symlink";
    }

    if (info.isDirectory) {
        return "directory";
    }

    if (info.isFile) {
        return "file";
    }

    return "other";
}

async function joinLocalRelativePath(
    directoryPath: string,
    relativePath: string,
): Promise<string> {
    const segments =
        normalizeRelativePath(
            relativePath,
        )
            .split("/")
            .filter(Boolean);

    return join(
        directoryPath,
        ...segments,
    );
}

function joinRemoteRelativePath(
    directoryPath: string,
    relativePath: string,
): string {
    return normalizeRelativePath(
        relativePath,
    )
        .split("/")
        .filter(Boolean)
        .reduce(
            (
                currentPath,
                segment,
            ) =>
                joinRemotePath(
                    currentPath,
                    segment,
                ),
            directoryPath,
        );
}

export function useSftpTransferManager(
    options: UseSftpTransferManagerOptions = {},
) {
    const [preparedTransfers, setPreparedTransfers] =
        useState<PreparedSftpTransfer[]>([]);

    const [pendingConflict, setPendingConflict] =
        useState<PendingSftpConflict | null>(
            null,
        );

    const transfersRef =
        useRef<PreparedSftpTransfer[]>([]);

    const onTransferCompletedRef =
        useRef(
            options.onTransferCompleted,
        );

    const activeWaiterDisposersRef =
        useRef<Set<() => void>>(
            new Set(),
        );

    const localTransferControlsRef =
        useRef<
            Map<
                string,
                LocalTransferControl
            >
        >(
            new Map(),
        );

    const progressSamplesRef =
        useRef<
            Map<
                string,
                ProgressSample
            >
        >(
            new Map(),
        );

    const cancelRequestedTransferIdsRef =
        useRef<Set<string>>(
            new Set(),
        );

    const conflictModesRef =
        useRef<Map<string, ConflictMode>>(
            new Map(),
        );

    const activeConflictWaiterRef =
        useRef<ConflictWaiter | null>(
            null,
        );

    const conflictQueueRef =
        useRef<ConflictWaiter[]>([]);

    useEffect(() => {
        onTransferCompletedRef.current =
            options.onTransferCompleted;
    }, [options.onTransferCompleted]);

    const displayNextConflict =
        useCallback((): void => {
            if (
                activeConflictWaiterRef.current
            ) {
                return;
            }

            const nextWaiter = conflictQueueRef.current.shift();

            if (!nextWaiter) {
                setPendingConflict(null);
                return;
            }

            activeConflictWaiterRef.current = nextWaiter;

            setPendingConflict(
                nextWaiter.conflict,
            );
        }, []);

    const requestConflict =
        useCallback(
            (
                conflict:
                    PendingSftpConflict,
            ): Promise<SftpConflictDecision> => {
                return new Promise(
                    (resolve) => {
                        const waiter:
                            ConflictWaiter = {
                            conflict,
                            resolve,
                        };

                        if (
                            activeConflictWaiterRef
                                .current
                        ) {
                            conflictQueueRef.current.push(
                                waiter,
                            );
                            return;
                        }

                        activeConflictWaiterRef.current =
                            waiter;
                        setPendingConflict(
                            conflict,
                        );
                    },
                );
            },
            [],
        );

    const resolveConflict =
        useCallback(
            (
                decision:
                    SftpConflictDecision,
            ): void => {
                const waiter =
                    activeConflictWaiterRef.current;

                if (!waiter) {
                    return;
                }

                activeConflictWaiterRef.current = null;
                setPendingConflict(null);
                waiter.resolve(decision);

                queueMicrotask(
                    displayNextConflict,
                );
            },
            [displayNextConflict],
        );

    useEffect(() => {
        return () => {
            for (
                const dispose of
                activeWaiterDisposersRef.current
            ) {
                dispose();
            }

            activeWaiterDisposersRef.current.clear();

            for (
                const control of
                localTransferControlsRef.current
                    .values()
            ) {
                control.cancelled = true;
            }

            localTransferControlsRef.current.clear();
            progressSamplesRef.current.clear();
            cancelRequestedTransferIdsRef.current.clear();
            conflictModesRef.current.clear();

            activeConflictWaiterRef.current
                ?.resolve("cancel");

            activeConflictWaiterRef.current =
                null;

            for (
                const waiter of
                conflictQueueRef.current
            ) {
                waiter.resolve("cancel");
            }

            conflictQueueRef.current = [];
        };
    }, []);

    const updateTransfers =
        useCallback(
            (
                updater: (
                    currentTransfers:
                        PreparedSftpTransfer[],
                ) => PreparedSftpTransfer[],
            ): void => {
                setPreparedTransfers(
                    (currentTransfers) => {
                        const nextTransfers =
                            updater(
                                currentTransfers,
                            );

                        transfersRef.current =
                            nextTransfers;

                        return nextTransfers;
                    },
                );
            },
            [],
        );

    const replaceTransfer =
        useCallback(
            (
                nextTransfer:
                    PreparedSftpTransfer,
            ): void => {
                updateTransfers(
                    (currentTransfers) =>
                        currentTransfers.map(
                            (transfer) =>
                                transfer.id ===
                                    nextTransfer.id
                                    ? nextTransfer
                                    : transfer,
                        ),
                );
            },
            [updateTransfers],
        );

    const updateTransfer =
        useCallback(
            (
                transferId: string,
                updater: (
                    transfer:
                        PreparedSftpTransfer,
                ) => PreparedSftpTransfer,
            ): void => {
                updateTransfers(
                    (currentTransfers) =>
                        currentTransfers.map(
                            (transfer) =>
                                transfer.id ===
                                    transferId
                                    ? updater(
                                        transfer,
                                    )
                                    : transfer,
                        ),
                );
            },
            [updateTransfers],
        );

    const updateTransferProgress =
        useCallback(
            (
                transferId: string,
                transferredBytesValue: number,
                totalBytesValue: number,
                message: string,
            ): void => {
                const now = Date.now();

                updateTransfer(
                    transferId,
                    (transfer) => {
                        const transferredBytes =
                            Math.max(
                                transfer.transferredBytes,
                                Math.max(
                                    0,
                                    transferredBytesValue,
                                ),
                            );

                        const totalBytes =
                            Math.max(
                                transferredBytes,
                                Math.max(
                                    0,
                                    totalBytesValue,
                                ),
                            );

                        const previousSample =
                            progressSamplesRef.current
                                .get(
                                    transferId,
                                );

                        let bytesPerSecond =
                            transfer.bytesPerSecond;

                        if (previousSample) {
                            const elapsedSeconds =
                                Math.max(
                                    (
                                        now -
                                        previousSample.timestamp
                                    ) /
                                    1000,
                                    0.001,
                                );

                            const byteDifference =
                                Math.max(
                                    0,
                                    transferredBytes -
                                    previousSample.transferredBytes,
                                );

                            const currentSpeed =
                                byteDifference /
                                elapsedSeconds;

                            bytesPerSecond =
                                previousSample.bytesPerSecond >
                                    0
                                    ? (
                                        previousSample.bytesPerSecond *
                                        0.7
                                    ) +
                                    (
                                        currentSpeed *
                                        0.3
                                    )
                                    : currentSpeed;
                        } else if (
                            transfer.startedAt
                        ) {
                            const elapsedSeconds =
                                Math.max(
                                    (
                                        now -
                                        transfer.startedAt
                                    ) /
                                    1000,
                                    0.001,
                                );

                            bytesPerSecond =
                                transferredBytes /
                                elapsedSeconds;
                        }

                        progressSamplesRef.current.set(
                            transferId,
                            {
                                timestamp: now,
                                transferredBytes,
                                bytesPerSecond,
                            },
                        );

                        return {
                            ...transfer,
                            status:
                                transfer.status ===
                                    "cancelling"
                                    ? "cancelling"
                                    : transfer.status ===
                                        "waiting-for-conflict"
                                        ? "waiting-for-conflict"
                                        : "running",
                            transferredBytes,
                            totalBytes,
                            progressPercent:
                                clampProgressPercent(
                                    transferredBytes,
                                    totalBytes,
                                ),
                            bytesPerSecond,
                            message,
                        };
                    },
                );
            },
            [updateTransfer],
        );

    const reduceTransferTotalBytes =
        useCallback(
            (
                transferId: string,
                byteCount: number,
            ): void => {
                if (byteCount <= 0) {
                    return;
                }

                updateTransfer(
                    transferId,
                    (transfer) => {
                        const totalBytes =
                            Math.max(
                                transfer.transferredBytes,
                                transfer.totalBytes -
                                byteCount,
                            );

                        return {
                            ...transfer,
                            totalBytes,
                            progressPercent:
                                totalBytes > 0
                                    ? clampProgressPercent(
                                        transfer.transferredBytes,
                                        totalBytes,
                                    )
                                    : 100,
                        };
                    },
                );
            },
            [updateTransfer],
        );

    const createBackendTransferWaiter =
        useCallback(
            (
                localTransferId: string,
                backendTransferId: string,
                baseTransferredBytes: number,
                aggregateTotalBytes: number,
                direction:
                    "upload" |
                    "download",
            ): BackendTransferWaiter => {
                let settled = false;
                let unsubscribe:
                    | (() => void)
                    | null = null;

                const dispose = (): void => {
                    if (!unsubscribe) {
                        return;
                    }

                    const currentUnsubscribe =
                        unsubscribe;

                    unsubscribe = null;
                    currentUnsubscribe();
                    activeWaiterDisposersRef
                        .current.delete(
                            dispose,
                        );
                };

                const promise =
                    new Promise<TransferEventPayload>(
                        (resolve, reject) => {
                            unsubscribe =
                                backendClient.subscribeToEvents(
                                    (event) => {
                                        if (
                                            !BACKEND_TRANSFER_EVENT_TYPES.has(
                                                event.type,
                                            )
                                        ) {
                                            return;
                                        }

                                        const payload =
                                            event.payload as
                                            TransferEventPayload;

                                        if (
                                            payload.transferId !==
                                            backendTransferId
                                        ) {
                                            return;
                                        }

                                        if (
                                            event.type ===
                                            "transfer.started" ||
                                            event.type ===
                                            "transfer.progress"
                                        ) {
                                            updateTransferProgress(
                                                localTransferId,
                                                baseTransferredBytes +
                                                payload.transferredBytes,
                                                aggregateTotalBytes,
                                                direction ===
                                                    "upload"
                                                    ? "Uploading folder contents…"
                                                    : "Downloading folder contents…",
                                            );
                                            return;
                                        }

                                        if (settled) {
                                            return;
                                        }

                                        settled = true;
                                        dispose();

                                        if (
                                            event.type ===
                                            "transfer.completed"
                                        ) {
                                            updateTransferProgress(
                                                localTransferId,
                                                baseTransferredBytes +
                                                payload.totalBytes,
                                                aggregateTotalBytes,
                                                "Finalizing file…",
                                            );
                                            resolve(payload);
                                            return;
                                        }

                                        if (
                                            event.type ===
                                            "transfer.cancelled"
                                        ) {
                                            reject(
                                                new TransferCancelledError(
                                                    payload.message ??
                                                    "The transfer was cancelled.",
                                                ),
                                            );
                                            return;
                                        }

                                        reject(
                                            new Error(
                                                payload.message ??
                                                "The transfer failed.",
                                            ),
                                        );
                                    },
                                );

                            activeWaiterDisposersRef
                                .current.add(
                                    dispose,
                                );
                        },
                    );

                return {
                    promise,
                    dispose,
                };
            },
            [updateTransferProgress],
        );

    const checkCancelled =
        useCallback(
            (
                transferId: string,
            ): void => {
                if (
                    cancelRequestedTransferIdsRef.current.has(
                        transferId,
                    )
                ) {
                    throw new TransferCancelledError();
                }
            },
            [],
        );

    const scanLocalPath =
        useCallback(
            async (
                transferId: string,
                sourcePath: string,
                relativePath: string,
                result: TransferManifestResult,
            ): Promise<void> => {
                checkCancelled(
                    transferId,
                );

                let info:
                    Awaited<ReturnType<typeof lstat>>;

                try {
                    info = await lstat(
                        sourcePath,
                    );
                } catch (error) {
                    result.scanErrors.push(
                        `${sourcePath}: ${getErrorMessage(error)}`,
                    );
                    return;
                }

                if (info.isSymlink) {
                    result.skippedSymlinkCount +=
                        1;
                    return;
                }

                if (info.isFile) {
                    result.items.push({
                        type: "file",
                        sourcePath,
                        relativePath,
                        name:
                            getNameFromRelativePath(
                                relativePath,
                            ),
                        size:
                            Math.max(
                                0,
                                info.size,
                            ),
                    });
                    return;
                }

                if (!info.isDirectory) {
                    result.scanErrors.push(
                        `${sourcePath}: unsupported filesystem entry type.`,
                    );
                    return;
                }

                result.items.push({
                    type: "directory",
                    sourcePath,
                    relativePath,
                    name:
                        getNameFromRelativePath(
                            relativePath,
                        ),
                    size: 0,
                });

                let children:
                    Awaited<ReturnType<typeof readDir>>;

                try {
                    children = await readDir(
                        sourcePath,
                    );
                } catch (error) {
                    result.scanErrors.push(
                        `${sourcePath}: ${getErrorMessage(error)}`,
                    );
                    return;
                }

                children.sort(
                    (left, right) =>
                        left.name.localeCompare(
                            right.name,
                        ),
                );

                for (const child of children) {
                    const childSourcePath =
                        await join(
                            sourcePath,
                            child.name,
                        );

                    const childRelativePath =
                        `${normalizeRelativePath(relativePath)}/${child.name}`;

                    await scanLocalPath(
                        transferId,
                        childSourcePath,
                        childRelativePath,
                        result,
                    );
                }
            },
            [checkCancelled],
        );

    const scanRemotePath =
        useCallback(
            async (
                transferId: string,
                connectionId: string,
                sourcePath: string,
                relativePath: string,
                sourceType:
                    SftpTransferEntryType,
                sourceSize: number,
                result: TransferManifestResult,
            ): Promise<void> => {
                checkCancelled(
                    transferId,
                );

                if (sourceType === "symlink") {
                    result.skippedSymlinkCount +=
                        1;
                    return;
                }

                if (sourceType === "file") {
                    result.items.push({
                        type: "file",
                        sourcePath,
                        relativePath,
                        name:
                            getNameFromRelativePath(
                                relativePath,
                            ),
                        size:
                            Math.max(
                                0,
                                sourceSize,
                            ),
                    });
                    return;
                }

                if (sourceType !== "directory") {
                    result.scanErrors.push(
                        `${sourcePath}: unsupported remote entry type.`,
                    );
                    return;
                }

                result.items.push({
                    type: "directory",
                    sourcePath,
                    relativePath,
                    name:
                        getNameFromRelativePath(
                            relativePath,
                        ),
                    size: 0,
                });

                let listing:
                    Awaited<ReturnType<
                        typeof backendClient.listRemoteDirectory
                    >>;

                try {
                    listing =
                        await backendClient.listRemoteDirectory(
                            connectionId,
                            sourcePath,
                        );
                } catch (error) {
                    if (
                        isConnectionUnavailableError(
                            error,
                        )
                    ) {
                        throw error;
                    }

                    result.scanErrors.push(
                        `${sourcePath}: ${getErrorMessage(error)}`,
                    );
                    return;
                }

                for (const child of listing.entries) {
                    await scanRemotePath(
                        transferId,
                        connectionId,
                        child.path,
                        `${normalizeRelativePath(relativePath)}/${child.name}`,
                        child.type,
                        child.size,
                        result,
                    );
                }
            },
            [checkCancelled],
        );

    const buildManifest =
        useCallback(
            async (
                transfer:
                    PreparedSftpTransfer,
            ): Promise<TransferManifestResult> => {
                const result:
                    TransferManifestResult = {
                    items: [],
                    skippedSymlinkCount: 0,
                    scanErrors: [],
                };

                for (const entry of transfer.entries) {
                    checkCancelled(
                        transfer.id,
                    );

                    if (
                        transfer.source.source.type ===
                        "local"
                    ) {
                        await scanLocalPath(
                            transfer.id,
                            entry.path,
                            entry.name,
                            result,
                        );
                    } else {
                        await scanRemotePath(
                            transfer.id,
                            transfer.source.source.connectionId,
                            entry.path,
                            entry.name,
                            entry.type,
                            entry.size,
                            result,
                        );
                    }
                }

                return result;
            },
            [
                checkCancelled,
                scanLocalPath,
                scanRemotePath,
            ],
        );

    const getLocalDestinationInfo =
        useCallback(
            async (
                destinationPath: string,
            ): Promise<DestinationPathInfo | null> => {
                if (
                    !await exists(
                        destinationPath,
                    )
                ) {
                    return null;
                }

                const info =
                    await lstat(
                        destinationPath,
                    );

                return {
                    type:
                        typeFromLocalInfo(
                            info,
                        ),
                };
            },
            [],
        );

    const getRemoteDestinationInfo =
        useCallback(
            async (
                connectionId: string,
                destinationPath: string,
            ): Promise<DestinationPathInfo | null> => {
                try {
                    const info =
                        await backendClient.statRemotePath(
                            connectionId,
                            destinationPath,
                        );

                    return {
                        type: info.type,
                    };
                } catch (error) {
                    if (
                        isRemoteMissingError(
                            error,
                        )
                    ) {
                        return null;
                    }

                    throw error;
                }
            },
            [],
        );

    const askForConflictDecision =
        useCallback(
            async (
                transfer:
                    PreparedSftpTransfer,
                item:
                    TransferManifestItem,
                destinationPath: string,
                destinationType:
                    SftpTransferEntryType,
                itemNumber: number,
                itemCount: number,
            ): Promise<"replace" | "skip"> => {
                const currentMode =
                    conflictModesRef.current.get(
                        transfer.id,
                    ) ?? "ask";

                if (
                    currentMode ===
                    "replace-all"
                ) {
                    return "replace";
                }

                if (
                    currentMode ===
                    "skip-all"
                ) {
                    return "skip";
                }

                updateTransfer(
                    transfer.id,
                    (currentTransfer) => ({
                        ...currentTransfer,
                        status:
                            "waiting-for-conflict",
                        currentItemName:
                            item.name,
                        message:
                            `Waiting for your decision about ${item.name}…`,
                    }),
                );

                const decision =
                    await requestConflict({
                        id: crypto.randomUUID(),
                        transferId:
                            transfer.id,
                        entryName:
                            item.name,
                        sourcePath:
                            item.sourcePath,
                        destinationPath,
                        sourceType:
                            item.type,
                        destinationType,
                        sourceLabel:
                            transfer.source.label,
                        destinationLabel:
                            transfer.destination?.label ??
                            "Destination",
                        itemNumber,
                        itemCount,
                    });

                if (
                    decision === "cancel"
                ) {
                    throw new TransferCancelledError();
                }

                if (
                    decision ===
                    "replace-all"
                ) {
                    conflictModesRef.current.set(
                        transfer.id,
                        "replace-all",
                    );
                }

                if (
                    decision ===
                    "skip-all"
                ) {
                    conflictModesRef.current.set(
                        transfer.id,
                        "skip-all",
                    );
                }

                updateTransfer(
                    transfer.id,
                    (currentTransfer) => ({
                        ...currentTransfer,
                        status:
                            cancelRequestedTransferIdsRef.current.has(
                                transfer.id,
                            )
                                ? "cancelling"
                                : "running",
                        message:
                            "Continuing transfer…",
                    }),
                );

                return (
                    decision === "replace" ||
                    decision === "replace-all"
                )
                    ? "replace"
                    : "skip";
            },
            [requestConflict, updateTransfer],
        );

    const executeLocalFileCopy =
        useCallback(
            async (
                transferId: string,
                sourcePath: string,
                destinationPath: string,
                replaceExisting: boolean,
                baseTransferredBytes: number,
                aggregateTotalBytes: number,
                control: LocalTransferControl,
            ): Promise<number> => {
                const temporaryPath =
                    `${destinationPath}.ssh-workspace-${transferId}.part`;
                const backupPath =
                    `${destinationPath}.ssh-workspace-${transferId}.backup`;

                for (
                    const disposablePath of [
                        temporaryPath,
                        backupPath,
                    ]
                ) {
                    if (
                        await exists(
                            disposablePath,
                        )
                    ) {
                        await remove(
                            disposablePath,
                            {
                                recursive: true,
                            },
                        );
                    }
                }

                let sourceHandle:
                    Awaited<ReturnType<typeof open>> |
                    null = null;
                let destinationHandle:
                    Awaited<ReturnType<typeof open>> |
                    null = null;
                let temporaryCreated = false;
                let destinationBackedUp = false;
                let committed = false;
                let transferredForFile = 0;

                try {
                    sourceHandle =
                        await open(
                            sourcePath,
                            {
                                read: true,
                            },
                        );

                    const sourceStat =
                        await sourceHandle.stat();
                    const fileSize =
                        Math.max(
                            0,
                            sourceStat.size,
                        );

                    destinationHandle =
                        await open(
                            temporaryPath,
                            {
                                write: true,
                                createNew: true,
                            },
                        );
                    temporaryCreated = true;

                    let lastProgressUpdate = 0;

                    while (true) {
                        if (control.cancelled) {
                            throw new TransferCancelledError();
                        }

                        const remainingBytes =
                            Math.max(
                                0,
                                fileSize -
                                transferredForFile,
                            );

                        const requestedBytes =
                            fileSize > 0
                                ? Math.min(
                                    LOCAL_COPY_CHUNK_SIZE,
                                    remainingBytes,
                                )
                                : LOCAL_COPY_CHUNK_SIZE;

                        if (
                            fileSize > 0 &&
                            requestedBytes === 0
                        ) {
                            break;
                        }

                        const buffer =
                            new Uint8Array(
                                requestedBytes,
                            );
                        const bytesRead =
                            await sourceHandle.read(
                                buffer,
                            );

                        if (
                            bytesRead === null ||
                            bytesRead === 0
                        ) {
                            break;
                        }

                        let writtenBytes = 0;

                        while (
                            writtenBytes <
                            bytesRead
                        ) {
                            if (control.cancelled) {
                                throw new TransferCancelledError();
                            }

                            const bytesWritten =
                                await destinationHandle.write(
                                    buffer.subarray(
                                        writtenBytes,
                                        bytesRead,
                                    ),
                                );

                            if (
                                bytesWritten <= 0
                            ) {
                                throw new Error(
                                    "The local filesystem did not accept the copied data.",
                                );
                            }

                            writtenBytes +=
                                bytesWritten;
                        }

                        transferredForFile +=
                            bytesRead;

                        const now = Date.now();

                        if (
                            now -
                            lastProgressUpdate >=
                            PROGRESS_UPDATE_INTERVAL_MS ||
                            transferredForFile >=
                            fileSize
                        ) {
                            lastProgressUpdate = now;

                            updateTransferProgress(
                                transferId,
                                baseTransferredBytes +
                                transferredForFile,
                                aggregateTotalBytes,
                                "Copying folder contents…",
                            );
                        }
                    }

                    await sourceHandle.close();
                    sourceHandle = null;
                    await destinationHandle.close();
                    destinationHandle = null;

                    if (control.cancelled) {
                        throw new TransferCancelledError();
                    }

                    const destinationExists =
                        await exists(
                            destinationPath,
                        );

                    if (
                        destinationExists &&
                        !replaceExisting
                    ) {
                        throw new Error(
                            `The destination changed while copying and now contains "${getNameFromRelativePath(destinationPath)}".`,
                        );
                    }

                    if (destinationExists) {
                        await rename(
                            destinationPath,
                            backupPath,
                        );
                        destinationBackedUp = true;
                    }

                    try {
                        await rename(
                            temporaryPath,
                            destinationPath,
                        );
                        temporaryCreated = false;
                        committed = true;
                    } catch (error) {
                        if (destinationBackedUp) {
                            try {
                                await rename(
                                    backupPath,
                                    destinationPath,
                                );
                                destinationBackedUp = false;
                            } catch {
                                // Preserve the primary commit error.
                            }
                        }

                        throw error;
                    }

                    if (destinationBackedUp) {
                        try {
                            await remove(
                                backupPath,
                                {
                                    recursive: true,
                                },
                            );
                            destinationBackedUp = false;
                        } catch {
                            // The copied destination is valid. A stale
                            // backup can be removed manually if needed.
                        }
                    }

                    return transferredForFile;
                } finally {
                    try {
                        await sourceHandle?.close();
                    } catch {
                        // Preserve the primary result.
                    }

                    try {
                        await destinationHandle?.close();
                    } catch {
                        // Preserve the primary result.
                    }

                    if (
                        temporaryCreated &&
                        !committed
                    ) {
                        try {
                            await remove(
                                temporaryPath,
                                {
                                    recursive: true,
                                },
                            );
                        } catch {
                            // Preserve the primary result.
                        }
                    }

                    if (
                        destinationBackedUp &&
                        !await exists(
                            destinationPath,
                        )
                    ) {
                        try {
                            await rename(
                                backupPath,
                                destinationPath,
                            );
                        } catch {
                            // Preserve the primary result.
                        }
                    }
                }
            },
            [updateTransferProgress],
        );

    const removeRemoteDirectoryForReplacement =
        useCallback(
            async (
                connectionId: string,
                destinationPath: string,
            ): Promise<void> => {
                const listing =
                    await backendClient.listRemoteDirectory(
                        connectionId,
                        destinationPath,
                    );

                if (
                    listing.entries.length > 0
                ) {
                    throw new Error(
                        "A non-empty remote folder cannot be replaced by a file. Empty or rename that folder first.",
                    );
                }

                await backendClient.deleteRemoteDirectory(
                    connectionId,
                    destinationPath,
                );
            },
            [],
        );

    const executeBackendFileTransfer =
        useCallback(
            async (
                transfer:
                    PreparedSftpTransfer,
                item:
                    TransferManifestItem,
                destinationPath: string,
                replaceExisting: boolean,
                destinationInfo:
                    DestinationPathInfo |
                    null,
                baseTransferredBytes: number,
                aggregateTotalBytes: number,
            ): Promise<number> => {
                let backendTransferId =
                    crypto.randomUUID();

                const isUpload =
                    transfer.operation ===
                    "local-to-remote";

                const waiter =
                    createBackendTransferWaiter(
                        transfer.id,
                        backendTransferId,
                        baseTransferredBytes,
                        aggregateTotalBytes,
                        isUpload
                            ? "upload"
                            : "download",
                    );

                let localBackupPath:
                    string |
                    null = null;

                try {
                    updateTransfer(
                        transfer.id,
                        (currentTransfer) => ({
                            ...currentTransfer,
                            backendTransferId,
                            status:
                                cancelRequestedTransferIdsRef.current.has(
                                    transfer.id,
                                )
                                    ? "cancelling"
                                    : "running",
                            currentItemName:
                                item.name,
                            message:
                                isUpload
                                    ? `Uploading ${item.name}…`
                                    : `Downloading ${item.name}…`,
                        }),
                    );

                    if (isUpload) {
                        if (
                            transfer.destination?.source.type !==
                            "remote"
                        ) {
                            throw new Error(
                                "The remote destination is no longer available.",
                            );
                        }

                        if (
                            replaceExisting &&
                            destinationInfo?.type ===
                            "directory"
                        ) {
                            await removeRemoteDirectoryForReplacement(
                                transfer.destination.source.connectionId,
                                destinationPath,
                            );
                        }

                        await backendClient.uploadLocalFile(
                            transfer.destination.source.connectionId,
                            item.sourcePath,
                            destinationPath,
                            replaceExisting,
                            backendTransferId,
                        );
                    } else {
                        if (
                            transfer.source.source.type !==
                            "remote"
                        ) {
                            throw new Error(
                                "The remote source is no longer available.",
                            );
                        }

                        if (
                            replaceExisting &&
                            destinationInfo &&
                            destinationInfo.type !==
                            "file"
                        ) {
                            localBackupPath =
                                `${destinationPath}.ssh-workspace-${transfer.id}.backup`;

                            if (
                                await exists(
                                    localBackupPath,
                                )
                            ) {
                                await remove(
                                    localBackupPath,
                                    {
                                        recursive: true,
                                    },
                                );
                            }

                            await rename(
                                destinationPath,
                                localBackupPath,
                            );
                        }

                        await backendClient.downloadRemoteFile(
                            transfer.source.source.connectionId,
                            item.sourcePath,
                            destinationPath,
                            backendTransferId,
                        );
                    }

                    if (
                        cancelRequestedTransferIdsRef.current.has(
                            transfer.id,
                        )
                    ) {
                        await backendClient.cancelTransfer(
                            backendTransferId,
                        );
                    }

                    const result =
                        await waiter.promise;

                    if (localBackupPath) {
                        try {
                            await remove(
                                localBackupPath,
                                {
                                    recursive: true,
                                },
                            );
                            localBackupPath = null;
                        } catch {
                            // The downloaded destination is valid. A stale
                            // backup can be removed manually if needed.
                        }
                    }

                    return result.transferredBytes;
                } catch (error) {
                    waiter.dispose();

                    if (
                        localBackupPath &&
                        !await exists(
                            destinationPath,
                        )
                    ) {
                        try {
                            await rename(
                                localBackupPath,
                                destinationPath,
                            );
                            localBackupPath = null;
                        } catch {
                            // Preserve the transfer error.
                        }
                    }

                    throw error;
                } finally {
                    updateTransfer(
                        transfer.id,
                        (currentTransfer) =>
                            withoutBackendTransferId(
                                currentTransfer,
                            ),
                    );
                }
            },
            [
                createBackendTransferWaiter,
                removeRemoteDirectoryForReplacement,
                updateTransfer,
            ],
        );

    const ensureDestinationDirectory =
        useCallback(
            async (
                transfer:
                    PreparedSftpTransfer,
                item:
                    TransferManifestItem,
                destinationPath: string,
                itemNumber: number,
                itemCount: number,
            ): Promise<boolean> => {
                if (
                    transfer.destination?.source.type ===
                    "local"
                ) {
                    const destinationInfo =
                        await getLocalDestinationInfo(
                            destinationPath,
                        );

                    if (
                        destinationInfo?.type ===
                        "directory"
                    ) {
                        return true;
                    }

                    if (destinationInfo) {
                        const decision =
                            await askForConflictDecision(
                                transfer,
                                item,
                                destinationPath,
                                destinationInfo.type,
                                itemNumber,
                                itemCount,
                            );

                        if (decision === "skip") {
                            return false;
                        }

                        await remove(
                            destinationPath,
                            {
                                recursive: true,
                            },
                        );
                    }

                    await mkdir(
                        destinationPath,
                        {
                            recursive: true,
                        },
                    );
                    return true;
                }

                if (
                    transfer.destination?.source.type !==
                    "remote"
                ) {
                    throw new Error(
                        "The destination pane is no longer available.",
                    );
                }

                const connectionId =
                    transfer.destination.source.connectionId;
                const destinationInfo =
                    await getRemoteDestinationInfo(
                        connectionId,
                        destinationPath,
                    );

                if (
                    destinationInfo?.type ===
                    "directory"
                ) {
                    return true;
                }

                if (destinationInfo) {
                    const decision =
                        await askForConflictDecision(
                            transfer,
                            item,
                            destinationPath,
                            destinationInfo.type,
                            itemNumber,
                            itemCount,
                        );

                    if (decision === "skip") {
                        return false;
                    }

                    await backendClient.deleteRemoteFile(
                        connectionId,
                        destinationPath,
                    );
                }

                await backendClient.createRemoteDirectory(
                    connectionId,
                    destinationPath,
                );
                return true;
            },
            [
                askForConflictDecision,
                getLocalDestinationInfo,
                getRemoteDestinationInfo,
            ],
        );

    const executePreparedTransfer =
        useCallback(
            async (
                transfer:
                    PreparedSftpTransfer,
            ): Promise<void> => {
                if (
                    !transfer.destination ||
                    !transfer.operation
                ) {
                    return;
                }

                const startedAt = Date.now();
                const control:
                    LocalTransferControl = {
                    cancelled:
                        cancelRequestedTransferIdsRef.current.has(
                            transfer.id,
                        ),
                };

                localTransferControlsRef.current.set(
                    transfer.id,
                    control,
                );
                conflictModesRef.current.set(
                    transfer.id,
                    "ask",
                );

                const runningTransfer:
                    PreparedSftpTransfer = {
                    ...transfer,
                    status: "running",
                    startedAt,
                    transferredBytes: 0,
                    totalBytes: 0,
                    progressPercent: 0,
                    bytesPerSecond: 0,
                    totalFileCount: 0,
                    completedFileCount: 0,
                    skippedItemCount: 0,
                    failedItemCount: 0,
                    skippedSymlinkCount: 0,
                    message:
                        "Scanning selected files and folders…",
                };

                progressSamplesRef.current.set(
                    transfer.id,
                    {
                        timestamp: startedAt,
                        transferredBytes: 0,
                        bytesPerSecond: 0,
                    },
                );
                replaceTransfer(
                    runningTransfer,
                );

                try {
                    checkCancelled(
                        transfer.id,
                    );

                    const manifestResult =
                        await buildManifest(
                            transfer,
                        );

                    const manifest =
                        manifestResult.items;
                    const fileItems =
                        manifest.filter(
                            (item) =>
                                item.type ===
                                "file",
                        );
                    const totalBytes =
                        fileItems.reduce(
                            (total, item) =>
                                total +
                                Math.max(
                                    0,
                                    item.size,
                                ),
                            0,
                        );

                    updateTransfer(
                        transfer.id,
                        (currentTransfer) => ({
                            ...currentTransfer,
                            totalBytes,
                            totalFileCount:
                                fileItems.length,
                            skippedSymlinkCount:
                                manifestResult.skippedSymlinkCount,
                            failedItemCount:
                                manifestResult.scanErrors.length,
                            message:
                                manifest.length > 0
                                    ? `Copying ${fileItems.length} file${fileItems.length === 1 ? "" : "s"}…`
                                    : "No transferable files were found.",
                        }),
                    );

                    const skippedPaths =
                        new Set<string>();
                    const failedMessages = [
                        ...manifestResult.scanErrors,
                    ];
                    let completedFileCount = 0;
                    let skippedItemCount = 0;

                    const markSkippedSubtree =
                        (
                            relativePath: string,
                        ): void => {
                            const affectedItems =
                                manifest.filter(
                                    (candidate) =>
                                        !skippedPaths.has(
                                            candidate.relativePath,
                                        ) &&
                                        relativePathIsInside(
                                            candidate.relativePath,
                                            relativePath,
                                        ),
                                );

                            let skippedBytes = 0;

                            for (
                                const affectedItem of
                                affectedItems
                            ) {
                                skippedPaths.add(
                                    affectedItem.relativePath,
                                );

                                if (
                                    affectedItem.type ===
                                    "file"
                                ) {
                                    skippedBytes +=
                                        affectedItem.size;
                                }
                            }

                            skippedItemCount +=
                                affectedItems.length;

                            reduceTransferTotalBytes(
                                transfer.id,
                                skippedBytes,
                            );

                            updateTransfer(
                                transfer.id,
                                (currentTransfer) => ({
                                    ...currentTransfer,
                                    skippedItemCount,
                                }),
                            );
                        };

                    for (
                        let index = 0;
                        index < manifest.length;
                        index += 1
                    ) {
                        checkCancelled(
                            transfer.id,
                        );

                        const item =
                            manifest[index]!;

                        if (
                            skippedPaths.has(
                                item.relativePath,
                            )
                        ) {
                            continue;
                        }

                        const destinationPath =
                            transfer.destination.source.type ===
                                "local"
                                ? await joinLocalRelativePath(
                                    transfer.destination.directoryPath,
                                    item.relativePath,
                                )
                                : joinRemoteRelativePath(
                                    transfer.destination.directoryPath,
                                    item.relativePath,
                                );

                        updateTransfer(
                            transfer.id,
                            (currentTransfer) => ({
                                ...currentTransfer,
                                currentItemName:
                                    item.name,
                                message:
                                    item.type ===
                                        "directory"
                                        ? `Creating ${item.name}…`
                                        : `Copying ${item.name}…`,
                            }),
                        );

                        if (
                            item.type ===
                            "directory"
                        ) {
                            try {
                                const shouldContinue =
                                    await ensureDestinationDirectory(
                                        transfer,
                                        item,
                                        destinationPath,
                                        index + 1,
                                        manifest.length,
                                    );

                                if (!shouldContinue) {
                                    markSkippedSubtree(
                                        item.relativePath,
                                    );
                                }
                            } catch (error) {
                                if (
                                    error instanceof
                                    TransferCancelledError ||
                                    isConnectionUnavailableError(
                                        error,
                                    )
                                ) {
                                    throw error;
                                }

                                failedMessages.push(
                                    `${item.relativePath}: ${getErrorMessage(error)}`,
                                );
                                markSkippedSubtree(
                                    item.relativePath,
                                );

                                updateTransfer(
                                    transfer.id,
                                    (currentTransfer) => ({
                                        ...currentTransfer,
                                        failedItemCount:
                                            failedMessages.length,
                                    }),
                                );
                            }

                            continue;
                        }

                        const beforeFileTransfer =
                            transfersRef.current.find(
                                (candidate) =>
                                    candidate.id ===
                                    transfer.id,
                            )?.transferredBytes ??
                            0;

                        try {
                            const destinationInfo =
                                transfer.destination.source.type ===
                                    "local"
                                    ? await getLocalDestinationInfo(
                                        destinationPath,
                                    )
                                    : await getRemoteDestinationInfo(
                                        transfer.destination.source.connectionId,
                                        destinationPath,
                                    );

                            let replaceExisting =
                                false;

                            if (destinationInfo) {
                                const decision =
                                    await askForConflictDecision(
                                        transfer,
                                        item,
                                        destinationPath,
                                        destinationInfo.type,
                                        index + 1,
                                        manifest.length,
                                    );

                                if (decision === "skip") {
                                    markSkippedSubtree(
                                        item.relativePath,
                                    );
                                    continue;
                                }

                                replaceExisting = true;
                            }

                            const currentTransfer =
                                transfersRef.current.find(
                                    (candidate) =>
                                        candidate.id ===
                                        transfer.id,
                                ) ?? runningTransfer;

                            let copiedBytes = 0;

                            if (
                                transfer.operation ===
                                "local-to-local"
                            ) {
                                copiedBytes =
                                    await executeLocalFileCopy(
                                        transfer.id,
                                        item.sourcePath,
                                        destinationPath,
                                        replaceExisting,
                                        currentTransfer.transferredBytes,
                                        currentTransfer.totalBytes,
                                        control,
                                    );
                            } else {
                                copiedBytes =
                                    await executeBackendFileTransfer(
                                        transfer,
                                        item,
                                        destinationPath,
                                        replaceExisting,
                                        destinationInfo,
                                        currentTransfer.transferredBytes,
                                        currentTransfer.totalBytes,
                                    );
                            }

                            completedFileCount += 1;

                            const latestTransfer =
                                transfersRef.current.find(
                                    (candidate) =>
                                        candidate.id ===
                                        transfer.id,
                                ) ?? currentTransfer;

                            updateTransferProgress(
                                transfer.id,
                                Math.max(
                                    latestTransfer.transferredBytes,
                                    currentTransfer.transferredBytes +
                                    copiedBytes,
                                ),
                                latestTransfer.totalBytes,
                                `Copied ${item.name}.`,
                            );

                            updateTransfer(
                                transfer.id,
                                (candidate) => ({
                                    ...candidate,
                                    completedFileCount,
                                }),
                            );
                        } catch (error) {
                            if (
                                error instanceof
                                TransferCancelledError ||
                                isConnectionUnavailableError(
                                    error,
                                )
                            ) {
                                throw error;
                            }

                            failedMessages.push(
                                `${item.relativePath}: ${getErrorMessage(error)}`,
                            );

                            const latestTransferredBytes =
                                transfersRef.current.find(
                                    (candidate) =>
                                        candidate.id ===
                                        transfer.id,
                                )?.transferredBytes ??
                                beforeFileTransfer;

                            const processedForFailedFile =
                                Math.max(
                                    0,
                                    latestTransferredBytes -
                                    beforeFileTransfer,
                                );

                            reduceTransferTotalBytes(
                                transfer.id,
                                Math.max(
                                    0,
                                    item.size -
                                    processedForFailedFile,
                                ),
                            );

                            updateTransfer(
                                transfer.id,
                                (currentTransfer) => ({
                                    ...currentTransfer,
                                    failedItemCount:
                                        failedMessages.length,
                                }),
                            );
                        }
                    }

                    checkCancelled(
                        transfer.id,
                    );

                    const currentTransfer =
                        transfersRef.current.find(
                            (candidate) =>
                                candidate.id ===
                                transfer.id,
                        ) ?? runningTransfer;

                    const hasIssues =
                        failedMessages.length > 0;
                    const completedTransfer =
                        withoutBackendTransferId({
                            ...currentTransfer,
                            status:
                                hasIssues
                                    ? "completed-with-errors"
                                    : "completed",
                            completedAt: Date.now(),
                            completedFileCount,
                            skippedItemCount,
                            failedItemCount:
                                failedMessages.length,
                            skippedSymlinkCount:
                                manifestResult.skippedSymlinkCount,
                            progressPercent: 100,
                            bytesPerSecond: 0,
                            message:
                                hasIssues
                                    ? `Copied ${completedFileCount} file${completedFileCount === 1 ? "" : "s"}; ${failedMessages.length} item${failedMessages.length === 1 ? "" : "s"} failed${skippedItemCount > 0 ? `; ${skippedItemCount} skipped` : ""}. ${failedMessages[0]}`
                                    : completedFileCount === 0
                                        ? `Nothing was copied${skippedItemCount > 0 ? `; ${skippedItemCount} item${skippedItemCount === 1 ? " was" : "s were"} skipped` : ""}${manifestResult.skippedSymlinkCount > 0 ? `; ${manifestResult.skippedSymlinkCount} symbolic link${manifestResult.skippedSymlinkCount === 1 ? " was" : "s were"} ignored` : ""}.`
                                        : `Copied ${completedFileCount} file${completedFileCount === 1 ? "" : "s"} to ${transfer.destination.label}${skippedItemCount > 0 ? `; ${skippedItemCount} skipped` : ""}${manifestResult.skippedSymlinkCount > 0 ? `; ${manifestResult.skippedSymlinkCount} symbolic link${manifestResult.skippedSymlinkCount === 1 ? "" : "s"} ignored` : ""}.`,
                        });

                    replaceTransfer(
                        completedTransfer,
                    );

                    onTransferCompletedRef
                        .current?.(
                            completedTransfer,
                        );
                } catch (error) {
                    const currentTransfer =
                        transfersRef.current.find(
                            (candidate) =>
                                candidate.id ===
                                transfer.id,
                        ) ?? runningTransfer;

                    const cancelled =
                        error instanceof
                        TransferCancelledError;

                    replaceTransfer(
                        withoutBackendTransferId({
                            ...currentTransfer,
                            status:
                                cancelled
                                    ? "cancelled"
                                    : "failed",
                            completedAt: Date.now(),
                            bytesPerSecond: 0,
                            message:
                                cancelled
                                    ? "Transfer cancelled. Any unfinished temporary file was removed."
                                    : getErrorMessage(
                                        error,
                                    ),
                        }),
                    );
                } finally {
                    localTransferControlsRef.current.delete(
                        transfer.id,
                    );
                    progressSamplesRef.current.delete(
                        transfer.id,
                    );
                    cancelRequestedTransferIdsRef.current.delete(
                        transfer.id,
                    );
                    conflictModesRef.current.delete(
                        transfer.id,
                    );
                }
            },
            [
                askForConflictDecision,
                buildManifest,
                checkCancelled,
                ensureDestinationDirectory,
                executeBackendFileTransfer,
                executeLocalFileCopy,
                getLocalDestinationInfo,
                getRemoteDestinationInfo,
                reduceTransferTotalBytes,
                replaceTransfer,
                updateTransfer,
                updateTransferProgress,
            ],
        );

    const prepareCopy =
        useCallback(
            (
                input:
                    PrepareSftpTransferInput,
            ): PreparedSftpTransfer => {
                const preparedTransfer =
                    prepareSftpTransfer(
                        input,
                    );

                updateTransfers(
                    (currentTransfers) => [
                        preparedTransfer,
                        ...currentTransfers,
                    ].slice(
                        0,
                        MAX_TRANSFERS,
                    ),
                );

                if (
                    preparedTransfer.status ===
                    "prepared"
                ) {
                    void executePreparedTransfer(
                        preparedTransfer,
                    );
                }

                return preparedTransfer;
            },
            [
                executePreparedTransfer,
                updateTransfers,
            ],
        );

    const cancelPreparedTransfer =
        useCallback(
            async (
                transferId: string,
            ): Promise<void> => {
                const transfer =
                    transfersRef.current.find(
                        (candidate) =>
                            candidate.id ===
                            transferId,
                    );

                if (
                    !transfer ||
                    ![
                        "running",
                        "prepared",
                        "waiting-for-conflict",
                    ].includes(
                        transfer.status,
                    )
                ) {
                    return;
                }

                cancelRequestedTransferIdsRef.current.add(
                    transferId,
                );

                updateTransfer(
                    transferId,
                    (currentTransfer) => ({
                        ...currentTransfer,
                        status: "cancelling",
                        message:
                            "Cancelling transfer…",
                    }),
                );

                const localControl =
                    localTransferControlsRef.current
                        .get(
                            transferId,
                        );

                if (localControl) {
                    localControl.cancelled = true;
                }

                if (
                    activeConflictWaiterRef.current
                        ?.conflict.transferId ===
                    transferId
                ) {
                    resolveConflict(
                        "cancel",
                    );
                }

                const retainedQueue:
                    ConflictWaiter[] = [];

                for (
                    const waiter of
                    conflictQueueRef.current
                ) {
                    if (
                        waiter.conflict.transferId ===
                        transferId
                    ) {
                        waiter.resolve(
                            "cancel",
                        );
                    } else {
                        retainedQueue.push(
                            waiter,
                        );
                    }
                }

                conflictQueueRef.current =
                    retainedQueue;

                if (
                    transfer.backendTransferId
                ) {
                    try {
                        await backendClient.cancelTransfer(
                            transfer.backendTransferId,
                        );
                    } catch (error) {
                        if (
                            !isConnectionUnavailableError(
                                error,
                            )
                        ) {
                            updateTransfer(
                                transferId,
                                (currentTransfer) => ({
                                    ...currentTransfer,
                                    message:
                                        `Cancellation requested; backend response: ${getErrorMessage(error)}`,
                                }),
                            );
                        }
                    }
                }
            },
            [
                resolveConflict,
                updateTransfer,
            ],
        );

    const dismissPreparedTransfer =
        useCallback(
            (
                transferId: string,
            ): void => {
                updateTransfers(
                    (currentTransfers) =>
                        currentTransfers.filter(
                            (transfer) =>
                                transfer.id !==
                                transferId ||
                                [
                                    "running",
                                    "cancelling",
                                    "prepared",
                                    "waiting-for-conflict",
                                ].includes(
                                    transfer.status,
                                ),
                        ),
                );
            },
            [updateTransfers],
        );

    const clearPreparedTransfers =
        useCallback((): void => {
            updateTransfers(
                (currentTransfers) =>
                    currentTransfers.filter(
                        (transfer) =>
                            [
                                "running",
                                "cancelling",
                                "prepared",
                                "waiting-for-conflict",
                            ].includes(
                                transfer.status,
                            ),
                    ),
            );
        }, [updateTransfers]);

    return {
        preparedTransfers,
        pendingConflict,
        prepareCopy,
        resolveConflict,
        cancelPreparedTransfer,
        dismissPreparedTransfer,
        clearPreparedTransfers,
    };
}
