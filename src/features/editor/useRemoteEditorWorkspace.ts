import {
    useCallback,
    useMemo,
    useRef,
    useState,
} from "react";

import {
    confirm as confirmDialog,
} from "@tauri-apps/plugin-dialog";

import {
    BackendRequestError,
    backendClient,
    type RemoteFileEntry,
    type RemoteTextFileSnapshot,
} from "../../backend/backend-client";

import {
    createEditorTabFromSnapshot,
    encodeUtf8Base64,
    getRemoteEditorLanguage,
    getRemoteEditorModelPath,
} from "./editor-utils";

import {
    isRemoteEditorTabDirty,
    type RemoteEditorConflict,
    type RemoteEditorTab,
    type RemoteFileChange,
} from "./editor-types";

interface UseRemoteEditorWorkspaceOptions {
    connectionId: string;
}

export function useRemoteEditorWorkspace({
    connectionId,
}: UseRemoteEditorWorkspaceOptions) {
    const [
        tabs,
        setTabs,
    ] = useState<
        RemoteEditorTab[]
    >([]);

    const tabsRef =
        useRef<
            RemoteEditorTab[]
        >([]);

    const [
        activePath,
        setActivePath,
    ] = useState<
        string | null
    >(null);

    const [
        view,
        setView,
    ] = useState<
        "workspace" |
        "editor"
    >("workspace");

    const [
        conflict,
        setConflict,
    ] = useState<
        RemoteEditorConflict |
        null
    >(null);

    const [
        lastSavedFileChange,
        setLastSavedFileChange,
    ] = useState<
        RemoteFileChange |
        null
    >(null);

    const changeVersionRef =
        useRef(0);

    const openingPathsRef =
        useRef(
            new Set<string>(),
        );

    const updateTabs =
        useCallback(
            (
                updater:
                    (
                        current:
                            RemoteEditorTab[],
                    ) =>
                        RemoteEditorTab[],
            ): void => {
                setTabs((current) => {
                    const next =
                        updater(current);

                    tabsRef.current =
                        next;

                    return next;
                });
            },
            [],
        );

    const activeTab =
        useMemo(
            () =>
                tabs.find(
                    (tab) =>
                        tab.path ===
                        activePath,
                ) ?? null,
            [
                tabs,
                activePath,
            ],
        );

    const openFile =
        useCallback(
            async (
                entry:
                    RemoteFileEntry,
            ): Promise<void> => {
                if (
                    entry.type !==
                    "file"
                ) {
                    return;
                }

                const existingTab =
                    tabsRef.current.find(
                        (tab) =>
                            tab.path ===
                            entry.path,
                    );

                if (existingTab) {
                    setActivePath(
                        entry.path,
                    );

                    setView(
                        "editor",
                    );

                    return;
                }

                setActivePath(
                    entry.path,
                );

                setView(
                    "editor",
                );

                if (
                    openingPathsRef
                        .current
                        .has(entry.path)
                ) {
                    return;
                }

                openingPathsRef
                    .current
                    .add(entry.path);

                const loadingTab:
                    RemoteEditorTab = {
                    path: entry.path,
                    name: entry.name,

                    modelPath:
                        getRemoteEditorModelPath(
                            connectionId,
                            entry.path,
                        ),

                    language:
                        getRemoteEditorLanguage(
                            entry.name,
                        ),

                    content: "",
                    savedContent: "",

                    revision: "",

                    encoding:
                        "utf-8",

                    size:
                        entry.size,

                    modifiedAt:
                        entry.modifiedAt,

                    permissions:
                        entry.permissions,

                    readOnly: false,

                    status:
                        "loading",

                    isSaving: false,
                    isReloading:
                        false,

                    error: "",
                };

                updateTabs(
                    (current) => [
                        ...current,
                        loadingTab,
                    ],
                );

                try {
                    const snapshot =
                        await backendClient
                            .readRemoteTextFile(
                                connectionId,
                                entry.path,
                            );

                    const loadedTab =
                        createEditorTabFromSnapshot(
                            connectionId,
                            snapshot,
                        );

                    updateTabs(
                        (current) =>
                            current.map(
                                (tab) =>
                                    tab.path ===
                                        entry.path
                                        ? loadedTab
                                        : tab,
                            ),
                    );
                } catch (error) {
                    updateTabs(
                        (current) =>
                            current.map(
                                (tab) =>
                                    tab.path ===
                                        entry.path
                                        ? {
                                            ...tab,

                                            status:
                                                "error",

                                            error:
                                                error instanceof
                                                    Error
                                                    ? error.message
                                                    : String(
                                                        error,
                                                    ),
                                        }
                                        : tab,
                            ),
                    );
                } finally {
                    openingPathsRef
                        .current
                        .delete(
                            entry.path,
                        );
                }
            },
            [
                connectionId,
                updateTabs,
            ],
        );

    const updateContent =
        useCallback(
            (
                remotePath: string,
                content: string,
            ): void => {
                updateTabs(
                    (current) =>
                        current.map(
                            (tab) =>
                                tab.path ===
                                    remotePath
                                    ? {
                                        ...tab,
                                        content,
                                        error: "",
                                    }
                                    : tab,
                        ),
                );
            },
            [updateTabs],
        );

    const loadRemoteSnapshot =
        useCallback(
            async (
                remotePath: string,
            ): Promise<
                RemoteTextFileSnapshot
            > => {
                return backendClient
                    .readRemoteTextFile(
                        connectionId,
                        remotePath,
                    );
            },
            [connectionId],
        );

    const reloadTab =
        useCallback(
            async (
                remotePath: string,
                confirmDirty:
                    boolean = true,
            ): Promise<boolean> => {
                const tab =
                    tabsRef.current.find(
                        (item) =>
                            item.path ===
                            remotePath,
                    );

                if (!tab) {
                    return false;
                }

                if (
                    confirmDirty &&
                    isRemoteEditorTabDirty(
                        tab,
                    )
                ) {
                    const confirmed =
                        await confirmDialog(
                            [
                                `"${tab.name}" has unsaved changes.`,
                                "",
                                "Reloading will discard those changes.",
                            ].join("\n"),
                            {
                                title:
                                    "Reload remote file?",

                                kind:
                                    "warning",
                            },
                        );

                    if (!confirmed) {
                        return false;
                    }
                }

                updateTabs(
                    (current) =>
                        current.map(
                            (item) =>
                                item.path ===
                                    remotePath
                                    ? {
                                        ...item,

                                        isReloading:
                                            true,

                                        error: "",
                                    }
                                    : item,
                        ),
                );

                try {
                    const snapshot =
                        await loadRemoteSnapshot(
                            remotePath,
                        );

                    const loadedTab =
                        createEditorTabFromSnapshot(
                            connectionId,
                            snapshot,
                        );

                    updateTabs(
                        (current) =>
                            current.map(
                                (item) =>
                                    item.path ===
                                        remotePath
                                        ? loadedTab
                                        : item,
                            ),
                    );

                    return true;
                } catch (error) {
                    updateTabs(
                        (current) =>
                            current.map(
                                (item) =>
                                    item.path ===
                                        remotePath
                                        ? {
                                            ...item,

                                            isReloading:
                                                false,

                                            status:
                                                item.status ===
                                                    "loading"
                                                    ? "error"
                                                    : item.status,

                                            error:
                                                error instanceof
                                                    Error
                                                    ? error.message
                                                    : String(
                                                        error,
                                                    ),
                                        }
                                        : item,
                            ),
                    );

                    return false;
                }
            },
            [
                connectionId,
                loadRemoteSnapshot,
                updateTabs,
            ],
        );

    const saveTab =
        useCallback(
            async (
                remotePath: string,
                force:
                    boolean = false,
            ): Promise<boolean> => {
                const tab =
                    tabsRef.current.find(
                        (item) =>
                            item.path ===
                            remotePath,
                    );

                if (
                    !tab ||
                    tab.status !==
                        "ready" ||
                    tab.readOnly ||
                    tab.isSaving
                ) {
                    return false;
                }

                if (
                    !force &&
                    !isRemoteEditorTabDirty(
                        tab,
                    )
                ) {
                    return true;
                }

                const contentToSave =
                    tab.content;

                updateTabs(
                    (current) =>
                        current.map(
                            (item) =>
                                item.path ===
                                    remotePath
                                    ? {
                                        ...item,

                                        isSaving:
                                            true,

                                        error: "",
                                    }
                                    : item,
                        ),
                );

                try {
                    const snapshot =
                        await backendClient
                            .saveRemoteTextFile({
                                connectionId,

                                remotePath,

                                contentBase64:
                                    encodeUtf8Base64(
                                        contentToSave,
                                    ),

                                expectedRevision:
                                    tab.revision,

                                force,
                            });

                    const savedContent =
                        createEditorTabFromSnapshot(
                            connectionId,
                            snapshot,
                        ).content;

                    updateTabs(
                        (current) =>
                            current.map(
                                (item) => {
                                    if (
                                        item.path !==
                                        remotePath
                                    ) {
                                        return item;
                                    }

                                    /*
                                     * The user may have continued typing
                                     * while the save request was running.
                                     */
                                    const contentChangedDuringSave =
                                        item.content !==
                                        contentToSave;

                                    return {
                                        ...item,

                                        content:
                                            contentChangedDuringSave
                                                ? item.content
                                                : savedContent,

                                        savedContent,

                                        revision:
                                            snapshot.revision,

                                        size:
                                            snapshot.size,

                                        modifiedAt:
                                            snapshot.modifiedAt,

                                        permissions:
                                            snapshot.permissions,

                                        readOnly:
                                            snapshot.readOnly,

                                        status:
                                            "ready",

                                        isSaving:
                                            false,

                                        error: "",
                                    };
                                },
                            ),
                    );

                    changeVersionRef
                        .current += 1;

                    setLastSavedFileChange({
                        path:
                            snapshot.path,

                        version:
                            changeVersionRef
                                .current,
                    });

                    setConflict(
                        (current) =>
                            current?.path ===
                                remotePath
                                ? null
                                : current,
                    );

                    return true;
                } catch (error) {
                    updateTabs(
                        (current) =>
                            current.map(
                                (item) =>
                                    item.path ===
                                        remotePath
                                        ? {
                                            ...item,

                                            isSaving:
                                                false,

                                            error:
                                                error instanceof
                                                    BackendRequestError &&
                                                error.code ===
                                                    "REMOTE_FILE_CHANGED"
                                                    ? ""
                                                    : error instanceof
                                                        Error
                                                        ? error.message
                                                        : String(
                                                            error,
                                                        ),
                                        }
                                        : item,
                            ),
                    );

                    if (
                        error instanceof
                            BackendRequestError &&
                        error.code ===
                            "REMOTE_FILE_CHANGED"
                    ) {
                        setActivePath(
                            remotePath,
                        );

                        setView(
                            "editor",
                        );

                        setConflict({
                            path:
                                remotePath,

                            message:
                                error.message,
                        });

                        return false;
                    }

                    return false;
                }
            },
            [
                connectionId,
                updateTabs,
            ],
        );

    const closeTab =
        useCallback(
            async (
                remotePath: string,
            ): Promise<void> => {
                const currentTabs =
                    tabsRef.current;

                const tabIndex =
                    currentTabs.findIndex(
                        (tab) =>
                            tab.path ===
                            remotePath,
                    );

                if (tabIndex < 0) {
                    return;
                }

                const tab =
                    currentTabs[
                        tabIndex
                    ];

                if (
                    isRemoteEditorTabDirty(
                        tab,
                    )
                ) {
                    const confirmed =
                        await confirmDialog(
                            [
                                `"${tab.name}" has unsaved changes.`,
                                "",
                                "Close the editor without saving?",
                            ].join("\n"),
                            {
                                title:
                                    "Discard unsaved changes?",

                                kind:
                                    "warning",
                            },
                        );

                    if (!confirmed) {
                        return;
                    }
                }

                const nextTabs =
                    currentTabs.filter(
                        (item) =>
                            item.path !==
                            remotePath,
                    );

                updateTabs(
                    () =>
                        nextTabs,
                );

                setConflict(
                    (current) =>
                        current?.path ===
                            remotePath
                            ? null
                            : current,
                );

                if (
                    activePath !==
                    remotePath
                ) {
                    return;
                }

                const nextTab =
                    nextTabs[
                        tabIndex
                    ] ??
                    nextTabs[
                        tabIndex - 1
                    ] ??
                    null;

                if (nextTab) {
                    setActivePath(
                        nextTab.path,
                    );

                    setView(
                        "editor",
                    );
                } else {
                    setActivePath(
                        null,
                    );

                    setView(
                        "workspace",
                    );
                }
            },
            [
                activePath,
                updateTabs,
            ],
        );

    const selectTab =
        useCallback(
            (
                remotePath: string,
            ): void => {
                setActivePath(
                    remotePath,
                );

                setView(
                    "editor",
                );
            },
            [],
        );

    const showWorkspace =
        useCallback((): void => {
            setView(
                "workspace",
            );
        }, []);

    const saveConflictAnyway =
        useCallback(
            async (): Promise<void> => {
                if (!conflict) {
                    return;
                }

                const saved =
                    await saveTab(
                        conflict.path,
                        true,
                    );

                if (saved) {
                    setConflict(null);
                }
            },
            [
                conflict,
                saveTab,
            ],
        );

    const reloadConflict =
        useCallback(
            async (): Promise<void> => {
                if (!conflict) {
                    return;
                }

                const reloaded =
                    await reloadTab(
                        conflict.path,
                        false,
                    );

                if (reloaded) {
                    setConflict(null);
                }
            },
            [
                conflict,
                reloadTab,
            ],
        );

    const cancelConflict =
        useCallback((): void => {
            setConflict(null);
        }, []);

    return {
        tabs,
        activeTab,
        activePath,

        view,
        conflict,

        lastSavedFileChange,

        openFile,
        updateContent,

        reloadTab,
        saveTab,
        closeTab,

        selectTab,
        showWorkspace,

        saveConflictAnyway,
        reloadConflict,
        cancelConflict,
    };
}
