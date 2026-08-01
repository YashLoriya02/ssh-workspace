import {
    X,
} from "lucide-react";

export interface FilePaneDetailField {
    label: string;
    value: string;
    path?: boolean;
}

interface FilePaneDetailsDialogProps {
    title?: string;
    subtitle: string;
    fields: readonly FilePaneDetailField[];
    error?: string;
    loading?: boolean;
    onClose: () => void;
}

export function FilePaneDetailsDialog({
    title = "Details",
    subtitle,
    fields,
    error = "",
    loading = false,
    onClose,
}: FilePaneDetailsDialogProps) {
    return (
        <div
            className="remote-dialog-backdrop"
            onMouseDown={(event) => {
                if (
                    event.target ===
                    event.currentTarget
                ) {
                    onClose();
                }
            }}
        >
            <section
                className="remote-dialog"
                role="dialog"
                aria-modal="true"
                aria-label={title}
            >
                <header className="remote-dialog__header">
                    <div>
                        <h2>
                            {title}
                        </h2>

                        <p>
                            {subtitle}
                        </p>
                    </div>

                    <button
                        type="button"
                        className="remote-dialog__close"
                        onClick={onClose}
                        aria-label="Close details"
                    >
                        <X
                            size={17}
                            aria-hidden="true"
                        />
                    </button>
                </header>

                <div className="remote-dialog__body">
                    {loading ? (
                        <div className="remote-dialog__loading">
                            Loading fresh details…
                        </div>
                    ) : (
                        <>
                            {error && (
                                <div className="remote-dialog__error">
                                    {error}
                                </div>
                            )}

                            <dl className="remote-details-grid">
                                {fields.map(
                                    (field) => (
                                        <div
                                            key={field.label}
                                            style={{
                                                display:
                                                    "contents",
                                            }}
                                        >
                                            <dt>
                                                {field.label}
                                            </dt>

                                            <dd
                                                className={
                                                    field.path
                                                        ? "remote-details-path"
                                                        : undefined
                                                }
                                            >
                                                {field.value}
                                            </dd>
                                        </div>
                                    ),
                                )}
                            </dl>
                        </>
                    )}
                </div>
            </section>
        </div>
    );
}
