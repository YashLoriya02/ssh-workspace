import {
    AlertTriangle,
    ArrowRight,
    CheckCircle2,
    Files,
    LoaderCircle,
    Square,
    X,
    XCircle,
} from "lucide-react";

import type {
    PreparedSftpTransfer,
} from "./sftp-transfer-types";

interface SftpTransferPanelProps {
    transfers:
    readonly PreparedSftpTransfer[];

    onCancel: (
        transferId: string,
    ) => void;

    onDismiss: (
        transferId: string,
    ) => void;

    onClear: () => void;
}

function formatBytes(
    bytes: number,
): string {
    if (!Number.isFinite(bytes)) {
        return "0 B";
    }

    const safeBytes =
        Math.max(0, bytes);

    if (safeBytes < 1024) {
        return `${Math.round(safeBytes)} B`;
    }

    const units = [
        "KB",
        "MB",
        "GB",
        "TB",
    ];

    let value =
        safeBytes / 1024;

    let unitIndex = 0;

    while (
        value >= 1024 &&
        unitIndex <
        units.length - 1
    ) {
        value /= 1024;
        unitIndex += 1;
    }

    return `${value.toFixed(
        value >= 100
            ? 0
            : value >= 10
                ? 1
                : 2,
    )} ${units[unitIndex]}`;
}

function formatSpeed(
    bytesPerSecond: number,
): string {
    if (
        !Number.isFinite(
            bytesPerSecond,
        ) ||
        bytesPerSecond <= 0
    ) {
        return "Calculating speed…";
    }

    return `${formatBytes(
        bytesPerSecond,
    )}/s`;
}

function getSourceLabel(
    transfer: PreparedSftpTransfer,
): string {
    return [
        transfer.source.label,
        transfer.source.directoryPath,
    ].filter(Boolean).join(
        " · ",
    );
}

function getDestinationLabel(
    transfer: PreparedSftpTransfer,
): string {
    if (!transfer.destination) {
        return "Other pane unavailable";
    }

    return [
        transfer.destination.label,
        transfer.destination.directoryPath,
    ].filter(Boolean).join(
        " · ",
    );
}

function getStatusLabel(
    transfer: PreparedSftpTransfer,
): string {
    switch (transfer.status) {
        case "prepared":
            return "Queued";

        case "running":
            return "Copying";

        case "waiting-for-conflict":
            return "Needs decision";

        case "cancelling":
            return "Cancelling";

        case "completed":
            return "Completed";

        case "completed-with-errors":
            return "Completed with issues";

        case "cancelled":
            return "Cancelled";

        case "failed":
            return "Failed";

        case "blocked":
        default:
            return "Blocked";
    }
}

function getStatusIcon(
    transfer: PreparedSftpTransfer,
) {
    if (
        transfer.status === "prepared" ||
        transfer.status === "running" ||
        transfer.status === "waiting-for-conflict" ||
        transfer.status === "cancelling"
    ) {
        return (
            <LoaderCircle
                size={16}
                className="loader"
                aria-hidden="true"
            />
        );
    }

    if (
        transfer.status === "completed"
    ) {
        return (
            <CheckCircle2
                size={16}
                aria-hidden="true"
            />
        );
    }

    if (
        transfer.status === "cancelled"
    ) {
        return (
            <XCircle
                size={16}
                aria-hidden="true"
            />
        );
    }

    return (
        <AlertTriangle
            size={16}
            aria-hidden="true"
        />
    );
}

function shouldShowProgress(
    transfer: PreparedSftpTransfer,
): boolean {
    return (
        transfer.status === "running" ||
        transfer.status === "waiting-for-conflict" ||
        transfer.status === "cancelling" ||
        transfer.status === "completed" ||
        transfer.status === "completed-with-errors" ||
        (
            (
                transfer.status === "failed" ||
                transfer.status === "cancelled"
            ) &&
            transfer.transferredBytes > 0
        )
    );
}

export function SftpTransferPanel({
    transfers,
    onCancel,
    onDismiss,
    onClear,
}: SftpTransferPanelProps) {
    if (transfers.length === 0) {
        return null;
    }

    const hasFinishedTransfers =
        transfers.some(
            (transfer) =>
                transfer.status !==
                "running" &&
                transfer.status !==
                "cancelling" &&
                transfer.status !==
                "prepared",
        );

    return (
        <section className="sftp-transfer-plan-panel">
            <header className="sftp-transfer-plan-panel__header">
                <div>
                    <Files
                        size={15}
                        aria-hidden="true"
                    />

                    <strong>
                        SFTP Transfers
                    </strong>

                    <span>
                        {transfers.length}
                    </span>
                </div>

                {hasFinishedTransfers && (
                    <button
                        type="button"
                        onClick={onClear}
                    >
                        Clear finished
                    </button>
                )}
            </header>

            <div className="sftp-transfer-plan-list">
                {transfers.map(
                    (transfer) => {
                        const progressPercent =
                            Math.min(
                                100,
                                Math.max(
                                    0,
                                    transfer.progressPercent,
                                ),
                            );

                        const canCancel =
                            transfer.status ===
                            "running" ||
                            transfer.status ===
                            "waiting-for-conflict" ||
                            transfer.status ===
                            "prepared";

                        const showProgress =
                            shouldShowProgress(
                                transfer,
                            );

                        return (
                            <article
                                key={
                                    transfer.id
                                }
                                className={
                                    `sftp-transfer-plan ` +
                                    `sftp-transfer-plan--${transfer.status}`
                                }
                            >
                                <span className="sftp-transfer-plan__status-icon">
                                    {getStatusIcon(
                                        transfer,
                                    )}
                                </span>

                                <div className="sftp-transfer-plan__content">
                                    <div className="sftp-transfer-plan__title-row">
                                        <strong>
                                            {transfer.title}
                                        </strong>

                                        <span>
                                            {getStatusLabel(
                                                transfer,
                                            )}
                                        </span>
                                    </div>

                                    <div className="sftp-transfer-plan__route">
                                        <span
                                            title={
                                                getSourceLabel(
                                                    transfer,
                                                )
                                            }
                                        >
                                            {getSourceLabel(
                                                transfer,
                                            )}
                                        </span>

                                        <ArrowRight
                                            size={13}
                                            aria-hidden="true"
                                        />

                                        <span
                                            title={
                                                getDestinationLabel(
                                                    transfer,
                                                )
                                            }
                                        >
                                            {getDestinationLabel(
                                                transfer,
                                            )}
                                        </span>
                                    </div>

                                    {showProgress && (
                                        <div className="sftp-transfer-progress">
                                            <div
                                                className="sftp-transfer-progress__track"
                                                role="progressbar"
                                                aria-label={`Copying ${transfer.title}`}
                                                aria-valuemin={0}
                                                aria-valuemax={100}
                                                aria-valuenow={
                                                    Math.round(
                                                        progressPercent,
                                                    )
                                                }
                                            >
                                                <span
                                                    style={{
                                                        width:
                                                            `${progressPercent}%`,
                                                    }}
                                                />
                                            </div>

                                            <div className="sftp-transfer-progress__stats">
                                                <span>
                                                    {formatBytes(
                                                        transfer.transferredBytes,
                                                    )}
                                                    {transfer.totalBytes >
                                                        0 && (
                                                            <>
                                                                {" / "}
                                                                {formatBytes(
                                                                    transfer.totalBytes,
                                                                )}
                                                            </>
                                                        )}
                                                </span>

                                                <span>
                                                    {transfer.status ===
                                                        "running"
                                                        ? formatSpeed(
                                                            transfer.bytesPerSecond,
                                                        )
                                                        : transfer.status ===
                                                            "cancelling"
                                                            ? "Stopping…"
                                                            : transfer.status ===
                                                                "waiting-for-conflict"
                                                                ? "Waiting…"
                                                                : ``}
                                                </span>

                                                <span style={{ fontSize: "10px" }}>
                                                    {Math.round(
                                                        progressPercent,
                                                    )}
                                                    %
                                                </span>
                                            </div>
                                        </div>
                                    )}

                                    <p>
                                        {transfer.message}
                                    </p>

                                    {(transfer.totalFileCount > 0 ||
                                        transfer.skippedItemCount > 0 ||
                                        transfer.failedItemCount > 0 ||
                                        transfer.skippedSymlinkCount > 0) && (
                                            <div className="sftp-transfer-plan__summary">
                                                {transfer.totalFileCount > 0 && (
                                                    <span>
                                                        {transfer.completedFileCount}/{transfer.totalFileCount} files
                                                    </span>
                                                )}

                                                {transfer.skippedItemCount > 0 && (
                                                    <span>
                                                        {transfer.skippedItemCount} skipped
                                                    </span>
                                                )}

                                                {transfer.failedItemCount > 0 && (
                                                    <span>
                                                        {transfer.failedItemCount} failed
                                                    </span>
                                                )}

                                                {transfer.skippedSymlinkCount > 0 && (
                                                    <span>
                                                        {transfer.skippedSymlinkCount} symlink{transfer.skippedSymlinkCount === 1 ? "" : "s"} ignored
                                                    </span>
                                                )}
                                            </div>
                                        )}
                                </div>

                                {canCancel && (
                                    <button
                                        type="button"
                                        className="sftp-transfer-plan__cancel"
                                        onClick={() =>
                                            onCancel(
                                                transfer.id,
                                            )
                                        }
                                        title="Cancel transfer"
                                        aria-label={`Cancel ${transfer.title}`}
                                    >
                                        <Square
                                            size={12}
                                            fill="currentColor"
                                            aria-hidden="true"
                                        />
                                    </button>
                                )}

                                {transfer.status ===
                                    "cancelling" && (
                                        <button
                                            type="button"
                                            className="sftp-transfer-plan__cancel"
                                            disabled
                                            title="Cancelling transfer"
                                            aria-label={`Cancelling ${transfer.title}`}
                                        >
                                            <LoaderCircle
                                                size={13}
                                                className="loader"
                                                aria-hidden="true"
                                            />
                                        </button>
                                    )}

                                {transfer.status !==
                                    "running" &&
                                    transfer.status !==
                                    "cancelling" &&
                                    transfer.status !==
                                    "waiting-for-conflict" &&
                                    transfer.status !==
                                    "prepared" && (
                                        <button
                                            type="button"
                                            className="sftp-transfer-plan__dismiss"
                                            onClick={() =>
                                                onDismiss(
                                                    transfer.id,
                                                )
                                            }
                                            title="Dismiss transfer"
                                            aria-label="Dismiss transfer"
                                        >
                                            <X
                                                size={14}
                                                aria-hidden="true"
                                            />
                                        </button>
                                    )}
                            </article>
                        );
                    },
                )}
            </div>
        </section>
    );
}
