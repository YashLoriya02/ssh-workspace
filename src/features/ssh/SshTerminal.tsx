import {
    useEffect,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import {
    SearchAddon,
    type ISearchOptions,
    type ISearchResultChangeEvent,
} from "@xterm/addon-search";

import {
    ChevronDown,
    ChevronUp,
    Eraser,
    Search,
    X,
} from "lucide-react";

import "@xterm/xterm/css/xterm.css";

import {
    backendClient,
    type TerminalErrorEvent,
    type TerminalOutputEvent,
} from "../../backend/backend-client";

interface SshTerminalProps {
    connectionId: string;
    isActive: boolean;

    host: string;
    port: number;
    username: string;
}

const EMPTY_SEARCH_RESULT:
    ISearchResultChangeEvent = {
    resultIndex: -1,
    resultCount: 0,
};

const TERMINAL_SEARCH_OPTIONS:
    ISearchOptions = {
    caseSensitive: false,

    decorations: {
        matchBackground:
            "#475569",

        matchBorder:
            "#64748B",

        matchOverviewRuler:
            "#64748B",

        activeMatchBackground:
            "#D97706",

        activeMatchBorder:
            "#FBBF24",

        activeMatchColorOverviewRuler:
            "#F59E0B",
    },
};

function decodeBase64(
    encodedValue: string,
): Uint8Array {
    const binaryValue = atob(encodedValue);

    const bytes = new Uint8Array(
        binaryValue.length,
    );

    for (
        let index = 0;
        index < binaryValue.length;
        index += 1
    ) {
        bytes[index] =
            binaryValue.charCodeAt(index);
    }

    return bytes;
}

function getLastTerminalLine(
    terminal: Terminal,
): string {
    const buffer =
        terminal.buffer.active;

    const currentLineIndex =
        buffer.baseY +
        buffer.cursorY;

    /*
     * Start at the cursor line and search slightly
     * upward for the latest non-empty terminal line.
     */
    for (
        let lineIndex = currentLineIndex;
        lineIndex >=
        Math.max(0, currentLineIndex - 20);
        lineIndex -= 1
    ) {
        const line =
            buffer.getLine(lineIndex);

        if (!line) {
            continue;
        }

        const content =
            line.translateToString(
                true,
            );

        if (content.trim().length > 0) {
            return content;
        }
    }

    return "";
}

export function SshTerminal({
    connectionId,
    isActive,
    host,
    port,
    username,
}: SshTerminalProps) {
    const containerRef =
        useRef<HTMLDivElement | null>(null);

    const terminalRef =
        useRef<Terminal | null>(null);

    const fitAddonRef =
        useRef<FitAddon | null>(null);

    const searchAddonRef =
        useRef<SearchAddon | null>(
            null,
        );

    const searchInputRef =
        useRef<HTMLInputElement | null>(
            null,
        );

    const terminalIdRef =
        useRef<string | null>(null);

    const clearFallbackTimerRef =
        useRef<ReturnType<typeof setTimeout> | null>(
            null,
        );

    const remoteOutputVersionRef =
        useRef(0);

    const [
        status,
        setStatus,
    ] = useState(
        "Opening terminal...",
    );

    const [
        isSearchOpen,
        setIsSearchOpen,
    ] = useState(false);

    const [
        searchQuery,
        setSearchQuery,
    ] = useState("");

    const [
        searchResult,
        setSearchResult,
    ] = useState<ISearchResultChangeEvent>(
        EMPTY_SEARCH_RESULT,
    );

    function focusSearchInput(): void {
        window.requestAnimationFrame(
            () => {
                const searchInput =
                    searchInputRef.current;

                if (!searchInput) {
                    return;
                }

                searchInput.focus();
                searchInput.select();
            },
        );
    }

    function handleOpenTerminalSearch():
        void {
        setIsSearchOpen(true);

        focusSearchInput();
    }

    function clearTerminalSearch(): void {
        searchAddonRef.current
            ?.clearDecorations();

        setSearchResult({
            ...EMPTY_SEARCH_RESULT,
        });
    }

    function handleCloseTerminalSearch():
        void {
        setIsSearchOpen(false);
        setSearchQuery("");

        clearTerminalSearch();

        window.requestAnimationFrame(
            () => {
                terminalRef.current
                    ?.focus();
            },
        );
    }

    function runTerminalSearch(
        direction:
            | "next"
            | "previous",

        requestedQuery:
            string = searchQuery,

        incremental:
            boolean = false,
    ): void {
        const searchAddon =
            searchAddonRef.current;

        if (!searchAddon) {
            return;
        }

        if (!requestedQuery) {
            clearTerminalSearch();
            return;
        }

        if (
            direction ===
            "previous"
        ) {
            searchAddon.findPrevious(
                requestedQuery,
                {
                    ...TERMINAL_SEARCH_OPTIONS,
                    incremental: false,
                },
            );

            return;
        }

        searchAddon.findNext(
            requestedQuery,
            {
                ...TERMINAL_SEARCH_OPTIONS,
                incremental,
            },
        );
    }

    function handleSearchQueryChange(
        value: string,
    ): void {
        setSearchQuery(value);

        if (!value) {
            clearTerminalSearch();
            return;
        }

        setSearchResult({
            ...EMPTY_SEARCH_RESULT,
        });

        runTerminalSearch(
            "next",
            value,
            true,
        );
    }

    function handleSearchInputKeyDown(
        event:
            ReactKeyboardEvent<HTMLInputElement>,
    ): void {
        const key =
            event.key.toLowerCase();

        if (key === "escape") {
            event.preventDefault();
            event.stopPropagation();

            handleCloseTerminalSearch();
            return;
        }

        if (
            (
                event.ctrlKey ||
                event.metaKey
            ) &&
            !event.altKey &&
            key === "f"
        ) {
            event.preventDefault();
            event.stopPropagation();

            event.currentTarget.select();
            return;
        }

        if (
            key === "enter" ||
            key === "f3"
        ) {
            event.preventDefault();
            event.stopPropagation();

            runTerminalSearch(
                event.shiftKey
                    ? "previous"
                    : "next",
            );
        }
    }

    useEffect(() => {
        const container =
            containerRef.current;

        if (!container) {
            return;
        }

        let disposed = false;

        let resizeTimer:
            | ReturnType<typeof setTimeout>
            | null = null;

        let promptFallbackTimer:
            | ReturnType<typeof setTimeout>
            | null = null;

        let hasReceivedRemoteOutput = false;

        const terminal =
            new Terminal({
                cursorBlink: true,
                cursorStyle: "block",

                fontFamily:
                    '"Cascadia Code", "JetBrains Mono", Consolas, monospace',

                fontSize: 14,
                lineHeight: 1.15,
                scrollback: 5_000,

                allowProposedApi: false,

                theme: {
                    background: "#0b0e14",
                    foreground: "#d8dee9",

                    cursor: "#88c0d0",
                    cursorAccent: "#0b0e14",

                    selectionBackground:
                        "#334155",

                    black: "#1b1d23",
                    red: "#e06c75",
                    green: "#98c379",
                    yellow: "#e5c07b",
                    blue: "#61afef",
                    magenta: "#c678dd",
                    cyan: "#56b6c2",
                    white: "#abb2bf",

                    brightBlack: "#5c6370",
                    brightRed: "#e06c75",
                    brightGreen: "#98c379",
                    brightYellow: "#e5c07b",
                    brightBlue: "#61afef",
                    brightMagenta: "#c678dd",
                    brightCyan: "#56b6c2",
                    brightWhite: "#ffffff",
                },
            });

        const fitAddon =
            new FitAddon();

        const searchAddon =
            new SearchAddon();

        terminalRef.current = terminal;
        fitAddonRef.current = fitAddon;
        searchAddonRef.current = searchAddon;

        terminal.loadAddon(fitAddon);
        terminal.loadAddon(searchAddon);

        const searchResultDisposable =
            searchAddon.onDidChangeResults(
                (result) => {
                    setSearchResult(
                        result,
                    );
                },
            );

        terminal.open(container);

        function sendCurrentSize(): void {
            const activeTerminalId =
                terminalIdRef.current;

            if (!activeTerminalId) {
                return;
            }

            void backendClient
                .resizeTerminal(
                    activeTerminalId,
                    terminal.cols,
                    terminal.rows,
                )
                .catch(
                    (error: unknown) => {
                        setStatus(
                            error instanceof Error
                                ? error.message
                                : String(error),
                        );
                    },
                );
        }

        function fitAndResize(): void {
            try {
                fitAddon.fit();
            } catch {
                return;
            }

            if (resizeTimer) {
                clearTimeout(
                    resizeTimer,
                );
            }

            resizeTimer =
                setTimeout(
                    sendCurrentSize,
                    80,
                );
        }

        terminal.attachCustomKeyEventHandler(
            (event) => {
                const key =
                    event.key.toLowerCase();

                const primaryModifierPressed =
                    event.ctrlKey ||
                    event.metaKey;

                if (
                    primaryModifierPressed &&
                    !event.altKey &&
                    key === "f"
                ) {
                    event.preventDefault();
                    event.stopPropagation();

                    handleOpenTerminalSearch();

                    /*
                     * Returning false prevents xterm from
                     * forwarding Ctrl/Cmd+F to the shell.
                     */
                    return false;
                }

                return true;
            },
        );

        const inputDisposable =
            terminal.onData(
                (data) => {
                    const activeTerminalId =
                        terminalIdRef.current;

                    if (
                        !activeTerminalId
                    ) {
                        return;
                    }

                    void backendClient
                        .writeTerminal(
                            activeTerminalId,
                            data,
                        )
                        .catch(
                            (
                                error:
                                    unknown,
                            ) => {
                                setStatus(
                                    error instanceof
                                        Error
                                        ? error.message
                                        : String(
                                            error,
                                        ),
                                );
                            },
                        );
                },
            );

        const unsubscribeEvents =
            backendClient.subscribeToEvents(
                (event) => {
                    if (
                        event.type ===
                        "terminal.output"
                    ) {
                        const output =
                            event.payload as
                            TerminalOutputEvent;

                        if (
                            output.terminalId !==
                            terminalIdRef.current
                        ) {
                            return;
                        }

                        hasReceivedRemoteOutput = true;

                        if (promptFallbackTimer) {
                            clearTimeout(
                                promptFallbackTimer,
                            );

                            promptFallbackTimer = null;
                        }

                        remoteOutputVersionRef.current += 1;

                        /*
                         * The remote shell successfully redrew its prompt,
                         * so the local fallback is no longer required.
                         */
                        if (
                            clearFallbackTimerRef.current
                        ) {
                            clearTimeout(
                                clearFallbackTimerRef.current,
                            );

                            clearFallbackTimerRef.current =
                                null;
                        }

                        terminal.write(
                            decodeBase64(
                                output.data,
                            ),
                        );

                        return;
                    }

                    if (
                        event.type ===
                        "terminal.closed"
                    ) {
                        const payload =
                            event.payload as {
                                terminalId:
                                string;
                                reason?:
                                string;
                            };

                        if (
                            payload.terminalId !==
                            terminalIdRef.current
                        ) {
                            return;
                        }

                        setStatus(
                            "Terminal closed",
                        );

                        terminal.write(
                            "\r\n\x1b[33m[Remote terminal closed]\x1b[0m\r\n",
                        );

                        return;
                    }

                    if (
                        event.type ===
                        "terminal.error"
                    ) {
                        const payload =
                            event.payload as
                            TerminalErrorEvent;

                        if (
                            payload.terminalId !==
                            terminalIdRef.current
                        ) {
                            return;
                        }

                        setStatus(
                            payload.message,
                        );

                        terminal.write(
                            `\r\n\x1b[31m[Terminal error: ${payload.message}]\x1b[0m\r\n`,
                        );
                    }
                },
            );

        const resizeObserver =
            new ResizeObserver(
                () => {
                    fitAndResize();
                },
            );

        resizeObserver.observe(
            container,
        );

        async function openRemoteTerminal():
            Promise<void> {
            const terminalId =
                crypto.randomUUID();

            /*
             * Assign the ID before opening the remote shell.
             * The server may send its initial prompt before
             * terminal.open returns.
             */
            terminalIdRef.current =
                terminalId;

            try {
                try {
                    fitAddon.fit();
                } catch {
                    // The workspace may briefly be hidden.
                }

                await backendClient.openTerminal(
                    connectionId,

                    Math.max(
                        terminal.cols,
                        1,
                    ),

                    Math.max(
                        terminal.rows,
                        1,
                    ),

                    terminalId,
                );

                if (disposed) {
                    terminalIdRef.current =
                        null;

                    await backendClient.closeTerminal(
                        terminalId,
                    );

                    return;
                }

                setStatus(
                    "Connected",
                );

                terminal.focus();
                fitAndResize();

                /*
                 * Most servers immediately send their shell
                 * prompt. Some restricted servers wait until
                 * the first Enter key.
                 *
                 * When no prompt arrives, display a small local
                 * connection message and send Enter to request
                 * the real server prompt.
                 */
                if (!hasReceivedRemoteOutput) {
                    promptFallbackTimer =
                        setTimeout(
                            () => {
                                if (
                                    disposed ||
                                    hasReceivedRemoteOutput ||
                                    terminalIdRef.current !==
                                    terminalId
                                ) {
                                    return;
                                }

                                const remoteAddress =
                                    `${username}@${host}` +
                                    (
                                        port !== 22
                                            ? `:${port}`
                                            : ""
                                    );

                                terminal.write(
                                    `\x1b[90m[Connected to ${remoteAddress}]\x1b[0m\r\n`,
                                );

                                void backendClient
                                    .writeTerminal(
                                        terminalId,
                                        "\r",
                                    )
                                    .catch(
                                        (
                                            error:
                                                unknown,
                                        ) => {
                                            setStatus(
                                                error instanceof
                                                    Error
                                                    ? error.message
                                                    : String(
                                                        error,
                                                    ),
                                            );
                                        },
                                    );
                            },
                            750,
                        );
                }
            } catch (error) {
                if (
                    terminalIdRef.current ===
                    terminalId
                ) {
                    terminalIdRef.current =
                        null;
                }

                const message =
                    error instanceof Error
                        ? error.message
                        : String(error);

                setStatus(message);

                terminal.write(
                    `\r\n\x1b[31m[Unable to open terminal: ${message}]\x1b[0m\r\n`,
                );
            }
        }

        const animationFrame =
            requestAnimationFrame(
                () => {
                    void openRemoteTerminal();
                },
            );

        return () => {
            disposed = true;

            cancelAnimationFrame(
                animationFrame,
            );

            if (resizeTimer) {
                clearTimeout(
                    resizeTimer,
                );
            }

            if (
                clearFallbackTimerRef.current
            ) {
                clearTimeout(
                    clearFallbackTimerRef.current,
                );

                clearFallbackTimerRef.current =
                    null;
            }

            if (promptFallbackTimer) {
                clearTimeout(
                    promptFallbackTimer,
                );
            }

            resizeObserver.disconnect();
            unsubscribeEvents();
            inputDisposable.dispose();
            searchResultDisposable.dispose();
            searchAddon.clearDecorations();

            const activeTerminalId =
                terminalIdRef.current;

            terminalIdRef.current = null;
            terminalRef.current = null;
            fitAddonRef.current = null;
            searchAddonRef.current = null;

            if (activeTerminalId) {
                void backendClient
                    .closeTerminal(
                        activeTerminalId,
                    )
                    .catch(
                        (
                            error:
                                unknown,
                        ) => {
                            console.error(
                                "Unable to close terminal:",
                                error,
                            );
                        },
                    );
            }

            terminal.dispose();
        };
    }, [connectionId]);

    /*
     * Refit the existing xterm instance whenever
     * this workspace becomes the visible tab.
     */
    useEffect(() => {
        if (!isActive) {
            return;
        }

        const animationFrame =
            requestAnimationFrame(
                () => {
                    const terminal =
                        terminalRef.current;

                    const fitAddon =
                        fitAddonRef.current;

                    if (
                        !terminal ||
                        !fitAddon
                    ) {
                        return;
                    }

                    try {
                        fitAddon.fit();
                    } catch {
                        return;
                    }

                    terminal.focus();

                    const terminalId =
                        terminalIdRef.current;

                    if (!terminalId) {
                        return;
                    }

                    void backendClient
                        .resizeTerminal(
                            terminalId,
                            terminal.cols,
                            terminal.rows,
                        )
                        .catch(
                            (
                                error:
                                    unknown,
                            ) => {
                                setStatus(
                                    error instanceof
                                        Error
                                        ? error.message
                                        : String(
                                            error,
                                        ),
                                );
                            },
                        );
                },
            );

        return () => {
            cancelAnimationFrame(
                animationFrame,
            );
        };
    }, [isActive]);

    function handleClearTerminal(): void {
        if (isSearchOpen) {
            setIsSearchOpen(false);
            setSearchQuery("");
        }

        clearTerminalSearch();

        const terminal = terminalRef.current;
        const terminalId = terminalIdRef.current;

        if (!terminal) {
            return;
        }

        const preservedLine =
            getLastTerminalLine(
                terminal,
            );

        const outputVersionBeforeClear =
            remoteOutputVersionRef.current;

        if (
            clearFallbackTimerRef.current
        ) {
            clearTimeout(
                clearFallbackTimerRef.current,
            );

            clearFallbackTimerRef.current =
                null;
        }

        /*
         * Clear local output and scrollback.
         */
        terminal.clear();

        terminal.write(
            "\x1b[2J\x1b[H",
        );

        if (!terminalId) {
            const remoteAddress =
                `${username}@${host}` +
                (
                    port !== 22
                        ? `:${port}`
                        : ""
                );

            terminal.write(
                `\x1b[90m[Connected to ${remoteAddress}]\x1b[0m`,
            );

            terminal.focus();
            return;
        }

        /*
         * Ask the remote shell to clear and redraw
         * its real prompt.
         */
        void backendClient
            .writeTerminal(
                terminalId,
                "\x0c",
            )
            .catch(
                (
                    error:
                        unknown,
                ) => {
                    setStatus(
                        error instanceof Error
                            ? error.message
                            : String(error),
                    );
                },
            );

        /*
         * Some restricted shells clear their screen but do
         * not send the prompt again. When no remote output
         * arrives, restore the prompt line captured before
         * clearing.
         */
        clearFallbackTimerRef.current =
            setTimeout(
                () => {
                    clearFallbackTimerRef.current =
                        null;

                    if (
                        remoteOutputVersionRef.current !==
                        outputVersionBeforeClear
                    ) {
                        return;
                    }

                    const remoteAddress =
                        `${username}@${host}` +
                        (
                            port !== 22
                                ? `:${port}`
                                : ""
                        );

                    if (
                        preservedLine.trim()
                            .length > 0
                    ) {
                        terminal.write(
                            preservedLine,
                        );
                    } else {
                        terminal.write(
                            `\x1b[90m[Connected to ${remoteAddress}]\x1b[0m`,
                        );
                    }

                    terminal.focus();
                },
                250,
            );

        terminal.focus();
    }

    const searchResultLabel =
        !searchQuery
            ? ""
            : searchResult.resultCount ===
                0
                ? "No matches"
                : searchResult.resultIndex <
                    0
                    ? `${searchResult.resultCount} matches`
                    : `${searchResult.resultIndex + 1} of ${searchResult.resultCount}`;

    return (
        <section className="terminal-panel">
            <header className="terminal-panel__header">
                <div className="terminal-panel__title">
                    <span className="terminal-panel__dot" />

                    Remote terminal
                </div>

                <div className="terminal-panel__actions">
                    <span className="terminal-panel__status">
                        {status}
                    </span>

                    <button
                        type="button"
                        className="terminal-clear-button"
                        onClick={
                            handleClearTerminal
                        }
                        disabled={
                            status !== "Connected"
                        }
                        title="Clear terminal and redraw the current prompt"
                    >
                        <Eraser
                            size={14}
                            aria-hidden="true"
                        />

                        <span>
                            Clear
                        </span>
                    </button>

                    <button
                        type="button"
                        className={
                            isSearchOpen
                                ? "terminal-clear-button terminal-search-button terminal-search-button--active"
                                : "terminal-clear-button terminal-search-button"
                        }
                        onClick={
                            handleOpenTerminalSearch
                        }
                        title="Find in terminal output (Ctrl/Cmd+F)"
                    >
                        <Search
                            size={14}
                            aria-hidden="true"
                        />

                        <span>
                            Find
                        </span>
                    </button>
                </div>
            </header>

            {isSearchOpen && (
                <div
                    className="terminal-search-bar"
                    role="search"
                    aria-label="Search terminal output"
                >
                    <Search
                        size={14}
                        className="terminal-search-bar__icon"
                        aria-hidden="true"
                    />

                    <input
                        ref={searchInputRef}
                        value={searchQuery}
                        onChange={(event) =>
                            handleSearchQueryChange(
                                event.target.value,
                            )
                        }
                        onKeyDown={
                            handleSearchInputKeyDown
                        }
                        placeholder="Search terminal output"
                        aria-label="Search terminal output"
                        spellCheck={false}
                        autoComplete="off"
                    />

                    <span
                        className={
                            searchQuery &&
                                searchResult.resultCount ===
                                0
                                ? "terminal-search-result terminal-search-result--empty"
                                : "terminal-search-result"
                        }
                        aria-live="polite"
                    >
                        {searchResultLabel}
                    </span>

                    <button
                        type="button"
                        className="terminal-search-control"
                        onClick={() =>
                            runTerminalSearch(
                                "previous",
                            )
                        }
                        disabled={!searchQuery}
                        title="Previous match (Shift+Enter)"
                        aria-label="Previous match"
                    >
                        <ChevronUp
                            size={15}
                            aria-hidden="true"
                        />
                    </button>

                    <button
                        type="button"
                        className="terminal-search-control"
                        onClick={() =>
                            runTerminalSearch(
                                "next",
                            )
                        }
                        disabled={!searchQuery}
                        title="Next match (Enter)"
                        aria-label="Next match"
                    >
                        <ChevronDown
                            size={15}
                            aria-hidden="true"
                        />
                    </button>

                    <button
                        type="button"
                        className="terminal-search-control terminal-search-close"
                        onClick={
                            handleCloseTerminalSearch
                        }
                        title="Close search (Escape)"
                        aria-label="Close terminal search"
                    >
                        <X
                            size={15}
                            aria-hidden="true"
                        />
                    </button>
                </div>
            )}

            <div
                ref={containerRef}
                className="terminal-container"
            />
        </section>
    );
}
