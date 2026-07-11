import {
    useEffect,
    useState,
} from "react";

import {
    backendClient,
    type TransferEventPayload,
    type TransferStatus,
} from "../../backend/backend-client";
import { ArrowDown, ArrowUp } from "lucide-react";

interface TransferQueueProps {
    connectionId: string;
}

interface TransferItem
    extends TransferEventPayload { }

function formatBytes(bytes: number): string {
    if (bytes <= 0) {
        return "0 B";
    }

    const units = [
        "B",
        "KB",
        "MB",
        "GB",
        "TB",
    ];

    const index = Math.min(
        Math.floor(
            Math.log(bytes) / Math.log(1024),
        ),
        units.length - 1,
    );

    const value =
        bytes / Math.pow(1024, index);

    return `${value.toFixed(
        index === 0 ? 0 : 1,
    )} ${units[index]}`;
}

function getStatusForEvent(
    eventType: string,
): TransferStatus | null {
    switch (eventType) {
        case "transfer.started":
        case "transfer.progress":
            return "running";

        case "transfer.completed":
            return "completed";

        case "transfer.failed":
            return "failed";

        case "transfer.cancelled":
            return "cancelled";

        default:
            return null;
    }
}

export function TransferQueue({
    connectionId,
}: TransferQueueProps) {
    const [transfers, setTransfers] =
        useState<TransferItem[]>([]);

    const [cancelError, setCancelError] =
        useState("");

    useEffect(() => {
        return backendClient.subscribeToEvents(
            (event) => {
                const status =
                    getStatusForEvent(event.type);

                if (!status) {
                    return;
                }

                const payload =
                    event.payload as TransferEventPayload;

                if (
                    payload.connectionId !==
                    connectionId
                ) {
                    return;
                }

                const incomingTransfer: TransferItem = {
                    ...payload,
                    status,
                };

                setTransfers((currentTransfers) => {
                    const existing =
                        currentTransfers.find(
                            (transfer) =>
                                transfer.transferId ===
                                incomingTransfer.transferId,
                        );

                    const mergedTransfer = {
                        ...existing,
                        ...incomingTransfer,
                    };

                    return [
                        mergedTransfer,
                        ...currentTransfers.filter(
                            (transfer) =>
                                transfer.transferId !==
                                incomingTransfer.transferId,
                        ),
                    ];
                });
            },
        );
    }, [connectionId]);

    async function handleCancel(
        transferId: string,
    ): Promise<void> {
        setCancelError("");

        try {
            await backendClient.cancelTransfer(
                transferId,
            );
        } catch (error) {
            setCancelError(
                error instanceof Error
                    ? error.message
                    : String(error),
            );
        }
    }

    function clearFinished(): void {
        setTransfers((currentTransfers) =>
            currentTransfers.filter(
                (transfer) =>
                    transfer.status === "running",
            ),
        );
    }

    if (transfers.length === 0) {
        return null;
    }

    const hasFinishedTransfers =
        transfers.some(
            (transfer) =>
                transfer.status !== "running",
        );

    return (
        <section className="transfer-queue">
            <header className="transfer-queue__header">
                <div>
                    <strong>Transfers</strong>

                    <span className="transfer-count">
                        {transfers.length}
                    </span>
                </div>

                {hasFinishedTransfers && (
                    <button
                        type="button"
                        className="transfer-clear-button"
                        onClick={clearFinished}
                    >
                        Clear finished
                    </button>
                )}
            </header>

            {cancelError && (
                <div className="transfer-error">
                    {cancelError}
                </div>
            )}

            <div className="transfer-list">
                {transfers.map((transfer) => {
                    const progress =
                        transfer.totalBytes > 0
                            ? Math.min(
                                100,
                                Math.round(
                                    (
                                        transfer.transferredBytes /
                                        transfer.totalBytes
                                    ) * 100,
                                ),
                            )
                            : transfer.status ===
                                "completed"
                                ? 100
                                : 0;

                    return (
                        <article
                            key={transfer.transferId}
                            className="transfer-item"
                        >
                            <div className="transfer-item__top">
                                <div className="transfer-file">
                                    <span aria-hidden="true">
                                        {transfer.direction === "upload"
                                            ? <ArrowUp size={16} />
                                            : <ArrowDown size={16} />

                                        }
                                    </span>

                                    <span
                                        className="transfer-file__name"
                                        title={
                                            transfer.direction === "upload"
                                                ? `${transfer.localPath} → ${transfer.remotePath}`
                                                : `${transfer.remotePath} → ${transfer.localPath}`
                                        }
                                    >
                                        {transfer.name}
                                    </span>
                                </div>

                                <span
                                    className={
                                        `transfer-status ` +
                                        `transfer-status--${transfer.status}`
                                    }
                                >
                                    {transfer.status}
                                </span>
                            </div>

                            <div className="transfer-progress">
                                <div
                                    className="transfer-progress__bar"
                                    style={{
                                        width: `${progress}%`,
                                    }}
                                />
                            </div>

                            <div className="transfer-item__bottom">
                                <span>
                                    {formatBytes(
                                        transfer.transferredBytes,
                                    )}
                                    {" / "}
                                    {formatBytes(
                                        transfer.totalBytes,
                                    )}
                                    {" · "}
                                    {progress}%
                                </span>

                                {transfer.status ===
                                    "running" && (
                                        <button
                                            type="button"
                                            className="transfer-cancel-button"
                                            onClick={() =>
                                                void handleCancel(
                                                    transfer.transferId,
                                                )
                                            }
                                        >
                                            Cancel
                                        </button>
                                    )}
                            </div>

                            {transfer.message && (
                                <div className="transfer-message">
                                    {transfer.message}
                                </div>
                            )}
                        </article>
                    );
                })}
            </div>
        </section>
    );
}