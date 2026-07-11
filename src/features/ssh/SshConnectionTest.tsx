import {
    useEffect,
    useMemo,
    useState,
    type FormEvent,
} from "react";

import {
    backendClient,
    type BackendState,
    type HostKeyApprovalEvent,
} from "../../backend/backend-client";

import {
    confirm as confirmDialog,
} from "@tauri-apps/plugin-dialog";

interface SshConnectionTestProps {
    onConnected: (
        connectionId: string,
    ) => void;
}

type AuthenticationType =
    | "password"
    | "privateKey";

export function SshConnectionTest({
    onConnected,
}: SshConnectionTestProps) {
    const [backendState, setBackendState] =
        useState<BackendState>({
            status: "stopped",
        });

    const [host, setHost] = useState("");
    const [port, setPort] = useState("22");
    const [username, setUsername] = useState("");

    const [authenticationType, setAuthenticationType] =
        useState<AuthenticationType>("password");

    const [password, setPassword] = useState("");
    const [privateKey, setPrivateKey] = useState("");
    const [passphrase, setPassphrase] = useState("");

    const [connectionId, setConnectionId] =
        useState<string | null>(null);

    const [connectionState, setConnectionState] =
        useState("Not connected");

    const [errorMessage, setErrorMessage] =
        useState("");

    const [isConnecting, setIsConnecting] =
        useState(false);

    const backendConnected =
        backendState.status === "connected";

    const canConnect = useMemo(() => {
        const parsedPort = Number(port);

        const credentialsValid =
            authenticationType === "password"
                ? password.length > 0
                : privateKey.trim().length > 0;

        return (
            host.trim().length > 0 &&
            username.trim().length > 0 &&
            Number.isInteger(parsedPort) &&
            parsedPort >= 1 &&
            parsedPort <= 65_535 &&
            credentialsValid &&
            !isConnecting &&
            !connectionId
        );
    }, [
        authenticationType,
        connectionId,
        host,
        isConnecting,
        password,
        port,
        privateKey,
        username,
    ]);

    useEffect(() => {
        const unsubscribeState =
            backendClient.subscribeToState(setBackendState);

        const unsubscribeEvents =
            backendClient.subscribeToEvents((event) => {
                if (
                    event.type ===
                    "connection.hostKeyApprovalRequired"
                ) {
                    const hostKey =
                        event.payload as HostKeyApprovalEvent;

                    void (async () => {
                        try {
                            const accepted = await confirmDialog(
                                [
                                    "The server's identity has not been verified.",
                                    "",
                                    `Host: ${hostKey.host}:${hostKey.port}`,
                                    `Key type: ${hostKey.keyType}`,
                                    `Fingerprint: ${hostKey.fingerprint}`,
                                    "",
                                    "Only continue if this fingerprint belongs to the expected server.",
                                ].join("\n"),
                                {
                                    title: "Verify SSH Host",
                                    kind: "warning",
                                },
                            );

                            console.log("Host key decision:", {
                                accepted,
                                acceptedType: typeof accepted,
                                connectionId: hostKey.connectionId,
                            });

                            await backendClient.decideHostKey(
                                hostKey.connectionId,
                                accepted,
                            );
                        } catch (error) {
                            setConnectionState("Connection failed");
                            setIsConnecting(false);

                            setErrorMessage(
                                error instanceof Error
                                    ? error.message
                                    : String(error),
                            );
                        }
                    })();

                    return;
                }

                if (event.type === "connection.connected") {
                    setConnectionState("Connected");
                    return;
                }

                if (event.type === "connection.failed") {
                    const payload = event.payload as {
                        message?: string;
                    };

                    setConnectionState("Connection failed");
                    setErrorMessage(
                        payload.message ??
                        "Unable to establish the SSH connection.",
                    );

                    setIsConnecting(false);
                    return;
                }

                if (
                    event.type === "connection.disconnected"
                ) {
                    setConnectionId(null);
                    setConnectionState("Disconnected");
                    setIsConnecting(false);
                    return;
                }

                if (event.type === "connection.error") {
                    const payload = event.payload as {
                        message?: string;
                    };

                    setErrorMessage(
                        payload.message ?? "SSH connection error.",
                    );
                }
            });

        return () => {
            unsubscribeState();
            unsubscribeEvents();
        };
    }, []);

    async function handleConnect(
        event: FormEvent<HTMLFormElement>,
    ): Promise<void> {
        event.preventDefault();

        if (!canConnect) {
            return;
        }

        setErrorMessage("");
        setConnectionState("Connecting...");
        setIsConnecting(true);

        try {
            if (!backendConnected) {
                await backendClient.start();
            }

            const authentication =
                authenticationType === "password"
                    ? {
                        type: "password" as const,
                        password,
                    }
                    : {
                        type: "privateKey" as const,
                        privateKey,
                        ...(passphrase
                            ? { passphrase }
                            : {}),
                    };

            const newConnectionId =
                await backendClient.connectSsh({
                    host: host.trim(),
                    port: Number(port),
                    username: username.trim(),
                    authentication,
                });

            setConnectionId(newConnectionId);
            setConnectionState("Connected");

            onConnected(newConnectionId);
        } catch (error) {
            setConnectionState("Connection failed");

            setErrorMessage(
                error instanceof Error
                    ? error.message
                    : String(error),
            );
        } finally {
            setIsConnecting(false);
        }
    }

    return (
        <main className="ssh-page">
            <section className="ssh-card">
                <header className="ssh-header">
                    <div>
                        <p className="eyebrow">SSH Workspace</p>
                        <h1>SSH Connection Test</h1>
                        <p className="subtitle">
                            Connect to a remote server before opening
                            the terminal.
                        </p>
                    </div>

                    <div className="status-area">
                        <span
                            className={`status status--${backendState.status}`}
                        >
                            Backend: {backendState.status}
                        </span>

                        <span className="connection-status">
                            SSH: {connectionState}
                        </span>
                    </div>
                </header>

                <form
                    className="ssh-form"
                    onSubmit={handleConnect}
                >
                    <div className="form-grid">
                        <label>
                            <span>Host</span>
                            <input
                                value={host}
                                onChange={(event) =>
                                    setHost(event.target.value)
                                }
                                placeholder="192.168.1.50 or server.example.com"
                                disabled={Boolean(connectionId)}
                                autoComplete="off"
                            />
                        </label>

                        <label>
                            <span>Port</span>
                            <input
                                value={port}
                                onChange={(event) =>
                                    setPort(event.target.value)
                                }
                                inputMode="numeric"
                                disabled={Boolean(connectionId)}
                            />
                        </label>

                        <label>
                            <span>Username</span>
                            <input
                                value={username}
                                onChange={(event) =>
                                    setUsername(event.target.value)
                                }
                                placeholder="ubuntu"
                                disabled={Boolean(connectionId)}
                                autoComplete="username"
                            />
                        </label>

                        <label>
                            <span>Authentication</span>
                            <select
                                value={authenticationType}
                                onChange={(event) =>
                                    setAuthenticationType(
                                        event.target
                                            .value as AuthenticationType,
                                    )
                                }
                                disabled={Boolean(connectionId)}
                            >
                                <option value="password">
                                    Password
                                </option>
                                <option value="privateKey">
                                    Private key
                                </option>
                            </select>
                        </label>
                    </div>

                    {authenticationType === "password" ? (
                        <label>
                            <span>Password</span>
                            <input
                                type="password"
                                value={password}
                                onChange={(event) =>
                                    setPassword(event.target.value)
                                }
                                disabled={Boolean(connectionId)}
                                autoComplete="current-password"
                            />
                        </label>
                    ) : (
                        <>
                            <label>
                                <span>Private-key contents</span>
                                <textarea
                                    value={privateKey}
                                    onChange={(event) =>
                                        setPrivateKey(event.target.value)
                                    }
                                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                                    rows={8}
                                    disabled={Boolean(connectionId)}
                                    spellCheck={false}
                                />
                            </label>

                            <label>
                                <span>
                                    Key passphrase, when encrypted
                                </span>
                                <input
                                    type="password"
                                    value={passphrase}
                                    onChange={(event) =>
                                        setPassphrase(event.target.value)
                                    }
                                    disabled={Boolean(connectionId)}
                                />
                            </label>
                        </>
                    )}

                    <div className="actions">
                        <button
                            type="submit"
                            disabled={!canConnect}
                        >
                            {isConnecting
                                ? "Connecting..."
                                : "Connect"}
                        </button>
                    </div>

                    {errorMessage && (
                        <div className="error-message">
                            {errorMessage}
                        </div>
                    )}
                </form>
            </section>
        </main>
    );
}
