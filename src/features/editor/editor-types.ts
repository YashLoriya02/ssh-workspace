import type {
    RemoteImageMimeType,
} from "../../backend/backend-client";

export type RemoteWorkspaceTabStatus =
    | "loading"
    | "ready"
    | "error";

interface RemoteWorkspaceTabBase {
    kind:
        | "text"
        | "image";

    path: string;
    name: string;

    size: number;
    modifiedAt: number | null;
    permissions: string | null;

    status: RemoteWorkspaceTabStatus;
    isReloading: boolean;

    error: string;
}

export interface RemoteTextEditorTab
    extends RemoteWorkspaceTabBase {
    kind: "text";

    modelPath: string;
    language: string;

    content: string;
    savedContent: string;

    revision: string;
    encoding: "utf-8";

    readOnly: boolean;
    isSaving: boolean;
}

export interface RemoteImageViewerTab
    extends RemoteWorkspaceTabBase {
    kind: "image";

    contentBase64: string;

    mimeType:
        | RemoteImageMimeType
        | null;

    revision: string;
}

export type RemoteWorkspaceTab =
    | RemoteTextEditorTab
    | RemoteImageViewerTab;

export interface RemoteEditorConflict {
    path: string;
    message: string;
}

export interface RemoteFileChange {
    path: string;
    version: number;
}

export function isRemoteEditorTabDirty(
    tab: RemoteWorkspaceTab,
): boolean {
    return (
        tab.kind === "text" &&
        tab.status === "ready" &&
        tab.content !==
            tab.savedContent
    );
}