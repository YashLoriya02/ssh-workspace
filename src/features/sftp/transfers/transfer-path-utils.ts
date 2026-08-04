import type {
    SftpPaneSide,
    SftpPaneSource,
} from "../sftp-types";

import type {
    PrepareSftpTransferInput,
    PreparedSftpTransfer,
    SftpTransferEndpoint,
    SftpTransferOperation,
} from "./sftp-transfer-types";

const isWindows =
    navigator.userAgent.includes(
        "Windows",
    );

function normalizeLocalPath(
    path: string,
): string {
    const normalized =
        path
            .replace(/\\/gu, "/")
            .replace(/\/+$/gu, "");

    return isWindows
        ? normalized.toLocaleLowerCase()
        : normalized;
}

function normalizeRemotePath(
    path: string,
): string {
    if (path === "/") {
        return "/";
    }

    return (
        path
            .replace(/\/+$/gu, "") ||
        "/"
    );
}

function isPathEqualOrDescendant(
    candidatePath: string,
    parentPath: string,
): boolean {
    return (
        candidatePath === parentPath ||
        candidatePath.startsWith(
            `${parentPath}/`,
        )
    );
}

export function joinRemotePath(
    parentPath: string,
    name: string,
): string {
    if (parentPath === "/") {
        return `/${name}`;
    }

    return `${parentPath.replace(/\/+$/gu, "")}/${name}`;
}

export function getOppositePaneSide(
    side: SftpPaneSide,
): SftpPaneSide {
    return side === "left"
        ? "right"
        : "left";
}

export function getPaneDirectoryPath(
    source: SftpPaneSource,
): string | null {
    if (source.type === "empty") {
        return null;
    }

    return source.path;
}

function getRemoteLabel(
    connectionId: string,
    servers: PrepareSftpTransferInput["servers"],
): string {
    const server =
        servers.find(
            (candidate) =>
                candidate.connectionId ===
                connectionId,
        );

    if (!server) {
        return "Remote server";
    }

    return (
        server.title ||
        `${server.username}@${server.host}`
    );
}

export function createTransferEndpoint(
    side: SftpPaneSide,
    source: SftpPaneSource,
    servers: PrepareSftpTransferInput["servers"],
): SftpTransferEndpoint | null {
    if (
        source.type === "empty" ||
        !source.path
    ) {
        return null;
    }

    if (source.type === "local") {
        return {
            side,
            source,
            directoryPath:
                source.path,
            label:
                "Local Computer",
        };
    }

    return {
        side,
        source,
        directoryPath:
            source.path,
        label:
            getRemoteLabel(
                source.connectionId,
                servers,
            ),
    };
}

function endpointsAreSameDirectory(
    source: SftpTransferEndpoint,
    destination: SftpTransferEndpoint,
): boolean {
    if (
        source.source.type !==
        destination.source.type
    ) {
        return false;
    }

    if (
        source.source.type === "local" &&
        destination.source.type === "local"
    ) {
        return (
            normalizeLocalPath(
                source.directoryPath,
            ) ===
            normalizeLocalPath(
                destination.directoryPath,
            )
        );
    }

    if (
        source.source.type === "remote" &&
        destination.source.type === "remote"
    ) {
        return (
            source.source.connectionId ===
                destination.source.connectionId &&
            normalizeRemotePath(
                source.directoryPath,
            ) ===
                normalizeRemotePath(
                    destination.directoryPath,
                )
        );
    }

    return false;
}

function getTransferOperation(
    source: SftpTransferEndpoint,
    destination: SftpTransferEndpoint,
): SftpTransferOperation {
    if (source.source.type === "local") {
        return destination.source.type === "local"
            ? "local-to-local"
            : "local-to-remote";
    }

    return destination.source.type === "local"
        ? "remote-to-local"
        : "remote-to-remote";
}

function destinationIsInsideSelectedFolder(
    source: SftpTransferEndpoint,
    destination: SftpTransferEndpoint,
    input: PrepareSftpTransferInput,
): boolean {
    const directories =
        input.entries.filter(
            (entry) =>
                entry.type ===
                "directory",
        );

    if (directories.length === 0) {
        return false;
    }

    if (
        source.source.type === "local" &&
        destination.source.type === "local"
    ) {
        const destinationPath =
            normalizeLocalPath(
                destination.directoryPath,
            );

        return directories.some(
            (entry) =>
                isPathEqualOrDescendant(
                    destinationPath,
                    normalizeLocalPath(
                        entry.path,
                    ),
                ),
        );
    }

    if (
        source.source.type === "remote" &&
        destination.source.type === "remote" &&
        source.source.connectionId ===
            destination.source.connectionId
    ) {
        const destinationPath =
            normalizeRemotePath(
                destination.directoryPath,
            );

        return directories.some(
            (entry) =>
                isPathEqualOrDescendant(
                    destinationPath,
                    normalizeRemotePath(
                        entry.path,
                    ),
                ),
        );
    }

    return false;
}

export function prepareSftpTransfer(
    input: PrepareSftpTransferInput,
): PreparedSftpTransfer {
    const sourceEndpoint =
        createTransferEndpoint(
            input.sourceSide,
            input.source,
            input.servers,
        );

    const destinationEndpoint =
        createTransferEndpoint(
            input.destinationSide,
            input.destination,
            input.servers,
        );

    const entryCount =
        input.entries.length;

    const entryLabel =
        entryCount === 1
            ? input.entries[0]?.name ??
                "Selected item"
            : `${entryCount} selected items`;

    const baseTransfer:
        PreparedSftpTransfer = {
            id: crypto.randomUUID(),
            createdAt: Date.now(),
            trigger: input.trigger,
            operation: null,
            source:
                sourceEndpoint ?? {
                    side: input.sourceSide,
                    source: {
                        type: "local",
                        rootPath: null,
                        path: "",
                    },
                    directoryPath: "",
                    label: "Unavailable source",
                },
            destination:
                destinationEndpoint,
            entries: [
                ...input.entries,
            ],
            title: entryLabel,
            status: "prepared",
            message:
                "Preparing transfer…",
            transferredBytes: 0,
            totalBytes:
                input.entries.reduce(
                    (total, entry) =>
                        total +
                        (
                            entry.type ===
                            "file"
                                ? Math.max(
                                    0,
                                    entry.size,
                                )
                                : 0
                        ),
                    0,
                ),
            progressPercent: 0,
            bytesPerSecond: 0,
            totalFileCount:
                input.entries.filter(
                    (entry) =>
                        entry.type ===
                        "file",
                ).length,
            completedFileCount: 0,
            skippedItemCount: 0,
            failedItemCount: 0,
            skippedSymlinkCount: 0,
        };

    if (!sourceEndpoint) {
        return {
            ...baseTransfer,
            status: "blocked",
            message:
                "The source pane does not currently have an open directory.",
        };
    }

    if (entryCount === 0) {
        return {
            ...baseTransfer,
            status: "blocked",
            message:
                "Select at least one file or folder before starting a transfer.",
        };
    }

    const transferableEntries =
        input.entries.filter(
            (entry) =>
                entry.type === "file" ||
                entry.type === "directory",
        );

    if (transferableEntries.length === 0) {
        return {
            ...baseTransfer,
            status: "blocked",
            message:
                input.entries.some(
                    (entry) =>
                        entry.type ===
                        "symlink",
                )
                    ? "Symbolic links are not followed or copied for safety."
                    : "The selected item type cannot be copied.",
        };
    }

    if (!destinationEndpoint) {
        return {
            ...baseTransfer,
            status: "blocked",
            message:
                "Open a local folder or remote directory in the other pane first.",
        };
    }

    if (
        endpointsAreSameDirectory(
            sourceEndpoint,
            destinationEndpoint,
        )
    ) {
        return {
            ...baseTransfer,
            status: "blocked",
            message:
                "The source and destination are the same directory.",
        };
    }

    if (
        destinationIsInsideSelectedFolder(
            sourceEndpoint,
            destinationEndpoint,
            input,
        )
    ) {
        return {
            ...baseTransfer,
            status: "blocked",
            message:
                "A folder cannot be copied into itself or one of its own subfolders.",
        };
    }

    const operation =
        getTransferOperation(
            sourceEndpoint,
            destinationEndpoint,
        );

    return {
        ...baseTransfer,
        operation,
        status: "prepared",
        message:
            transferableEntries.some(
                (entry) =>
                    entry.type ===
                    "directory",
            )
                ? "Scanning selected folders…"
                : "Starting file copy…",
    };
}
