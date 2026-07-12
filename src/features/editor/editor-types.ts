export type RemoteEditorTabStatus =
    | "loading"
    | "ready"
    | "error";

export interface RemoteEditorTab {
    path: string;
    name: string;

    modelPath: string;
    language: string;

    content: string;
    savedContent: string;

    revision: string;

    encoding: "utf-8";

    size: number;
    modifiedAt: number | null;
    permissions: string | null;

    readOnly: boolean;

    status: RemoteEditorTabStatus;

    isSaving: boolean;
    isReloading: boolean;

    error: string;
}

export interface RemoteEditorConflict {
    path: string;
    message: string;
}

export interface RemoteFileChange {
    path: string;
    version: number;
}

export function isRemoteEditorTabDirty(
    tab: RemoteEditorTab,
): boolean {
    return (
        tab.status === "ready" &&
        tab.content !== tab.savedContent
    );
}
