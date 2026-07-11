import {
    useEffect,
    useRef,
    useState,
} from "react";

import { backendClient } from "../../backend/backend-client";
import { RemoteFileExplorer } from "./RemoteFileExplorer";
import { SshTerminal } from "./SshTerminal";
import { TransferQueue } from "./TransferQueue";
import { ArrowLeft } from "lucide-react";

interface WorkspacePageProps {
    connectionId: string;
    onBack: () => Promise<void>;
    onDisconnected: () => void;
}

export function WorkspacePage({
    connectionId,
    onBack,
    onDisconnected,
}: WorkspacePageProps) {
    const leavingRef = useRef(false);

    const [isLeaving, setIsLeaving] =
        useState(false);

    const [connectionError, setConnectionError] =
        useState("");

    useEffect(() => {
        return backendClient.subscribeToEvents(
            (event) => {
                if (
                    event.type ===
                    "connection.disconnected"
                ) {
                    const payload = event.payload as {
                        connectionId?: string;
                    };

                    if (
                        payload.connectionId !==
                        connectionId
                    ) {
                        return;
                    }

                    if (!leavingRef.current) {
                        onDisconnected();
                    }

                    return;
                }

                if (
                    event.type === "connection.error"
                ) {
                    const payload = event.payload as {
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

    async function handleBackClick(): Promise<void> {
        if (isLeaving) {
            return;
        }

        leavingRef.current = true;
        setIsLeaving(true);

        try {
            await onBack();
        } finally {
            setIsLeaving(false);
        }
    }

    return (
        <main className="workspace-page">
            <header className="workspace-topbar">
                <div className="workspace-topbar__left">
                    <button
                        type="button"
                        className="workspace-back-button"
                        onClick={() =>
                            void handleBackClick()
                        }
                        disabled={isLeaving}
                    >
                        <ArrowLeft />
                    </button>

                    <div>
                        <h1 className="workspace-title">
                            SSH Workspace
                        </h1>

                        <p className="workspace-subtitle">
                            Remote terminal and file manager
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
                    connectionId={connectionId}
                />

                <RemoteFileExplorer
                    connectionId={connectionId}
                />
            </section>

            <TransferQueue
                connectionId={connectionId}
            />
        </main>
    );
}