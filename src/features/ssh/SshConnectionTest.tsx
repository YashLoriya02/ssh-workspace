import {
    useEffect,
    useMemo,
    useState,
    useRef,
    type FormEvent,
} from "react";

import {
    backendClient,
    type BackendState,
    type HostKeyApprovalEvent,
    type HostKeyMismatchEvent,
    type HostKeyVerifiedEvent,
} from "../../backend/backend-client";

import {
    confirm as confirmDialog,
} from "@tauri-apps/plugin-dialog";

import { SavedConnectionsPanel } from "./SavedConnectionsPanel";

import {
    deleteConnectionProfile,
    loadConnectionProfiles,
    markProfileConnected,
    saveConnectionProfile,
    type SavedConnectionProfile,
} from "../../store/connection-profile-store";

import {
    deleteKnownHost,
    loadKnownHost,
    markKnownHostVerified,
    saveKnownHost,
    type KnownHostRecord,
} from "../../store/known-host-store";
import { Check, Eye, EyeClosed, EyeOff } from "lucide-react";

export interface ConnectedWorkspaceDetails {
    connectionId: string;
    title: string;
    host: string;
    port: number;
    username: string;
}

interface SshConnectionTestProps {
    onConnected: (
        workspace: ConnectedWorkspaceDetails,
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

    const [isVisible, setIsVisible] = useState<boolean>(false);

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

    const [profiles, setProfiles] =
        useState<SavedConnectionProfile[]>([]);

    const [
        profilesLoading,
        setProfilesLoading,
    ] = useState(true);

    const [
        selectedProfileId,
        setSelectedProfileId,
    ] = useState<string | null>(null);

    const [profileName, setProfileName] =
        useState("");

    const [
        profileError,
        setProfileError,
    ] = useState("");

    const [
        knownHostRecord,
        setKnownHostRecord,
    ] = useState<KnownHostRecord | null>(
        null,
    );

    const securityErrorRef =
        useRef<string | null>(null);

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
        const parsedPort = Number(port);

        if (
            !host.trim() ||
            !Number.isInteger(parsedPort) ||
            parsedPort < 1 ||
            parsedPort > 65_535
        ) {
            setKnownHostRecord(null);
            return;
        }

        let disposed = false;

        void loadKnownHost(
            host,
            parsedPort,
        )
            .then((record) => {
                if (!disposed) {
                    setKnownHostRecord(record);
                }
            })
            .catch((error: unknown) => {
                console.error(
                    "Unable to load known host:",
                    error,
                );

                if (!disposed) {
                    setKnownHostRecord(null);
                }
            });

        return () => {
            disposed = true;
        };
    }, [
        host,
        port,
    ]);

    useEffect(() => {
        let disposed = false;

        void loadConnectionProfiles()
            .then((savedProfiles) => {
                if (!disposed) {
                    setProfiles(savedProfiles);
                }
            })
            .catch((error: unknown) => {
                if (!disposed) {
                    setProfileError(
                        error instanceof Error
                            ? error.message
                            : String(error),
                    );
                }
            })
            .finally(() => {
                if (!disposed) {
                    setProfilesLoading(false);
                }
            });

        return () => {
            disposed = true;
        };
    }, []);

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
                            const accepted =
                                await confirmDialog(
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
                                        title:
                                            "Verify SSH Host",
                                        kind: "warning",
                                    },
                                );

                            await backendClient.decideHostKey(
                                hostKey.connectionId,
                                accepted,
                            );

                            if (!accepted) {
                                return;
                            }

                            const savedHost =
                                await saveKnownHost({
                                    host: hostKey.host,
                                    port: hostKey.port,

                                    keyType:
                                        hostKey.keyType,

                                    fingerprint:
                                        hostKey.fingerprint,
                                });

                            setKnownHostRecord(
                                savedHost,
                            );
                        } catch (error) {
                            setConnectionState(
                                "Connection failed",
                            );

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

                if (
                    event.type ===
                    "connection.hostKeyVerified"
                ) {
                    const verifiedHost =
                        event.payload as HostKeyVerifiedEvent;

                    void markKnownHostVerified(
                        verifiedHost.host,
                        verifiedHost.port,
                    ).catch((error: unknown) => {
                        console.error(
                            "Unable to update known host:",
                            error,
                        );
                    });

                    return;
                }

                if (
                    event.type ===
                    "connection.hostKeyMismatch"
                ) {
                    const mismatch =
                        event.payload as HostKeyMismatchEvent;

                    const message = [
                        "The SSH server identity has changed.",
                        "",
                        `Host: ${mismatch.host}:${mismatch.port}`,
                        "",
                        `Expected: ${mismatch.expectedFingerprint}`,
                        `Received: ${mismatch.receivedFingerprint}`,
                        "",
                        "The connection was blocked. This may indicate that the server was reinstalled, its SSH keys were changed, or someone is intercepting the connection.",
                    ].join("\n");

                    securityErrorRef.current =
                        message;

                    setConnectionState(
                        "Host key changed",
                    );

                    setErrorMessage(message);
                    setIsConnecting(false);

                    return;
                }

                if (
                    event.type ===
                    "connection.failed"
                ) {
                    const payload = event.payload as {
                        message?: string;
                    };

                    if (securityErrorRef.current) {
                        setConnectionState(
                            "Host key changed",
                        );

                        setErrorMessage(
                            securityErrorRef.current,
                        );
                    } else {
                        setConnectionState(
                            "Connection failed",
                        );

                        setErrorMessage(
                            payload.message ??
                            "Unable to establish the SSH connection.",
                        );
                    }

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

    async function refreshProfiles():
        Promise<void> {
        const savedProfiles =
            await loadConnectionProfiles();

        setProfiles(savedProfiles);
    }

    function handleSelectProfile(
        profile: SavedConnectionProfile,
    ): void {
        setSelectedProfileId(profile.id);
        setProfileName(profile.name);

        setHost(profile.host);
        setPort(String(profile.port));
        setUsername(profile.username);

        setAuthenticationType(
            profile.authenticationType,
        );

        // Sensitive values are intentionally
        // not stored in the normal profile store.
        setPassword("");
        setPrivateKey("");
        setPassphrase("");

        setErrorMessage("");
        setProfileError("");
    }

    function handleNewProfile(): void {
        setSelectedProfileId(null);
        setProfileName("");

        setHost("");
        setPort("22");
        setUsername("");

        setAuthenticationType("password");

        setPassword("");
        setPrivateKey("");
        setPassphrase("");

        setConnectionState(
            "Not connected",
        );

        setErrorMessage("");
        setProfileError("");
    }

    async function handleSaveProfile():
        Promise<SavedConnectionProfile | null> {
        setProfileError("");

        const trimmedName =
            profileName.trim();

        if (!trimmedName) {
            setProfileError(
                "Enter a profile name before saving.",
            );

            return null;
        }

        const parsedPort = Number(port);

        if (
            !host.trim() ||
            !username.trim() ||
            !Number.isInteger(parsedPort) ||
            parsedPort < 1 ||
            parsedPort > 65_535
        ) {
            setProfileError(
                "Enter a valid host, port and username.",
            );

            return null;
        }

        try {
            const savedProfile =
                await saveConnectionProfile({
                    ...(selectedProfileId
                        ? {
                            id: selectedProfileId,
                        }
                        : {}),

                    name: trimmedName,
                    host,
                    port: parsedPort,
                    username,

                    authenticationType,
                });

            setSelectedProfileId(
                savedProfile.id,
            );

            await refreshProfiles();

            return savedProfile;
        } catch (error) {
            setProfileError(
                error instanceof Error
                    ? error.message
                    : String(error),
            );

            return null;
        }
    }

    async function handleDeleteProfile(
        profile: SavedConnectionProfile,
    ): Promise<void> {
        const confirmed = window.confirm(
            `Delete the saved connection "${profile.name}"?`,
        );

        if (!confirmed) {
            return;
        }

        try {
            await deleteConnectionProfile(
                profile.id,
            );

            if (
                selectedProfileId === profile.id
            ) {
                handleNewProfile();
            }

            await refreshProfiles();
        } catch (error) {
            setProfileError(
                error instanceof Error
                    ? error.message
                    : String(error),
            );
        }
    }

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

        securityErrorRef.current = null;

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

            const rememberedHost =
                await loadKnownHost(
                    host.trim(),
                    Number(port),
                );

            const newConnectionId =
                await backendClient.connectSsh({
                    host: host.trim(),
                    port: Number(port),
                    username: username.trim(),

                    authentication,

                    ...(rememberedHost
                        ? {
                            knownHostFingerprint:
                                rememberedHost.fingerprint,
                        }
                        : {}),
                });

            setConnectionId(newConnectionId);
            setConnectionState("Connected");

            let activeProfileId =
                selectedProfileId;

            if (profileName.trim()) {
                try {
                    const savedProfile =
                        await saveConnectionProfile({
                            ...(selectedProfileId
                                ? {
                                    id: selectedProfileId,
                                }
                                : {}),

                            name: profileName,
                            host: host.trim(),
                            port: Number(port),
                            username: username.trim(),

                            authenticationType,
                        });

                    activeProfileId =
                        savedProfile.id;

                    setSelectedProfileId(
                        savedProfile.id,
                    );
                    // } catch (profileSaveError) {
                    //     console.error(
                    //         "Unable to save connection profile:",
                    //         profileSaveError,
                    //     );
                    // }

                } catch (error) {
                    const message =
                        securityErrorRef.current ??
                        (
                            error instanceof Error
                                ? error.message
                                : String(error)
                        );

                    setConnectionState(
                        securityErrorRef.current
                            ? "Host key changed"
                            : "Connection failed",
                    );

                    setErrorMessage(message);
                }
            }

            if (activeProfileId) {
                try {
                    await markProfileConnected(
                        activeProfileId,
                    );

                    await refreshProfiles();
                } catch (profileUpdateError) {
                    console.error(
                        "Unable to update recent connection:",
                        profileUpdateError,
                    );
                }
            }

            onConnected({
                connectionId: newConnectionId,

                title:
                    profileName.trim() ||
                    `${username.trim()}@${host.trim()}`,

                host: host.trim(),
                port: Number(port),
                username: username.trim(),
            });
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

    async function handleForgetHostKey():
        Promise<void> {
        if (!knownHostRecord) {
            return;
        }

        const confirmed =
            await confirmDialog(
                [
                    `Forget the trusted host key for ${knownHostRecord.host}:${knownHostRecord.port}?`,
                    "",
                    "The fingerprint confirmation will be shown again the next time you connect.",
                ].join("\n"),
                {
                    title:
                        "Forget trusted host key?",
                    kind: "warning",
                },
            );

        if (!confirmed) {
            return;
        }

        try {
            await deleteKnownHost(
                knownHostRecord.host,
                knownHostRecord.port,
            );

            setKnownHostRecord(null);
        } catch (error) {
            setErrorMessage(
                error instanceof Error
                    ? error.message
                    : String(error),
            );
        }
    }

    return (
        <main className="connection-home-page">
            <SavedConnectionsPanel
                profiles={profiles}
                selectedProfileId={
                    selectedProfileId
                }
                loading={profilesLoading}
                onSelect={handleSelectProfile}
                onNew={handleNewProfile}
                onDelete={(profile) => {
                    void handleDeleteProfile(
                        profile,
                    );
                }}
            />

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
                        <span className="connection-status">
                            SSH: {connectionState}
                        </span>
                    </div>
                </header>

                <form
                    className="ssh-form"
                    onSubmit={handleConnect}
                >
                    <label>
                        <span>
                            Profile name
                            <small className="optional-label">
                                Optional
                            </small>
                        </span>

                        <input
                            value={profileName}
                            onChange={(event) =>
                                setProfileName(
                                    event.target.value,
                                )
                            }
                            placeholder="Production server"
                            disabled={isConnecting}
                        />
                    </label>
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

                    {knownHostRecord && (
                        <div className="known-host-notice">
                            <div className="known-host-notice__content">
                                <span className="known-host-notice__icon">
                                    <Check size={16} />
                                </span>

                                <div>
                                    <strong>
                                        Trusted host key saved
                                    </strong>

                                    <span>
                                        {knownHostRecord.keyType}
                                        {" · "}
                                        {knownHostRecord.fingerprint}
                                    </span>
                                </div>
                            </div>

                            <button
                                type="button"
                                className="known-host-forget-button"
                                onClick={() => {
                                    void handleForgetHostKey();
                                }}
                                disabled={isConnecting}
                            >
                                Forget
                            </button>
                        </div>
                    )}

                    {authenticationType === "password" ? (
                        <label>
                            <span>Password</span>
                            <div className="pass-div">
                                <input
                                    type={isVisible ? "text" : "password"}
                                    value={password}
                                    onChange={(event) =>
                                        setPassword(event.target.value)
                                    }
                                    disabled={Boolean(connectionId)}
                                    autoComplete="current-password"
                                />
                                {
                                    isVisible
                                        ? <EyeOff onClick={() => setIsVisible(!isVisible)} size={16} />
                                        : <Eye onClick={() => setIsVisible(!isVisible)} size={16} />
                                }
                            </div>
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
                                    placeholder="----- OPENSSH PRIVATE KEY -----"
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
                            type="button"
                            className="secondary-button"
                            onClick={() => {
                                void handleSaveProfile();
                            }}
                            disabled={
                                isConnecting ||
                                !profileName.trim()
                            }
                        >
                            {selectedProfileId
                                ? "Update profile"
                                : "Save profile"}
                        </button>

                        <button
                            type="submit"
                            disabled={!canConnect}
                        >
                            {isConnecting
                                ? "Connecting..."
                                : "Connect"}
                        </button>
                    </div>

                    {profileError && (
                        <div className="error-message">
                            {profileError}
                        </div>
                    )}

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
