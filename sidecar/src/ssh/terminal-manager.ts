import type { ClientChannel } from "ssh2";

import type { ConnectionManager } from "./connection-manager";

interface BackendEvent {
    type: string;
    payload?: unknown;
}

type SendEvent = (event: BackendEvent) => void;

interface OpenTerminalOptions {
    terminalId: string;
    connectionId: string;
    cols: number;
    rows: number;
}

interface ManagedTerminal {
    terminalId: string;
    connectionId: string;
    stream: ClientChannel;
    intentionalClose: boolean;
}

export class TerminalManager {
    private readonly terminals = new Map<
        string,
        ManagedTerminal
    >();

    constructor(
        private readonly connectionManager: ConnectionManager,
        private readonly sendEvent: SendEvent,
    ) { }

    async open(options: OpenTerminalOptions): Promise<void> {
        if (this.terminals.has(options.terminalId)) {
            throw new Error(
                `Terminal already exists: ${options.terminalId}`,
            );
        }

        const client =
            this.connectionManager.getConnectedClient(
                options.connectionId,
            );

        await new Promise<void>((resolve, reject) => {
            client.shell(
                {
                    term: "xterm-256color",
                    cols: options.cols,
                    rows: options.rows,
                    width: 0,
                    height: 0,
                },
                (error, stream) => {
                    if (error) {
                        reject(error);
                        return;
                    }

                    const terminal: ManagedTerminal = {
                        terminalId: options.terminalId,
                        connectionId: options.connectionId,
                        stream,
                        intentionalClose: false,
                    };

                    this.terminals.set(
                        options.terminalId,
                        terminal,
                    );

                    stream.on("data", (data: Buffer) => {
                        this.sendOutput(
                            options.terminalId,
                            data,
                            "stdout",
                        );
                    });

                    stream.stderr.on("data", (data: Buffer) => {
                        this.sendOutput(
                            options.terminalId,
                            data,
                            "stderr",
                        );
                    });

                    stream.on("error", (streamError: Error) => {
                        this.sendEvent({
                            type: "terminal.error",
                            payload: {
                                terminalId: options.terminalId,
                                connectionId: options.connectionId,
                                message: streamError.message,
                            },
                        });
                    });

                    stream.on("close", () => {
                        const activeTerminal =
                            this.terminals.get(options.terminalId);

                        this.terminals.delete(
                            options.terminalId,
                        );

                        this.sendEvent({
                            type: "terminal.closed",
                            payload: {
                                terminalId: options.terminalId,
                                connectionId: options.connectionId,
                                reason:
                                    activeTerminal?.intentionalClose
                                        ? "user"
                                        : "remote",
                            },
                        });
                    });

                    resolve();
                },
            );
        });
    }

    write(terminalId: string, data: string): void {
        const terminal = this.requireTerminal(terminalId);

        terminal.stream.write(data);
    }

    resize(
        terminalId: string,
        cols: number,
        rows: number,
    ): void {
        const terminal = this.requireTerminal(terminalId);

        terminal.stream.setWindow(
            rows,
            cols,
            0,
            0,
        );
    }

    close(terminalId: string): boolean {
        const terminal = this.terminals.get(terminalId);

        if (!terminal) {
            return false;
        }

        terminal.intentionalClose = true;

        // Sends EOF to the remote shell.
        terminal.stream.end();

        return true;
    }

    closeForConnection(connectionId: string): void {
        for (const terminal of this.terminals.values()) {
            if (terminal.connectionId !== connectionId) {
                continue;
            }

            terminal.intentionalClose = true;
            terminal.stream.end();
        }
    }

    closeAll(): void {
        for (const terminal of this.terminals.values()) {
            terminal.intentionalClose = true;
            terminal.stream.end();
        }
    }

    private requireTerminal(
        terminalId: string,
    ): ManagedTerminal {
        const terminal = this.terminals.get(terminalId);

        if (!terminal) {
            throw new Error(
                `Terminal was not found: ${terminalId}`,
            );
        }

        return terminal;
    }

    private sendOutput(
        terminalId: string,
        data: Buffer | Uint8Array | string,
        source: "stdout" | "stderr",
    ): void {
        const buffer = Buffer.isBuffer(data)
            ? data
            : Buffer.from(data);

        this.sendEvent({
            type: "terminal.output",
            payload: {
                terminalId,
                source,
                encoding: "base64",
                data: buffer.toString("base64"),
            },
        });
    }
}