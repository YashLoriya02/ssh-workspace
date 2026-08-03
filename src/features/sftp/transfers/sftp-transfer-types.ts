import type {
    SftpPaneSide,
    SftpPaneSource,
} from "../sftp-types";

export type SftpTransferTrigger =
    | "context-menu"
    | "drag-drop";

export type SftpTransferEntryType =
    | "file"
    | "directory"
    | "symlink"
    | "other";

export interface SftpTransferEntry {
    name: string;
    path: string;
    type: SftpTransferEntryType;
    size: number;
}

export interface SftpTransferEndpoint {
    side: SftpPaneSide;
    source: Exclude<
        SftpPaneSource,
        {
            type: "empty";
        }
    >;
    directoryPath: string;
    label: string;
}

export type SftpTransferOperation =
    | "local-to-local"
    | "local-to-remote"
    | "remote-to-local"
    | "remote-to-remote";

export type PreparedSftpTransferStatus =
    | "prepared"
    | "blocked"
    | "running"
    | "waiting-for-conflict"
    | "cancelling"
    | "completed"
    | "completed-with-errors"
    | "failed"
    | "cancelled";

export interface PreparedSftpTransfer {
    id: string;
    createdAt: number;
    startedAt?: number;
    completedAt?: number;

    trigger: SftpTransferTrigger;
    status: PreparedSftpTransferStatus;
    operation: SftpTransferOperation | null;

    source: SftpTransferEndpoint;
    destination:
        | SftpTransferEndpoint
        | null;

    entries: SftpTransferEntry[];

    title: string;
    message: string;
    currentItemName?: string;

    transferredBytes: number;
    totalBytes: number;
    progressPercent: number;
    bytesPerSecond: number;

    totalFileCount: number;
    completedFileCount: number;
    skippedItemCount: number;
    failedItemCount: number;
    skippedSymlinkCount: number;

    backendTransferId?: string;
}

export interface PrepareSftpTransferInput {
    sourceSide: SftpPaneSide;
    source: SftpPaneSource;
    destinationSide: SftpPaneSide;
    destination: SftpPaneSource;
    entries: readonly SftpTransferEntry[];
    trigger: SftpTransferTrigger;
    servers: readonly {
        connectionId: string;
        title: string;
        host: string;
        username: string;
    }[];
}

export type SftpConflictDecision =
    | "replace"
    | "skip"
    | "replace-all"
    | "skip-all"
    | "cancel";

export interface PendingSftpConflict {
    id: string;
    transferId: string;

    entryName: string;
    sourcePath: string;
    destinationPath: string;

    sourceType: SftpTransferEntryType;
    destinationType: SftpTransferEntryType;

    sourceLabel: string;
    destinationLabel: string;

    itemNumber: number;
    itemCount: number;
}

export interface UseSftpTransferManagerOptions {
    onTransferCompleted?: (
        transfer: PreparedSftpTransfer,
    ) => void;
}
