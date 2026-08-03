import type {
    MouseEvent as ReactMouseEvent,
} from "react";

import {
    AlertTriangle,
    File,
    Folder,
    Replace,
    SkipForward,
    X,
} from "lucide-react";

import type {
    PendingSftpConflict,
    SftpConflictDecision,
} from "./sftp-transfer-types";

interface SftpConflictDialogProps {
    conflict:
    PendingSftpConflict |
    null;

    onDecision: (
        decision:
            SftpConflictDecision,
    ) => void;
}

function getTypeLabel(
    type:
        PendingSftpConflict["sourceType"],
): string {
    switch (type) {
        case "directory":
            return "folder";

        case "symlink":
            return "symbolic link";

        case "file":
            return "file";

        default:
            return "item";
    }
}

export function SftpConflictDialog({
    conflict,
    onDecision,
}: SftpConflictDialogProps) {
    if (!conflict) {
        return null;
    }

    const sourceIsDirectory =
        conflict.sourceType ===
        "directory";

    return (
        <div
            className="sftp-conflict-backdrop"
            role="presentation"
            onMouseDown={(
                event:
                    ReactMouseEvent<HTMLDivElement>,
            ) => {
                if (
                    event.target ===
                    event.currentTarget
                ) {
                    event.preventDefault();
                }
            }}
        >
            <section
                className="sftp-conflict-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="sftp-conflict-title"
                aria-describedby="sftp-conflict-description"
            >
                <header className="sftp-conflict-dialog__header">
                    <span className="sftp-conflict-dialog__warning">
                        <AlertTriangle
                            size={20}
                            aria-hidden="true"
                        />
                    </span>

                    <div>
                        <h2 id="sftp-conflict-title">
                            An item already exists
                        </h2>

                        <p>
                            Item {conflict.itemNumber} of {conflict.itemCount}
                        </p>
                    </div>

                    <button
                        type="button"
                        className="sftp-conflict-dialog__close"
                        onClick={() =>
                            onDecision(
                                "cancel",
                            )
                        }
                        aria-label="Cancel transfer"
                        title="Cancel transfer"
                    >
                        <X
                            size={16}
                            aria-hidden="true"
                        />
                    </button>
                </header>

                <div className="sftp-conflict-dialog__body">
                    <div className="sftp-conflict-dialog__item">
                        <span>
                            {sourceIsDirectory
                                ? (
                                    <Folder
                                        size={22}
                                        aria-hidden="true"
                                    />
                                )
                                : (
                                    <File
                                        size={22}
                                        aria-hidden="true"
                                    />
                                )}
                        </span>

                        <div>
                            <strong>
                                {conflict.entryName}
                            </strong>

                            <p id="sftp-conflict-description">
                                The destination already contains a {getTypeLabel(
                                    conflict.destinationType,
                                )} with this name.
                            </p>
                        </div>
                    </div>

                    <dl className="sftp-conflict-dialog__paths">
                        <div>
                            <dt>
                                From
                            </dt>
                            <dd title={conflict.sourcePath}>
                                <strong>
                                    {conflict.sourceLabel}
                                </strong>
                                <span>
                                    {conflict.sourcePath}
                                </span>
                            </dd>
                        </div>

                        <div>
                            <dt>
                                To
                            </dt>
                            <dd title={conflict.destinationPath}>
                                <strong>
                                    {conflict.destinationLabel}
                                </strong>
                                <span>
                                    {conflict.destinationPath}
                                </span>
                            </dd>
                        </div>
                    </dl>

                    {sourceIsDirectory &&
                        conflict.destinationType ===
                        "directory" && (
                            <p className="sftp-conflict-dialog__note">
                                Replacing a folder merges its contents. Only conflicting files inside it are replaced.
                            </p>
                        )}
                </div>

                <footer className="sftp-conflict-dialog__actions">
                    <button
                        type="button"
                        className="sftp-conflict-dialog__secondary"
                        onClick={() =>
                            onDecision(
                                "cancel",
                            )
                        }
                    >
                        Cancel transfer
                    </button>

                    <button
                        type="button"
                        className="sftp-conflict-dialog__secondary"
                        onClick={() =>
                            onDecision(
                                "skip",
                            )
                        }
                    >
                        <SkipForward
                            size={14}
                            aria-hidden="true"
                        />
                        Skip
                    </button>

                    <button
                        type="button"
                        className="sftp-conflict-dialog__secondary"
                        onClick={() =>
                            onDecision(
                                "skip-all",
                            )
                        }
                    >
                        Skip all
                    </button>

                    <button
                        type="button"
                        className="sftp-conflict-dialog__replace"
                        onClick={() =>
                            onDecision(
                                "replace",
                            )
                        }
                    >
                        <Replace
                            size={14}
                            aria-hidden="true"
                        />
                        Replace
                    </button>

                    <button
                        type="button"
                        className="sftp-conflict-dialog__replace"
                        onClick={() =>
                            onDecision(
                                "replace-all",
                            )
                        }
                    >
                        Replace all
                    </button>
                </footer>
            </section>
        </div>
    );
}
