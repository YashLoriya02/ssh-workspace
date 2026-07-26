import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type FormEvent,
    type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import {
    ArrowDown,
    ArrowUp,
    File,
    Folder,
    FolderPlus,
    Link2,
    Loader,
} from "lucide-react";

import {
    backendClient,
    type RemoteDirectoryListing,
    type RemoteFileEntry,
} from "../../backend/backend-client";

interface RemoteFileBrowserProps {
    connectionId: string;
    currentPath: string | null;

    refreshVersion: number;

    onPathChange: (
        path: string,
    ) => void;
}

interface RemoteBreadcrumb {
    label: string;
    path: string;
}

type RemoteSortKey =
    | "name"
    | "size"
    | "modified";

type SortDirection =
    | "asc"
    | "desc";

const TYPE_SELECT_RESET_DELAY_MS =
    750;

const modifiedTimeFormatter =
    new Intl.DateTimeFormat(
        undefined,
        {
            dateStyle: "medium",
            timeStyle: "short",
        },
    );

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

    return modifiedTimeFormatter.format(
        new Date(timestamp),
    );
}

function getRemoteParentDirectory(
    remotePath: string,
): string {
    const normalizedPath =
        remotePath.replace(
            /\/+$/u,
            "",
        );

    if (
        !normalizedPath ||
        normalizedPath === "/"
    ) {
        return "/";
    }

    const lastSlashIndex =
        normalizedPath.lastIndexOf("/");

    if (lastSlashIndex < 0) {
        return ".";
    }

    if (lastSlashIndex === 0) {
        return "/";
    }

    return normalizedPath.slice(
        0,
        lastSlashIndex,
    );
}

function joinRemotePath(
    parentPath: string,
    name: string,
): string {
    if (parentPath === "/") {
        return `/${name}`;
    }

    const normalizedParent =
        parentPath.replace(
            /\/+$/u,
            "",
        );

    return `${normalizedParent}/${name}`;
}

function buildBreadcrumbs(
    remotePath: string,
): RemoteBreadcrumb[] {
    const normalizedPath =
        remotePath.trim() || ".";

    if (normalizedPath === "/") {
        return [
            {
                label: "/",
                path: "/",
            },
        ];
    }

    const isAbsolute =
        normalizedPath.startsWith("/");

    const segments =
        normalizedPath
            .split("/")
            .filter(Boolean);

    const breadcrumbs:
        RemoteBreadcrumb[] =
        isAbsolute
            ? [
                {
                    label: "/",
                    path: "/",
                },
            ]
            : [];

    let accumulatedPath =
        isAbsolute
            ? ""
            : "";

    for (const segment of segments) {
        if (isAbsolute) {
            accumulatedPath +=
                `/${segment}`;
        } else {
            accumulatedPath =
                accumulatedPath
                    ? `${accumulatedPath}/${segment}`
                    : segment;
        }

        breadcrumbs.push({
            label: segment,
            path: accumulatedPath,
        });
    }

    return breadcrumbs;
}

function validateRemoteName(
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
        name.includes("/") ||
        name.includes("\0")
    ) {
        return "Folder names cannot contain a forward slash or null character.";
    }

    return null;
}

function shouldIgnoreKeyboardTarget(
    target: EventTarget | null,
    currentTarget: HTMLElement,
): boolean {
    if (target === currentTarget) {
        return false;
    }

    if (!(target instanceof Element)) {
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

function getEntryIcon(
    entry: RemoteFileEntry,
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

export function RemoteFileBrowser({
    connectionId,
    currentPath,
    refreshVersion,
    onPathChange,
}: RemoteFileBrowserProps) {
    const [
        listing,
        setListing,
    ] = useState<
        RemoteDirectoryListing |
        null
    >(null);

    const [
        pathInput,
        setPathInput,
    ] = useState(
        currentPath ?? ".",
    );

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
        sortKey,
        setSortKey,
    ] = useState<
        RemoteSortKey
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

    const onPathChangeRef =
        useRef(onPathChange);

    const typeSelectBufferRef =
        useRef("");

    const typeSelectTimerRef =
        useRef<
            ReturnType<
                typeof setTimeout
            > |
            null
        >(null);

    useEffect(() => {
        onPathChangeRef.current =
            onPathChange;
    }, [onPathChange]);

    const breadcrumbs =
        useMemo(
            () =>
                listing
                    ? buildBreadcrumbs(
                        listing.path,
                    )
                    : [],
            [listing],
        );

    const sortedEntries =
        useMemo(() => {
            if (!listing) {
                return [];
            }

            const directionMultiplier =
                sortDirection === "asc"
                    ? 1
                    : -1;

            return [
                ...listing.entries,
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
        }, [
            listing,
            sortDirection,
            sortKey,
        ]);

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
                    const result =
                        await backendClient
                            .listRemoteDirectory(
                                connectionId,

                                currentPath ??
                                undefined,
                            );

                    if (
                        latestRequestRef
                            .current !==
                        requestVersion
                    ) {
                        return;
                    }

                    setListing(result);
                    setPathInput(
                        result.path,
                    );

                    if (
                        result.path !==
                        currentPath
                    ) {
                        onPathChangeRef
                            .current(
                                result.path,
                            );
                    }
                } catch (error) {
                    if (
                        latestRequestRef
                            .current !==
                        requestVersion
                    ) {
                        return;
                    }

                    setListing(null);

                    setErrorMessage(
                        error instanceof
                            Error
                            ? error.message
                            : String(error),
                    );
                } finally {
                    if (
                        latestRequestRef
                            .current ===
                        requestVersion
                    ) {
                        setLoading(false);
                    }
                }
            },
            [
                connectionId,
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
        return () => {
            latestRequestRef.current +=
                1;

            if (
                typeSelectTimerRef
                    .current
            ) {
                clearTimeout(
                    typeSelectTimerRef
                        .current,
                );
            }

            rowRefs.current.clear();
        };
    }, []);

    function handleSort(
        nextSortKey:
            RemoteSortKey,
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
        entry: RemoteFileEntry,
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
                    : sortedEntries.length -
                    1,
            );

            return;
        }

        selectByIndex(
            Math.min(
                sortedEntries.length -
                1,

                Math.max(
                    0,
                    currentIndex +
                    direction,
                ),
            ),
        );
    }

    function findMatchingEntry(
        searchText: string,
        cycle: boolean,
    ): RemoteFileEntry | null {
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

    function handleOpenEntry(
        entry: RemoteFileEntry,
    ): void {
        if (
            entry.type !==
            "directory"
        ) {
            return;
        }

        clearTypeSelect();

        onPathChangeRef.current(
            entry.path,
        );
    }

    function handleGoUp():
        void {
        if (!listing) {
            return;
        }

        const parentPath =
            listing.parentPath ??
            getRemoteParentDirectory(
                listing.path,
            );

        if (
            parentPath ===
            listing.path
        ) {
            return;
        }

        onPathChangeRef.current(
            parentPath,
        );
    }

    function handlePathSubmit(
        event:
            FormEvent<HTMLFormElement>,
    ): void {
        event.preventDefault();

        const requestedPath =
            pathInput.trim() ||
            ".";

        if (
            requestedPath ===
            currentPath
        ) {
            void loadDirectory();
            return;
        }

        onPathChangeRef.current(
            requestedPath,
        );
    }

    async function handleCreateFolder():
        Promise<void> {
        if (
            !listing ||
            isMutating
        ) {
            return;
        }

        const enteredName =
            window.prompt(
                "New remote folder name",
            );

        if (
            enteredName ===
            null
        ) {
            return;
        }

        const validationError =
            validateRemoteName(
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
            const remotePath =
                joinRemotePath(
                    listing.path,
                    enteredName.trim(),
                );

            await backendClient
                .createRemoteDirectory(
                    connectionId,
                    remotePath,
                );

            await loadDirectory();
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

            handleGoUp();
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

            if (selectedEntry) {
                event.preventDefault();

                handleOpenEntry(
                    selectedEntry,
                );
            }

            return;
        }

        if (
            event.key.length !==
            1 ||
            /\s/u.test(event.key)
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
        Boolean(
            listing &&
            (
                listing.parentPath ||
                listing.path !== "/"
            ),
        );

    return (
        <section className="sftp-remote-browser">
            <div className="sftp-remote-browser__toolbar">
                <button
                    type="button"
                    className="sftp-pane__icon-button"
                    onClick={
                        handleGoUp
                    }
                    disabled={
                        !canGoUp ||
                        loading
                    }
                    title="Go to parent directory"
                    aria-label="Go to parent directory"
                >
                    <ArrowUp
                        size={15}
                        aria-hidden="true"
                    />
                </button>

                <form
                    className="sftp-remote-path-form"
                    onSubmit={
                        handlePathSubmit
                    }
                >
                    <input
                        value={
                            pathInput
                        }
                        onChange={(
                            event,
                        ) =>
                            setPathInput(
                                event.target
                                    .value,
                            )
                        }
                        disabled={
                            loading
                        }
                        spellCheck={
                            false
                        }
                        aria-label="Remote path"
                    />
                </form>

                <button
                    type="button"
                    className="remote-create-folder-button"
                    onClick={() => {
                        void handleCreateFolder();
                    }}
                    disabled={
                        loading ||
                        isMutating ||
                        !listing
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
            </div>

            {breadcrumbs.length >
                0 && (
                    <nav
                        className="sftp-remote-breadcrumbs"
                        aria-label="Remote folder path"
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
                                    className="sftp-remote-breadcrumb"
                                >
                                    {index >
                                        0 && (
                                            <span className="sftp-remote-breadcrumb__separator">
                                                /
                                            </span>
                                        )}

                                    <button
                                        type="button"
                                        onClick={() =>
                                            onPathChangeRef
                                                .current(
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
                )}

            {errorMessage && (
                <div className="sftp-remote-browser__error">
                    {errorMessage}
                </div>
            )}

            <div
                ref={
                    listContainerRef
                }
                className="sftp-remote-list-container"
                tabIndex={0}
                role="region"
                aria-label="Remote files and folders"
                onKeyDown={
                    handleKeyDown
                }
            >
                {loading ? (
                    <div className="sftp-remote-browser__empty">
                        <Loader
                            className="loader"
                            size={20}
                        />

                        Loading remote directory…
                    </div>
                ) : !listing ||
                    sortedEntries.length ===
                    0 ? (
                    <div className="sftp-remote-browser__empty">
                        <Folder
                            size={24}
                        />

                        This directory is empty.
                    </div>
                ) : (
                    <table className="sftp-remote-file-list">
                        <thead>
                            <tr>
                                <th>
                                    <button
                                        type="button"
                                        className="sftp-remote-sort-button"
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
                                        className="sftp-remote-sort-button"
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
                                        className="sftp-remote-sort-button"
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

                                <th>
                                    Mode
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
                                            selectedPath ===
                                                entry.path
                                                ? "sftp-remote-file-row sftp-remote-file-row--selected"
                                                : "sftp-remote-file-row"
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
                                        onDoubleClick={() =>
                                            handleOpenEntry(
                                                entry,
                                            )
                                        }
                                    >
                                        <td>
                                            <span
                                                className={
                                                    `sftp-remote-entry-icon ` +
                                                    `sftp-remote-entry-icon--${entry.type}`
                                                }
                                            >
                                                {getEntryIcon(
                                                    entry,
                                                )}
                                            </span>

                                            <span
                                                className="sftp-remote-entry-name"
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

                                        <td>
                                            {entry.permissions ??
                                                "—"}
                                        </td>
                                    </tr>
                                ),
                            )}
                        </tbody>
                    </table>
                )}
            </div>

            <footer className="sftp-remote-browser__status">
                <span>
                    {listing
                        ? `${listing.entries.length} ${listing.entries.length === 1 ? "item" : "items"}`
                        : "No directory loaded"}
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
        </section>
    );
}