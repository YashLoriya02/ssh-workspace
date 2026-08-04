import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
} from "react";

import {
    lstat,
    mkdir,
    readDir,
    remove,
    rename,
    type DirEntry,
} from "@tauri-apps/plugin-fs";

import {
    openPath,
    revealItemInDir,
} from "@tauri-apps/plugin-opener";

import {
    confirm as confirmDialog,
} from "@tauri-apps/plugin-dialog";

import {
    basename,
    dirname,
    join,
} from "@tauri-apps/api/path";

import {
    ArrowDown,
    ArrowLeftRight,
    ArrowUp,
    Copy,
    File,
    Folder,
    FolderOpen,
    FolderPlus,
    Info,
    Link2,
    Loader,
    Pencil,
    RefreshCw,
    Search,
    Trash2,
} from "lucide-react";

import {
    FilePaneContextMenu,
    type FilePaneContextItem,
} from "./FilePaneContextMenu";

import {
    FilePaneDetailsDialog,
} from "./FilePaneDetailsDialog";

import type {
    SftpTransferEntry,
} from "./transfers/sftp-transfer-types";

type LocalEntryType =
    | "file"
    | "directory"
    | "symlink"
    | "other";

interface LocalFileEntry {
    name: string;
    path: string;

    type: LocalEntryType;

    size: number;
    modifiedAt: number | null;
}

interface LocalContextMenuState {
    x: number;
    y: number;
    entry: LocalFileEntry | null;
}

interface LocalBreadcrumb {
    label: string;
    path: string;
}

interface LocalFileBrowserProps {
    rootPath: string;
    currentPath: string;

    refreshVersion: number;

    onPathChange: (
        path: string,
    ) => void;

    onChooseFolder:
    () => Promise<void>;

    onCopyToOtherPane: (
        entry: SftpTransferEntry,
    ) => void;

    draggedEntryPath: string | null;
    isDropEnabled: boolean;
    dropTargetDirectoryPath:
    string | null;
    paneSide: "left" | "right";

    onEntryPointerDown: (
        entry: SftpTransferEntry,
        pointer: {
            pointerId: number;
            clientX: number;
            clientY: number;
            button: number;
        },
    ) => void;
}

type LocalSortKey =
    | "name"
    | "size"
    | "modified";

type SortDirection =
    | "asc"
    | "desc";

const TYPE_SELECT_RESET_DELAY_MS =
    750;

const METADATA_CONCURRENCY =
    12;

const isWindows =
    navigator.userAgent.includes(
        "Windows",
    );

const modifiedTimeFormatter =
    new Intl.DateTimeFormat(
        undefined,
        {
            dateStyle: "medium",
            timeStyle: "short",
        },
    );

function normalizeComparablePath(
    path: string,
): string {
    const normalized =
        path.replace(
            /[\\/]+$/u,
            "",
        );

    return isWindows
        ? normalized.toLocaleLowerCase()
        : normalized;
}

function pathsAreEqual(
    firstPath: string,
    secondPath: string,
): boolean {
    return (
        normalizeComparablePath(
            firstPath,
        ) ===
        normalizeComparablePath(
            secondPath,
        )
    );
}

function getEntryType(
    entry: DirEntry,
): LocalEntryType {
    if (entry.isDirectory) {
        return "directory";
    }

    if (entry.isFile) {
        return "file";
    }

    if (entry.isSymlink) {
        return "symlink";
    }

    return "other";
}

function toTimestamp(
    value: unknown,
): number | null {
    if (value instanceof Date) {
        return value.getTime();
    }

    if (
        typeof value === "string" ||
        typeof value === "number"
    ) {
        const timestamp =
            new Date(value).getTime();

        return Number.isFinite(
            timestamp,
        )
            ? timestamp
            : null;
    }

    return null;
}

function formatFileSize(
    bytes: number,
): string {
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

    const unitIndex =
        Math.min(
            Math.floor(
                Math.log(bytes) /
                Math.log(1024),
            ),
            units.length - 1,
        );

    const value =
        bytes /
        1024 ** unitIndex;

    return (
        `${value.toFixed(
            unitIndex === 0
                ? 0
                : value >= 10
                    ? 1
                    : 2,
        )} ${units[unitIndex]}`
    );
}

function formatModifiedTime(
    timestamp: number | null,
): string {
    if (timestamp === null) {
        return "—";
    }

    return modifiedTimeFormatter
        .format(
            new Date(timestamp),
        );
}

async function mapWithConcurrency<
    Input,
    Output,
>(
    items: readonly Input[],
    concurrency: number,
    mapper: (
        item: Input,
        index: number,
    ) => Promise<Output>,
): Promise<Output[]> {
    const results =
        new Array<Output>(
            items.length,
        );

    let nextIndex = 0;

    async function worker():
        Promise<void> {
        while (true) {
            const currentIndex =
                nextIndex;

            nextIndex += 1;

            if (
                currentIndex >=
                items.length
            ) {
                return;
            }

            results[currentIndex] =
                await mapper(
                    items[currentIndex]!,
                    currentIndex,
                );
        }
    }

    const workerCount =
        Math.min(
            concurrency,
            items.length,
        );

    await Promise.all(
        Array.from(
            {
                length:
                    workerCount,
            },
            () => worker(),
        ),
    );

    return results;
}

async function buildBreadcrumbs(
    rootPath: string,
    currentPath: string,
): Promise<LocalBreadcrumb[]> {
    const reversedBreadcrumbs:
        LocalBreadcrumb[] = [];

    let cursor =
        currentPath;

    /*
     * Safety limit protects against an unexpected
     * platform path result causing an infinite loop.
     */
    for (
        let depth = 0;
        depth < 256;
        depth += 1
    ) {
        const name =
            await basename(
                cursor,
            );

        reversedBreadcrumbs.push({
            label:
                name ||
                cursor,

            path:
                cursor,
        });

        if (
            pathsAreEqual(
                cursor,
                rootPath,
            )
        ) {
            break;
        }

        const parent =
            await dirname(
                cursor,
            );

        if (
            pathsAreEqual(
                parent,
                cursor,
            )
        ) {
            break;
        }

        cursor =
            parent;
    }

    return reversedBreadcrumbs
        .reverse();
}

function shouldIgnoreKeyboardTarget(
    target: EventTarget | null,
    currentTarget: HTMLElement,
): boolean {
    if (
        target === currentTarget
    ) {
        return false;
    }

    if (
        !(target instanceof Element)
    ) {
        return false;
    }

    return Boolean(
        target.closest(
            [
                "input",
                "textarea",
                "select",
                "button",
                "[contenteditable='true']",
            ].join(","),
        ),
    );
}

async function copyTextToClipboard(
    value: string,
): Promise<void> {
    await navigator.clipboard.writeText(
        value,
    );
}

function getLocalEntryTypeLabel(
    type: LocalEntryType,
): string {
    switch (type) {
        case "directory":
            return "Folder";

        case "file":
            return "File";

        case "symlink":
            return "Symbolic link";

        case "other":
        default:
            return "Other";
    }
}

function validateFolderName(
    rawName: string,
): string | null {
    const name =
        rawName.trim();

    if (!name) {
        return "Enter a folder name.";
    }

    if (
        name === "." ||
        name === ".."
    ) {
        return `"${name}" cannot be used as a folder name.`;
    }

    if (
        /[<>:"/\\|?*\u0000-\u001F]/u
            .test(name)
    ) {
        return "The folder name contains an unsupported character.";
    }

    if (
        name.endsWith(".") ||
        name.endsWith(" ")
    ) {
        return "The folder name cannot end with a period or space.";
    }

    return null;
}

function getEntryIcon(
    entry: LocalFileEntry,
) {
    switch (entry.type) {
        case "directory":
            return (
                <Folder
                    size={15}
                />
            );

        case "symlink":
            return (
                <Link2
                    size={15}
                />
            );

        case "file":
        case "other":
        default:
            return (
                <File
                    size={15}
                />
            );
    }
}

export function LocalFileBrowser({
    rootPath,
    currentPath,
    refreshVersion,
    onPathChange,
    onChooseFolder,
    onCopyToOtherPane,
    draggedEntryPath,
    isDropEnabled,
    dropTargetDirectoryPath,
    paneSide,
    onEntryPointerDown,
}: LocalFileBrowserProps) {
    const [
        entries,
        setEntries,
    ] = useState<
        LocalFileEntry[]
    >([]);

    const [
        breadcrumbs,
        setBreadcrumbs,
    ] = useState<
        LocalBreadcrumb[]
    >([]);

    const [
        loading,
        setLoading,
    ] = useState(true);

    const [
        isMutating,
        setIsMutating,
    ] = useState(false);

    const [
        errorMessage,
        setErrorMessage,
    ] = useState("");

    const [
        selectedPath,
        setSelectedPath,
    ] = useState<
        string | null
    >(null);

    const [
        contextMenu,
        setContextMenu,
    ] = useState<
        LocalContextMenuState | null
    >(null);

    const [
        detailsEntry,
        setDetailsEntry,
    ] = useState<
        LocalFileEntry | null
    >(null);

    const [
        toastMessage,
        setToastMessage,
    ] = useState("");

    const [
        sortKey,
        setSortKey,
    ] = useState<
        LocalSortKey
    >("name");

    const [
        sortDirection,
        setSortDirection,
    ] = useState<
        SortDirection
    >("asc");

    const listContainerRef =
        useRef<
            HTMLDivElement | null
        >(null);

    const rowRefs =
        useRef<
            Map<
                string,
                HTMLTableRowElement
            >
        >(
            new Map(),
        );

    const latestRequestRef =
        useRef(0);

    const typeSelectBufferRef =
        useRef("");

    const typeSelectTimerRef =
        useRef<
            ReturnType<
                typeof setTimeout
            > |
            null
        >(null);

    const toastTimerRef =
        useRef<
            ReturnType<
                typeof setTimeout
            > |
            null
        >(null);

    const sortedEntries =
        useMemo(
            () => {
                const directionMultiplier =
                    sortDirection ===
                        "asc"
                        ? 1
                        : -1;

                return [
                    ...entries,
                ].sort(
                    (
                        first,
                        second,
                    ) => {
                        const firstDirectory =
                            first.type ===
                            "directory";

                        const secondDirectory =
                            second.type ===
                            "directory";

                        if (
                            firstDirectory !==
                            secondDirectory
                        ) {
                            return firstDirectory
                                ? -1
                                : 1;
                        }

                        if (
                            sortKey ===
                            "size"
                        ) {
                            return (
                                directionMultiplier *
                                (
                                    first.size -
                                    second.size
                                )
                            );
                        }

                        if (
                            sortKey ===
                            "modified"
                        ) {
                            return (
                                directionMultiplier *
                                (
                                    (
                                        first.modifiedAt ??
                                        0
                                    ) -
                                    (
                                        second.modifiedAt ??
                                        0
                                    )
                                )
                            );
                        }

                        return (
                            directionMultiplier *
                            first.name.localeCompare(
                                second.name,
                                undefined,
                                {
                                    numeric:
                                        true,

                                    sensitivity:
                                        "base",
                                },
                            )
                        );
                    },
                );
            },
            [
                entries,
                sortDirection,
                sortKey,
            ],
        );

    const loadDirectory =
        useCallback(
            async (): Promise<void> => {
                const requestVersion =
                    latestRequestRef
                        .current +
                    1;

                latestRequestRef.current =
                    requestVersion;

                setLoading(true);
                setErrorMessage("");
                setSelectedPath(null);

                try {
                    const directoryEntries =
                        await readDir(
                            currentPath,
                        );

                    const loadedEntries =
                        await mapWithConcurrency(
                            directoryEntries,
                            METADATA_CONCURRENCY,
                            async (
                                entry,
                            ) => {
                                const fullPath =
                                    await join(
                                        currentPath,
                                        entry.name,
                                    );

                                let metadata:
                                    Awaited<
                                        ReturnType<
                                            typeof lstat
                                        >
                                    > |
                                    null =
                                    null;

                                try {
                                    metadata =
                                        await lstat(
                                            fullPath,
                                        );
                                } catch {
                                    /*
                                     * Keep the entry visible when metadata
                                     * cannot be read due to permissions.
                                     */
                                }

                                return {
                                    name:
                                        entry.name,

                                    path:
                                        fullPath,

                                    type:
                                        getEntryType(
                                            entry,
                                        ),

                                    size:
                                        entry.isFile
                                            ? (
                                                metadata
                                                    ?.size ??
                                                0
                                            )
                                            : 0,

                                    modifiedAt:
                                        toTimestamp(
                                            metadata
                                                ?.mtime,
                                        ),
                                };
                            },
                        );

                    if (
                        latestRequestRef
                            .current !==
                        requestVersion
                    ) {
                        return;
                    }

                    setEntries(
                        loadedEntries,
                    );
                } catch (error) {
                    if (
                        latestRequestRef
                            .current !==
                        requestVersion
                    ) {
                        return;
                    }

                    setEntries([]);

                    setErrorMessage(
                        error instanceof
                            Error
                            ? error.message
                            : String(
                                error,
                            ),
                    );
                } finally {
                    if (
                        latestRequestRef
                            .current ===
                        requestVersion
                    ) {
                        setLoading(
                            false,
                        );
                    }
                }
            },
            [
                currentPath,
            ],
        );

    useEffect(() => {
        void loadDirectory();
    }, [
        loadDirectory,
        refreshVersion,
    ]);

    useEffect(() => {
        let disposed =
            false;

        void buildBreadcrumbs(
            rootPath,
            currentPath,
        )
            .then(
                (
                    nextBreadcrumbs,
                ) => {
                    if (!disposed) {
                        setBreadcrumbs(
                            nextBreadcrumbs,
                        );
                    }
                },
            )
            .catch(
                (
                    error:
                        unknown,
                ) => {
                    if (!disposed) {
                        setErrorMessage(
                            error instanceof
                                Error
                                ? error.message
                                : String(
                                    error,
                                ),
                        );
                    }
                },
            );

        return () => {
            disposed =
                true;
        };
    }, [
        currentPath,
        rootPath,
    ]);

    useEffect(() => {
        return () => {
            if (
                typeSelectTimerRef
                    .current
            ) {
                clearTimeout(
                    typeSelectTimerRef
                        .current,
                );
            }

            if (
                toastTimerRef.current
            ) {
                clearTimeout(
                    toastTimerRef.current,
                );
            }

            rowRefs.current.clear();
        };
    }, []);

    function showToast(
        message: string,
    ): void {
        if (toastTimerRef.current) {
            clearTimeout(
                toastTimerRef.current,
            );
        }

        setToastMessage(message);

        toastTimerRef.current =
            setTimeout(() => {
                setToastMessage("");
                toastTimerRef.current =
                    null;
            }, 2_500);
    }

    function handleSort(
        nextSortKey:
            LocalSortKey,
    ): void {
        if (
            nextSortKey ===
            sortKey
        ) {
            setSortDirection(
                (
                    currentDirection,
                ) =>
                    currentDirection ===
                        "asc"
                        ? "desc"
                        : "asc",
            );

            return;
        }

        setSortKey(
            nextSortKey,
        );

        setSortDirection(
            "asc",
        );
    }

    function clearTypeSelect():
        void {
        typeSelectBufferRef.current =
            "";

        if (
            typeSelectTimerRef
                .current
        ) {
            clearTimeout(
                typeSelectTimerRef
                    .current,
            );

            typeSelectTimerRef.current =
                null;
        }
    }

    function scheduleTypeSelectReset():
        void {
        if (
            typeSelectTimerRef
                .current
        ) {
            clearTimeout(
                typeSelectTimerRef
                    .current,
            );
        }

        typeSelectTimerRef.current =
            setTimeout(
                () => {
                    typeSelectBufferRef.current =
                        "";

                    typeSelectTimerRef.current =
                        null;
                },
                TYPE_SELECT_RESET_DELAY_MS,
            );
    }

    function selectAndReveal(
        entry: LocalFileEntry,
    ): void {
        setSelectedPath(
            entry.path,
        );

        window.requestAnimationFrame(
            () => {
                rowRefs.current
                    .get(entry.path)
                    ?.scrollIntoView({
                        block:
                            "nearest",

                        inline:
                            "nearest",
                    });
            },
        );
    }

    function selectByIndex(
        index: number,
    ): void {
        const entry =
            sortedEntries[index];

        if (!entry) {
            return;
        }

        selectAndReveal(
            entry,
        );
    }

    function moveSelection(
        direction: -1 | 1,
    ): void {
        if (
            sortedEntries.length ===
            0
        ) {
            return;
        }

        const currentIndex =
            sortedEntries.findIndex(
                (entry) =>
                    entry.path ===
                    selectedPath,
            );

        if (
            currentIndex < 0
        ) {
            selectByIndex(
                direction > 0
                    ? 0
                    : sortedEntries
                        .length -
                    1,
            );

            return;
        }

        const nextIndex =
            Math.min(
                sortedEntries.length -
                1,

                Math.max(
                    0,
                    currentIndex +
                    direction,
                ),
            );

        selectByIndex(
            nextIndex,
        );
    }

    function findMatchingEntry(
        searchText: string,
        cycle:
            boolean,
    ): LocalFileEntry | null {
        const normalizedSearch =
            searchText
                .toLocaleLowerCase();

        const matches =
            sortedEntries.filter(
                (entry) =>
                    entry.name
                        .toLocaleLowerCase()
                        .startsWith(
                            normalizedSearch,
                        ),
            );

        if (
            matches.length ===
            0
        ) {
            return null;
        }

        if (!cycle) {
            return (
                matches[0] ??
                null
            );
        }

        const currentIndex =
            matches.findIndex(
                (entry) =>
                    entry.path ===
                    selectedPath,
            );

        return (
            matches[
            (
                currentIndex +
                1
            ) %
            matches.length
            ] ??
            null
        );
    }

    async function handleOpenEntry(
        entry: LocalFileEntry,
    ): Promise<void> {
        clearTypeSelect();
        setErrorMessage("");

        if (
            entry.type ===
            "directory"
        ) {
            onPathChange(
                entry.path,
            );

            return;
        }

        try {
            await openPath(
                entry.path,
            );
        } catch (error) {
            setErrorMessage(
                error instanceof Error
                    ? error.message
                    : `Unable to open "${entry.name}".`,
            );
        }
    }

    async function handleGoUp():
        Promise<void> {
        if (
            pathsAreEqual(
                currentPath,
                rootPath,
            )
        ) {
            return;
        }

        try {
            const parentPath =
                await dirname(
                    currentPath,
                );

            onPathChange(
                parentPath,
            );
        } catch (error) {
            setErrorMessage(
                error instanceof
                    Error
                    ? error.message
                    : String(error),
            );
        }
    }

    async function handleCreateFolder(
        parentPath: string =
            currentPath,
    ): Promise<void> {
        const enteredName =
            window.prompt(
                "New folder name",
            );

        if (
            enteredName ===
            null
        ) {
            return;
        }

        const validationError =
            validateFolderName(
                enteredName,
            );

        if (validationError) {
            setErrorMessage(
                validationError,
            );

            return;
        }

        setIsMutating(true);
        setErrorMessage("");

        try {
            const folderPath =
                await join(
                    parentPath,
                    enteredName.trim(),
                );

            await mkdir(
                folderPath,
            );

            await loadDirectory();
        } catch (error) {
            setErrorMessage(
                error instanceof
                    Error
                    ? error.message
                    : String(error),
            );
        } finally {
            setIsMutating(
                false,
            );
        }
    }

    function handleContextMenuOpen(
        event:
            ReactMouseEvent<HTMLElement>,
        entry: LocalFileEntry | null,
    ): void {
        event.preventDefault();
        event.stopPropagation();

        if (loading || isMutating) {
            return;
        }

        const estimatedWidth = 224;
        const estimatedHeight =
            entry
                ? 360
                : 250;
        const margin = 8;

        setSelectedPath(
            entry?.path ?? null,
        );

        setContextMenu({
            x: Math.max(
                margin,
                Math.min(
                    event.clientX,
                    window.innerWidth -
                    estimatedWidth -
                    margin,
                ),
            ),

            y: Math.max(
                margin,
                Math.min(
                    event.clientY,
                    window.innerHeight -
                    estimatedHeight -
                    margin,
                ),
            ),

            entry,
        });
    }

    async function handleCopyLocalPath(
        path: string,
    ): Promise<void> {
        setErrorMessage("");

        try {
            await copyTextToClipboard(
                path,
            );

            showToast(
                "Local path copied",
            );
        } catch (error) {
            setErrorMessage(
                error instanceof Error
                    ? error.message
                    : String(error),
            );
        }
    }

    function createTransferEntry(
        entry: LocalFileEntry,
    ): SftpTransferEntry {
        return {
            name: entry.name,
            path: entry.path,
            type: entry.type,
            size: entry.size,
        };
    }

    function handleCopyToOtherPane(
        entry: LocalFileEntry,
    ): void {
        onCopyToOtherPane(
            createTransferEntry(entry),
        );
    }

    function handleEntryPointerDown(
        event:
            ReactPointerEvent<HTMLTableRowElement>,
        entry: LocalFileEntry,
    ): void {
        if (
            isMutating ||
            event.button !== 0
        ) {
            return;
        }

        const target =
            event.target;

        if (
            target instanceof Element &&
            target.closest(
                "input, select, textarea, [contenteditable='true']",
            )
        ) {
            return;
        }

        setSelectedPath(entry.path);

        onEntryPointerDown(
            createTransferEntry(entry),
            {
                pointerId:
                    event.pointerId,
                clientX:
                    event.clientX,
                clientY:
                    event.clientY,
                button:
                    event.button,
            },
        );
    }

    function getLocalRowClassName(
        entry: LocalFileEntry,
    ): string {
        return [
            "local-file-row",
            selectedPath === entry.path
                ? "local-file-row--selected"
                : "",
            draggedEntryPath === entry.path
                ? "local-file-row--dragging"
                : "",
            dropTargetDirectoryPath === entry.path
                ? "local-file-row--drop-target"
                : "",
        ]
            .filter(Boolean)
            .join(" ");
    }

    async function handleRevealPath(
        path: string,
    ): Promise<void> {
        setErrorMessage("");

        try {
            await revealItemInDir(
                path,
            );
        } catch (error) {
            setErrorMessage(
                error instanceof Error
                    ? error.message
                    : String(error),
            );
        }
    }

    async function handleRenameEntry(
        entry: LocalFileEntry,
    ): Promise<void> {
        const enteredName =
            window.prompt(
                "Rename local entry",
                entry.name,
            );

        if (enteredName === null) {
            return;
        }

        const validationError =
            validateFolderName(
                enteredName,
            );

        if (validationError) {
            setErrorMessage(
                validationError,
            );
            return;
        }

        const nextName =
            enteredName.trim();

        if (nextName === entry.name) {
            return;
        }

        setIsMutating(true);
        setErrorMessage("");

        try {
            const parentPath =
                await dirname(
                    entry.path,
                );

            const destinationPath =
                await join(
                    parentPath,
                    nextName,
                );

            await rename(
                entry.path,
                destinationPath,
            );

            setSelectedPath(null);
            await loadDirectory();

            showToast(
                `Renamed to ${nextName}`,
            );
        } catch (error) {
            setErrorMessage(
                error instanceof Error
                    ? error.message
                    : String(error),
            );
        } finally {
            setIsMutating(false);
        }
    }

    async function handleDeleteEntry(
        entry: LocalFileEntry,
    ): Promise<void> {
        const isDirectory =
            entry.type === "directory";

        const confirmed =
            await confirmDialog(
                [
                    isDirectory
                        ? `Delete folder "${entry.name}" and all of its contents?`
                        : `Delete "${entry.name}"?`,
                    "",
                    "This action cannot be undone.",
                    "",
                    entry.path,
                ].join("\n"),
            );

        if (!confirmed) {
            return;
        }

        setIsMutating(true);
        setErrorMessage("");

        try {
            await remove(
                entry.path,
                {
                    recursive:
                        isDirectory,
                },
            );

            setSelectedPath(null);
            await loadDirectory();

            showToast(
                isDirectory
                    ? `Deleted folder ${entry.name}`
                    : `Deleted ${entry.name}`,
            );
        } catch (error) {
            setErrorMessage(
                error instanceof Error
                    ? error.message
                    : String(error),
            );
        } finally {
            setIsMutating(false);
        }
    }

    function handleKeyDown(
        event:
            ReactKeyboardEvent<HTMLDivElement>,
    ): void {
        if (
            event.defaultPrevented ||
            event.nativeEvent
                .isComposing ||
            event.ctrlKey ||
            event.metaKey ||
            event.altKey
        ) {
            return;
        }

        if (
            shouldIgnoreKeyboardTarget(
                event.target,
                event.currentTarget,
            )
        ) {
            return;
        }

        if (
            event.key ===
            "ArrowDown"
        ) {
            event.preventDefault();

            moveSelection(1);
            return;
        }

        if (
            event.key ===
            "ArrowUp"
        ) {
            event.preventDefault();

            moveSelection(-1);
            return;
        }

        if (
            event.key ===
            "Home"
        ) {
            event.preventDefault();

            selectByIndex(0);
            return;
        }

        if (
            event.key ===
            "End"
        ) {
            event.preventDefault();

            selectByIndex(
                sortedEntries.length -
                1,
            );

            return;
        }

        if (
            event.key ===
            "Backspace"
        ) {
            event.preventDefault();

            void handleGoUp();
            return;
        }

        if (
            event.key ===
            "Enter"
        ) {
            const selectedEntry =
                sortedEntries.find(
                    (entry) =>
                        entry.path ===
                        selectedPath,
                );

            if (
                selectedEntry
            ) {
                event.preventDefault();

                void handleOpenEntry(
                    selectedEntry,
                );
            }

            return;
        }

        if (
            event.key.length !==
            1 ||
            /\s/u.test(
                event.key,
            )
        ) {
            return;
        }

        const typedCharacter =
            event.key
                .toLocaleLowerCase();

        const previousBuffer =
            typeSelectBufferRef
                .current;

        const cycle =
            previousBuffer.length ===
            1 &&
            previousBuffer ===
            typedCharacter;

        let nextBuffer =
            cycle
                ? typedCharacter
                : previousBuffer +
                typedCharacter;

        let matchingEntry =
            findMatchingEntry(
                nextBuffer,
                cycle,
            );

        if (
            !matchingEntry &&
            nextBuffer.length > 1
        ) {
            nextBuffer =
                typedCharacter;

            matchingEntry =
                findMatchingEntry(
                    nextBuffer,
                    false,
                );
        }

        typeSelectBufferRef.current =
            nextBuffer;

        scheduleTypeSelectReset();

        if (!matchingEntry) {
            return;
        }

        event.preventDefault();

        selectAndReveal(
            matchingEntry,
        );
    }

    const canGoUp =
        !pathsAreEqual(
            currentPath,
            rootPath,
        );

    const contextMenuItems:
        FilePaneContextItem[] =
        contextMenu?.entry
            ? [
                {
                    type: "action",
                    id: "open",
                    label: "Open",
                    icon: contextMenu.entry.type ===
                        "directory"
                        ? (
                            <FolderOpen size={15} />
                        )
                        : (
                            <File size={15} />
                        ),
                    onSelect: () => {
                        void handleOpenEntry(
                            contextMenu.entry!,
                        );
                    },
                },
                ...(contextMenu.entry.type ===
                    "directory"
                    ? [
                        {
                            type: "action" as const,
                            id: "new-folder",
                            label: "New Folder",
                            icon: (
                                <FolderPlus size={15} />
                            ),
                            onSelect: () =>
                                handleCreateFolder(
                                    contextMenu.entry!.path,
                                ),
                        },
                    ]
                    : []),
                {
                    type: "action",
                    id: "copy-other-pane",
                    label: "Copy to Other Pane",
                    icon: (
                        <ArrowLeftRight size={15} />
                    ),
                    onSelect: () =>
                        handleCopyToOtherPane(
                            contextMenu.entry!,
                        ),
                    hint: "Plan",
                },
                {
                    type: "separator",
                    id: "manage-separator",
                },
                {
                    type: "action",
                    id: "rename",
                    label: "Rename",
                    icon: (
                        <Pencil size={15} />
                    ),
                    onSelect: () =>
                        handleRenameEntry(
                            contextMenu.entry!,
                        ),
                },
                {
                    type: "action",
                    id: "delete",
                    label: "Delete",
                    icon: (
                        <Trash2 size={15} />
                    ),
                    onSelect: () =>
                        handleDeleteEntry(
                            contextMenu.entry!,
                        ),
                    danger: true,
                },
                {
                    type: "separator",
                    id: "info-separator",
                },
                {
                    type: "action",
                    id: "copy-path",
                    label: "Copy Local Path",
                    icon: (
                        <Copy size={15} />
                    ),
                    onSelect: () =>
                        handleCopyLocalPath(
                            contextMenu.entry!.path,
                        ),
                },
                {
                    type: "action",
                    id: "reveal",
                    label: "Reveal in File Explorer",
                    icon: (
                        <Search size={15} />
                    ),
                    onSelect: () =>
                        handleRevealPath(
                            contextMenu.entry!.path,
                        ),
                },
                {
                    type: "action",
                    id: "details",
                    label: "Details",
                    icon: (
                        <Info size={15} />
                    ),
                    onSelect: () =>
                        setDetailsEntry(
                            contextMenu.entry,
                        ),
                },
            ]
            : [
                {
                    type: "action",
                    id: "new-folder",
                    label: "New Folder",
                    icon: (
                        <FolderPlus size={15} />
                    ),
                    onSelect: () =>
                        handleCreateFolder(),
                },
                {
                    type: "action",
                    id: "choose-folder",
                    label: "Choose Folder",
                    icon: (
                        <FolderOpen size={15} />
                    ),
                    onSelect:
                        onChooseFolder,
                },
                {
                    type: "action",
                    id: "refresh",
                    label: "Refresh",
                    icon: (
                        <RefreshCw size={15} />
                    ),
                    onSelect:
                        loadDirectory,
                },
                {
                    type: "separator",
                    id: "path-separator",
                },
                {
                    type: "action",
                    id: "copy-path",
                    label: "Copy Current Path",
                    icon: (
                        <Copy size={15} />
                    ),
                    onSelect: () =>
                        handleCopyLocalPath(
                            currentPath,
                        ),
                },
                {
                    type: "action",
                    id: "reveal",
                    label: "Reveal in File Explorer",
                    icon: (
                        <Search size={15} />
                    ),
                    onSelect: () =>
                        handleRevealPath(
                            currentPath,
                        ),
                },
            ];

    return (
        <section className="local-file-browser">
            <div className="local-file-browser__toolbar">
                <button
                    type="button"
                    className="sftp-pane__icon-button"
                    onClick={() => {
                        void handleGoUp();
                    }}
                    disabled={
                        !canGoUp ||
                        loading
                    }
                    title="Go to parent folder"
                    aria-label="Go to parent folder"
                >
                    <ArrowUp
                        size={15}
                        aria-hidden="true"
                    />
                </button>

                <div
                    className="local-current-path"
                    title={
                        currentPath
                    }
                >
                    {currentPath}
                </div>

                <button
                    type="button"
                    className="local-create-folder-button"
                    onClick={() => {
                        void handleCreateFolder();
                    }}
                    disabled={
                        loading ||
                        isMutating
                    }
                >
                    <FolderPlus
                        size={14}
                        aria-hidden="true"
                    />

                    <span>
                        {isMutating
                            ? "Creating…"
                            : "New folder"}
                    </span>
                </button>

                <button
                    type="button"
                    className="local-change-root-button"
                    onClick={() => {
                        void onChooseFolder();
                    }}
                    disabled={
                        loading
                    }
                >
                    Choose folder
                </button>
            </div>

            <nav
                className="local-breadcrumbs"
                aria-label="Local folder path"
            >
                {breadcrumbs.map(
                    (
                        breadcrumb,
                        index,
                    ) => (
                        <span
                            key={
                                breadcrumb.path
                            }
                            className="local-breadcrumb"
                        >
                            {index > 0 && (
                                <span className="local-breadcrumb__separator">
                                    /
                                </span>
                            )}

                            <button
                                type="button"
                                onClick={() =>
                                    onPathChange(
                                        breadcrumb.path,
                                    )
                                }
                                disabled={
                                    loading
                                }
                                title={
                                    breadcrumb.path
                                }
                            >
                                {breadcrumb.label}
                            </button>
                        </span>
                    ),
                )}
            </nav>

            {errorMessage && (
                <div className="local-file-browser__error">
                    {errorMessage}
                </div>
            )}

            <div
                ref={
                    listContainerRef
                }
                className="local-file-list-container"
                tabIndex={0}
                role="region"
                aria-label="Local files and folders"
                onKeyDown={
                    handleKeyDown
                }
                onContextMenu={(event) =>
                    handleContextMenuOpen(
                        event,
                        null,
                    )
                }
            >
                {loading ? (
                    <div className="local-file-browser__empty">
                        <Loader
                            className="loader"
                            size={20}
                        />

                        Loading local folder…
                    </div>
                ) : sortedEntries.length ===
                    0 ? (
                    <div className="local-file-browser__empty">
                        <Folder
                            size={24}
                        />

                        This folder is empty.
                    </div>
                ) : (
                    <table className="local-file-list">
                        <thead>
                            <tr>
                                <th>
                                    <button
                                        type="button"
                                        className="local-sort-button"
                                        onClick={() =>
                                            handleSort(
                                                "name",
                                            )
                                        }
                                    >
                                        Name

                                        {sortKey ===
                                            "name" &&
                                            (
                                                sortDirection ===
                                                    "asc"
                                                    ? (
                                                        <ArrowUp
                                                            size={12}
                                                        />
                                                    )
                                                    : (
                                                        <ArrowDown
                                                            size={12}
                                                        />
                                                    )
                                            )}
                                    </button>
                                </th>

                                <th>
                                    <button
                                        type="button"
                                        className="local-sort-button"
                                        onClick={() =>
                                            handleSort(
                                                "size",
                                            )
                                        }
                                    >
                                        Size

                                        {sortKey ===
                                            "size" &&
                                            (
                                                sortDirection ===
                                                    "asc"
                                                    ? (
                                                        <ArrowUp
                                                            size={12}
                                                        />
                                                    )
                                                    : (
                                                        <ArrowDown
                                                            size={12}
                                                        />
                                                    )
                                            )}
                                    </button>
                                </th>

                                <th>
                                    <button
                                        type="button"
                                        className="local-sort-button"
                                        onClick={() =>
                                            handleSort(
                                                "modified",
                                            )
                                        }
                                    >
                                        Modified

                                        {sortKey ===
                                            "modified" &&
                                            (
                                                sortDirection ===
                                                    "asc"
                                                    ? (
                                                        <ArrowUp
                                                            size={12}
                                                        />
                                                    )
                                                    : (
                                                        <ArrowDown
                                                            size={12}
                                                        />
                                                    )
                                            )}
                                    </button>
                                </th>
                            </tr>
                        </thead>

                        <tbody>
                            {sortedEntries.map(
                                (
                                    entry,
                                ) => (
                                    <tr
                                        key={
                                            entry.path
                                        }
                                        ref={(
                                            element,
                                        ) => {
                                            if (
                                                element
                                            ) {
                                                rowRefs.current.set(
                                                    entry.path,
                                                    element,
                                                );
                                            } else {
                                                rowRefs.current.delete(
                                                    entry.path,
                                                );
                                            }
                                        }}
                                        className={
                                            getLocalRowClassName(
                                                entry,
                                            )
                                        }
                                        aria-grabbed={
                                            draggedEntryPath ===
                                            entry.path
                                        }
                                        data-sftp-pane-side={
                                            paneSide
                                        }
                                        data-sftp-drop-directory={
                                            isDropEnabled &&
                                                entry.type ===
                                                "directory"
                                                ? entry.path
                                                : undefined
                                        }
                                        onPointerDown={(
                                            event,
                                        ) =>
                                            handleEntryPointerDown(
                                                event,
                                                entry,
                                            )
                                        }
                                        onClick={() => {
                                            setSelectedPath(
                                                entry.path,
                                            );

                                            listContainerRef
                                                .current
                                                ?.focus({
                                                    preventScroll:
                                                        true,
                                                });
                                        }}
                                        onDoubleClick={() => {
                                            void handleOpenEntry(
                                                entry,
                                            );
                                        }}
                                        onContextMenu={(event) =>
                                            handleContextMenuOpen(
                                                event,
                                                entry,
                                            )
                                        }
                                    >
                                        <td>
                                            <span
                                                className={
                                                    `local-file-entry-icon ` +
                                                    `local-file-entry-icon--${entry.type}`
                                                }
                                            >
                                                {getEntryIcon(
                                                    entry,
                                                )}
                                            </span>

                                            <span
                                                className="local-file-entry-name"
                                                title={
                                                    entry.name
                                                }
                                            >
                                                {entry.name}
                                            </span>
                                        </td>

                                        <td>
                                            {entry.type ===
                                                "directory"
                                                ? "—"
                                                : formatFileSize(
                                                    entry.size,
                                                )}
                                        </td>

                                        <td>
                                            {formatModifiedTime(
                                                entry.modifiedAt,
                                            )}
                                        </td>
                                    </tr>
                                ),
                            )}
                        </tbody>
                    </table>
                )}
            </div>

            <footer className="local-file-browser__status">
                <span>
                    {entries.length}
                    {" "}
                    {entries.length === 1
                        ? "item"
                        : "items"}
                </span>

                {selectedPath && (
                    <span
                        title={
                            selectedPath
                        }
                    >
                        {selectedPath}
                    </span>
                )}
            </footer>

            {contextMenu && (
                <FilePaneContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    ariaLabel="Local file actions"
                    items={
                        contextMenuItems
                    }
                    onClose={() =>
                        setContextMenu(null)
                    }
                />
            )}

            {detailsEntry && (
                <FilePaneDetailsDialog
                    subtitle={
                        detailsEntry.name
                    }
                    fields={[
                        {
                            label: "Name",
                            value:
                                detailsEntry.name,
                        },
                        {
                            label: "Type",
                            value:
                                getLocalEntryTypeLabel(
                                    detailsEntry.type,
                                ),
                        },
                        {
                            label: "Local path",
                            value:
                                detailsEntry.path,
                            path: true,
                        },
                        {
                            label: "Size",
                            value:
                                detailsEntry.type ===
                                    "directory"
                                    ? "—"
                                    : `${formatFileSize(detailsEntry.size)} · ${detailsEntry.size.toLocaleString()} bytes`,
                        },
                        {
                            label: "Modified",
                            value:
                                formatModifiedTime(
                                    detailsEntry.modifiedAt,
                                ),
                        },
                    ]}
                    onClose={() =>
                        setDetailsEntry(null)
                    }
                />
            )}

            {toastMessage && (
                <div
                    className="file-explorer-toast"
                    role="status"
                >
                    {toastMessage}
                </div>
            )}
        </section>
    );
}