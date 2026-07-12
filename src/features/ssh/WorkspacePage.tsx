import {
    useEffect,
    useState,
} from "react";

import {
    backendClient,
} from "../../backend/backend-client";

import {
    RemoteFileExplorer,
} from "./RemoteFileExplorer";

import {
    SshTerminal,
} from "./SshTerminal";

import {
    TransferQueue,
} from "./TransferQueue";

interface WorkspacePageProps {
    connectionId: string;

    title: string;
    host: string;
    port: number;
    username: string;

    isActive: boolean;

    onDisconnected: (
        connectionId: string,
    ) => void;
}

export function WorkspacePage({
    connectionId,
    title,
    host,
    port,
    username,
    isActive,
    onDisconnected,
}: WorkspacePageProps) {
    const [
        connectionError,
        setConnectionError,
    ] = useState("");

    useEffect(() => {
        return backendClient.subscribeToEvents(
            (event) => {
                if (
                    event.type ===
                    "connection.disconnected"
                ) {
                    const payload =
                        event.payload as {
                            connectionId?: string;
                        };

                    if (
                        payload.connectionId !==
                        connectionId
                    ) {
                        return;
                    }

                    onDisconnected(
                        connectionId,
                    );

                    return;
                }

                if (
                    event.type ===
                    "connection.error"
                ) {
                    const payload =
                        event.payload as {
                            connectionId?: string;
                            message?: string;
                        };

                    if (
                        payload.connectionId !==
                        connectionId
                    ) {
                        return;
                    }

                    setConnectionError(
                        payload.message ??
                        "The SSH connection encountered an error.",
                    );
                }
            },
        );
    }, [
        connectionId,
        onDisconnected,
    ]);

    return (
        <main className="workspace-page">
            <header className="workspace-topbar">
                <div className="workspace-topbar__left">
                    <div>
                        <h1 className="workspace-title">
                            {title}
                        </h1>

                        <p className="workspace-subtitle">
                            {username}
                            {"@"}
                            {host}

                            {port !== 22
                                ? `:${port}`
                                : ""}
                        </p>
                    </div>
                </div>

                <div className="workspace-connected-status">
                    <span className="workspace-connected-dot" />

                    Connected
                </div>
            </header>

            {connectionError && (
                <div className="workspace-error">
                    {connectionError}
                </div>
            )}

            <section className="workspace-grid">
                <SshTerminal
                    connectionId={
                        connectionId
                    }
                    isActive={
                        isActive
                    }
                    host={
                        host
                    }
                    port={
                        port
                    }
                    username={
                        username
                    }
                />

                <RemoteFileExplorer
                    connectionId={
                        connectionId
                    }
                    isActive={
                        isActive
                    }
                />
            </section>

            <TransferQueue
                connectionId={
                    connectionId
                }
            />
        </main>
    );
}
