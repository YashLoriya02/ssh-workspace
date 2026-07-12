import {
    useState,
} from "react";

import {
    AlertTriangle,
    Loader,
    RefreshCcw,
    Save,
} from "lucide-react";

import type {
    RemoteEditorConflict,
    RemoteTextEditorTab,
} from "./editor-types";

import {
    isRemoteEditorTabDirty,
} from "./editor-types";

import {
    RemoteCodeEditor,
} from "./RemoteCodeEditor";

interface RemoteEditorWorkspaceProps {
    tab:
    RemoteTextEditorTab |
    null;

    conflict:
    RemoteEditorConflict |
    null;

    isVisible: boolean;
    isSessionActive: boolean;

    onChange: (
        value: string,
    ) => void;

    onSave: () => Promise<void>;

    onReload: () => Promise<void>;

    onRetry: () => Promise<void>;

    onSaveConflictAnyway:
    () => Promise<void>;

    onReloadConflict:
    () => Promise<void>;

    onCancelConflict:
    () => void;
}

function formatEditorFileSize(
    bytes: number,
): string {
    if (bytes < 1_024) {
        return `${bytes} B`;
    }

    if (
        bytes <
        1_024 * 1_024
    ) {
        return `${(
            bytes / 1_024
        ).toFixed(1)} KB`;
    }

    return `${(
        bytes /
        (
            1_024 *
            1_024
        )
    ).toFixed(1)} MB`;
}

export function RemoteEditorWorkspace({
    tab,
    conflict,
    isVisible,
    isSessionActive,
    onChange,
    onSave,
    onReload,
    // onRetry,
    onSaveConflictAnyway,
    onReloadConflict,
    onCancelConflict,
}: RemoteEditorWorkspaceProps) {
    const [
        cursor,
        setCursor,
    ] = useState({
        line: 1,
        column: 1,
    });

    const dirty =
        tab
            ? isRemoteEditorTabDirty(
                tab,
            )
            : false;

    return (
        <>
            <section
                className={
                    isVisible
                        ? "remote-editor-panel"
                        : "remote-editor-panel remote-editor-panel--hidden"
                }
            >
                {tab ? (
                    <>
                        <header className="remote-editor-toolbar">
                            <div className="remote-editor-toolbar__file">
                                <strong>
                                    {tab.name}

                                    {dirty && (
                                        <span
                                            className="remote-editor-dirty-dot"
                                            title="Unsaved changes"
                                        >
                                            •
                                        </span>
                                    )}
                                </strong>

                                <span title={tab.path}>
                                    {tab.path}
                                </span>
                            </div>

                            <div className="remote-editor-toolbar__actions">
                                {tab.readOnly && (
                                    <span className="remote-editor-readonly">
                                        Read only
                                    </span>
                                )}

                                <button
                                    type="button"
                                    className="remote-editor-toolbar-button"
                                    disabled={
                                        tab.status ===
                                        "loading" ||
                                        tab.isReloading ||
                                        tab.isSaving
                                    }
                                    onClick={() =>
                                        void onReload()
                                    }
                                    title="Reload from remote"
                                >
                                    {tab.isReloading ? (
                                        <Loader
                                            size={14}
                                            className="loader"
                                        />
                                    ) : (
                                        <RefreshCcw
                                            size={14}
                                        />
                                    )}

                                    Reload
                                </button>

                                <button
                                    type="button"
                                    className="remote-editor-save-button"
                                    disabled={
                                        tab.status !==
                                        "ready" ||
                                        tab.readOnly ||
                                        tab.isSaving ||
                                        !dirty
                                    }
                                    onClick={() =>
                                        void onSave()
                                    }
                                    title="Save remote file (Ctrl/Cmd + S)"
                                >
                                    {tab.isSaving ? (
                                        <Loader
                                            size={14}
                                            className="loader"
                                        />
                                    ) : (
                                        <Save
                                            size={14}
                                        />
                                    )}

                                    {tab.isSaving
                                        ? "Saving…"
                                        : "Save"}
                                </button>
                            </div>
                        </header>

                        {tab.error && (
                            <div className="remote-editor-error">
                                <AlertTriangle
                                    size={15}
                                />

                                <span>
                                    {tab.error}
                                </span>
                            </div>
                        )}

                        <div className="remote-editor-body">
                            {tab.status ===
                                "loading" ? (
                                <div className="remote-editor-state">
                                    <Loader className="loader" />

                                    <strong>
                                        Opening {tab.name}
                                    </strong>

                                    <span>
                                        Reading the remote file securely…
                                    </span>
                                </div>
                            ) : tab.status ===
                                "error" ? (
                                <div className="remote-editor-state">
                                    <AlertTriangle
                                        size={25}
                                    />

                                    <strong>
                                        Unable to open this file
                                    </strong>

                                    <span>
                                        {tab.error}
                                    </span>

                                    {/* <button
                                        type="button"
                                        style={{
                                            fontSize: "14px"
                                        }}
                                        onClick={() =>
                                            void onRetry()
                                        }
                                    >
                                        Try Again
                                    </button> */}
                                </div>
                            ) : (
                                <RemoteCodeEditor
                                    tab={tab}
                                    isVisible={
                                        isVisible &&
                                        isSessionActive
                                    }
                                    onChange={
                                        onChange
                                    }
                                    onSave={
                                        onSave
                                    }
                                    onCursorChange={(
                                        line,
                                        column,
                                    ) =>
                                        setCursor({
                                            line,
                                            column,
                                        })
                                    }
                                />
                            )}
                        </div>

                        <footer className="remote-editor-statusbar">
                            <span
                                className="remote-editor-statusbar__path"
                                title={tab.path}
                            >
                                {tab.path}
                            </span>

                            <div className="remote-editor-statusbar__details">
                                <span>
                                    Ln {cursor.line},
                                    Col{" "}
                                    {cursor.column}
                                </span>

                                <span>
                                    UTF-8
                                </span>

                                <span>
                                    {tab.language}
                                </span>

                                <span>
                                    {tab.permissions ??
                                        "—"}
                                </span>

                                <span>
                                    {formatEditorFileSize(
                                        tab.size,
                                    )}
                                </span>

                                <span>
                                    {dirty
                                        ? "Modified"
                                        : "Saved"}
                                </span>
                            </div>
                        </footer>
                    </>
                ) : (
                    <div className="remote-editor-state">
                        No editor tab selected.
                    </div>
                )}
            </section>

            {conflict && (
                <div className="remote-dialog-backdrop">
                    <section
                        className="remote-dialog remote-dialog--small"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="remote-conflict-title"
                    >
                        <header className="remote-dialog__header">
                            <div>
                                <h2 id="remote-conflict-title">
                                    Remote file changed
                                </h2>

                                <p>
                                    {conflict.path}
                                </p>
                            </div>
                        </header>

                        <div className="remote-dialog__body">
                            <div className="remote-editor-conflict-message">
                                <AlertTriangle
                                    size={20}
                                />

                                <div>
                                    <strong>
                                        The remote version changed after you opened it.
                                    </strong>

                                    <p>
                                        Reload the latest remote version or overwrite it with your current editor content.
                                    </p>
                                </div>
                            </div>
                        </div>

                        <footer className="remote-dialog__actions remote-dialog__actions--spread">
                            <button
                                type="button"
                                className="secondary-button"
                                onClick={
                                    onCancelConflict
                                }
                            >
                                Cancel
                            </button>

                            <div>
                                <button
                                    type="button"
                                    className="secondary-button"
                                    onClick={() =>
                                        void onReloadConflict()
                                    }
                                >
                                    Reload Remote
                                </button>

                                <button
                                    type="button"
                                    className="danger-button"
                                    onClick={() =>
                                        void onSaveConflictAnyway()
                                    }
                                >
                                    Save Anyway
                                </button>
                            </div>
                        </footer>
                    </section>
                </div>
            )}
        </>
    );
}
