import {
    useEffect,
    useRef,
    useState,
} from "react";

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

import "@xterm/xterm/css/xterm.css";

import {
    backendClient,
    type TerminalErrorEvent,
    type TerminalOutputEvent,
} from "../../backend/backend-client";

interface SshTerminalProps {
    connectionId: string;
}

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

export function SshTerminal({
    connectionId,
}: SshTerminalProps) {
    const containerRef =
        useRef<HTMLDivElement | null>(null);

    const [status, setStatus] =
        useState("Opening terminal...");

    useEffect(() => {
        const container = containerRef.current;

        if (!container) {
            return;
        }

        let disposed = false;
        let activeTerminalId: string | null = null;
        let resizeTimer: ReturnType<
            typeof setTimeout
        > | null = null;

        const terminal = new Terminal({
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
                selectionBackground: "#334155",
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

        const fitAddon = new FitAddon();

        terminal.loadAddon(fitAddon);
        terminal.open(container);

        const inputDisposable = terminal.onData(
            (data) => {
                if (!activeTerminalId) {
                    return;
                }

                void backendClient
                    .writeTerminal(
                        activeTerminalId,
                        data,
                    )
                    .catch((error: unknown) => {
                        setStatus(
                            error instanceof Error
                                ? error.message
                                : String(error),
                        );
                    });
            },
        );

        const unsubscribeEvents =
            backendClient.subscribeToEvents((event) => {
                if (event.type === "terminal.output") {
                    const output =
                        event.payload as TerminalOutputEvent;

                    if (
                        output.terminalId !==
                        activeTerminalId
                    ) {
                        return;
                    }

                    terminal.write(
                        decodeBase64(output.data),
                    );

                    return;
                }

                if (event.type === "terminal.closed") {
                    const payload = event.payload as {
                        terminalId: string;
                        reason?: string;
                    };

                    if (
                        payload.terminalId !==
                        activeTerminalId
                    ) {
                        return;
                    }

                    setStatus("Terminal closed");

                    terminal.write(
                        "\r\n\x1b[33m[Remote terminal closed]\x1b[0m\r\n",
                    );

                    return;
                }

                if (event.type === "terminal.error") {
                    const payload =
                        event.payload as TerminalErrorEvent;

                    if (
                        payload.terminalId !==
                        activeTerminalId
                    ) {
                        return;
                    }

                    setStatus(payload.message);

                    terminal.write(
                        `\r\n\x1b[31m[Terminal error: ${payload.message}]\x1b[0m\r\n`,
                    );
                }
            });

        function sendCurrentSize(): void {
            if (!activeTerminalId) {
                return;
            }

            void backendClient
                .resizeTerminal(
                    activeTerminalId,
                    terminal.cols,
                    terminal.rows,
                )
                .catch((error: unknown) => {
                    setStatus(
                        error instanceof Error
                            ? error.message
                            : String(error),
                    );
                });
        }

        function fitAndResize(): void {
            try {
                fitAddon.fit();
            } catch {
                return;
            }

            if (resizeTimer) {
                clearTimeout(resizeTimer);
            }

            resizeTimer = setTimeout(
                sendCurrentSize,
                80,
            );
        }

        const resizeObserver = new ResizeObserver(
            () => {
                fitAndResize();
            },
        );

        resizeObserver.observe(container);

        async function openRemoteTerminal(): Promise<void> {
            try {
                fitAddon.fit();

                const terminalId =
                    await backendClient.openTerminal(
                        connectionId,
                        Math.max(terminal.cols, 1),
                        Math.max(terminal.rows, 1),
                    );

                if (disposed) {
                    await backendClient.closeTerminal(
                        terminalId,
                    );

                    return;
                }

                activeTerminalId = terminalId;

                setStatus("Connected");
                terminal.focus();

                sendCurrentSize();
            } catch (error) {
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
            requestAnimationFrame(() => {
                void openRemoteTerminal();
            });

        return () => {
            disposed = true;

            cancelAnimationFrame(animationFrame);

            if (resizeTimer) {
                clearTimeout(resizeTimer);
            }

            resizeObserver.disconnect();
            unsubscribeEvents();
            inputDisposable.dispose();

            if (activeTerminalId) {
                void backendClient.closeTerminal(
                    activeTerminalId,
                );
            }

            terminal.dispose();
        };
    }, [connectionId]);

    return (
        <section className="terminal-panel">
            <header className="terminal-panel__header">
                <div className="terminal-panel__title">
                    <span className="terminal-panel__dot" />
                    Remote terminal
                </div>

                <span className="terminal-panel__status">
                    {status}
                </span>
            </header>

            <div
                ref={containerRef}
                className="terminal-container"
            />
        </section>
    );
}
