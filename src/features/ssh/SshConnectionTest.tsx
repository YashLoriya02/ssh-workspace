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
    SshConnectionJourney,
    type ConnectionJourneyPhase,
} from "./SshConnectionJourney";

import {
    deleteConnectionProfile,
    loadConnectionProfiles,
    markProfileConnected,
    saveConnectionProfile,
    type SavedConnectionProfile,
} from "../../store/connection-profile-store";

import {
    deleteSshPassword,
    loadSshPassword,
    saveSshPassword,
} from "../../store/ssh-credential-store";

import {
    deleteKnownHost,
    loadKnownHost,
    markKnownHostVerified,
    saveKnownHost,
    type KnownHostRecord,
} from "../../store/known-host-store";
import { Check, Eye, EyeOff } from "lucide-react";

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

type SavedPasswordState =
    | "idle"
    | "loading"
    | "loaded";

const MIN_CONNECTION_JOURNEY_MS =
    3_200;

const CONNECTION_SUCCESS_HOLD_MS =
    650;

function wait(
    durationMs: number,
): Promise<void> {
    return new Promise((resolve) => {
        window.setTimeout(
            resolve,
            durationMs,
        );
    });
}

export function SshConnectionTest({
    onConnected,
}: SshConnectionTestProps) {
    const [backendState, setBackendState] =
        useState<BackendState>({
            status: "stopped",
        });

    const [
        pendingAutoConnectProfileId,
        setPendingAutoConnectProfileId,
    ] = useState<string | null>(
        null,
    );

    const connectionFormRef =
        useRef<HTMLFormElement | null>(
            null,
        );

    const [host, setHost] = useState("");
    const [port, setPort] = useState("22");
    const [username, setUsername] = useState("");

    const [authenticationType, setAuthenticationType] =
        useState<AuthenticationType>("password");

    const [isVisible, setIsVisible] = useState<boolean>(false);

    const [password, setPassword] = useState("");
    const [privateKey, setPrivateKey] = useState("");
    const [passphrase, setPassphrase] = useState("");
    const [savedPasswordState, setSavedPasswordState,] = useState<SavedPasswordState>("idle",);

    const [connectionId, setConnectionId] = useState<string | null>(null);

    const [connectionState, setConnectionState] =
        useState("Not connected");

    const [errorMessage, setErrorMessage] =
        useState("");

    const [isConnecting, setIsConnecting] =
        useState(false);


    const [
        journeyPhase,
        setJourneyPhase,
    ] = useState<ConnectionJourneyPhase>(
        "idle",
    );

    const [
        journeyMessage,
        setJourneyMessage,
    ] = useState("");

    const [
        journeyTarget,
        setJourneyTarget,
    ] = useState({
        profileName: "",
        host: "",
        port: 22,
        username: "",
    });

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

    const credentialLoadVersionRef = useRef(0);

    const securityErrorRef =
        useRef<string | null>(null);


    const journeyPhaseRef =
        useRef<ConnectionJourneyPhase>(
            "idle",
        );

    const journeyStartedAtRef =
        useRef(0);

    const journeyTimersRef =
        useRef<number[]>([]);

    const journeyCancelledRef =
        useRef(false);

    const awaitingHostApprovalRef =
        useRef(false);

    const backendConnected =
        backendState.status === "connected";

    function clearJourneyTimers(): void {
        for (
            const timerId of
            journeyTimersRef.current
        ) {
            window.clearTimeout(
                timerId,
            );
        }

        journeyTimersRef.current = [];
    }

    function updateJourney(
        phase: ConnectionJourneyPhase,
        message: string,
    ): void {
        journeyPhaseRef.current =
            phase;

        setJourneyPhase(
            phase,
        );

        setJourneyMessage(
            message,
        );
    }

    function resetJourney(): void {
        clearJourneyTimers();

        journeyCancelledRef.current =
            false;

        awaitingHostApprovalRef.current =
            false;

        updateJourney(
            "idle",
            "",
        );
    }

    function scheduleJourneyPhase(
        delayMs: number,
        phase: ConnectionJourneyPhase,
        message: string,
    ): void {
        const timerId =
            window.setTimeout(
                () => {
                    if (
                        journeyCancelledRef.current ||
                        awaitingHostApprovalRef.current ||
                        [
                            "connected",
                            "failed",
                            "cancelled",
                            "disconnected",
                        ].includes(
                            journeyPhaseRef.current,
                        )
                    ) {
                        return;
                    }

                    updateJourney(
                        phase,
                        message,
                    );
                },
                delayMs,
            );

        journeyTimersRef.current.push(
            timerId,
        );
    }

    function startConnectionJourney(
        nextTarget: {
            profileName: string;
            host: string;
            port: number;
            username: string;
        },
    ): void {
        clearJourneyTimers();

        journeyStartedAtRef.current =
            performance.now();

        journeyCancelledRef.current =
            false;

        awaitingHostApprovalRef.current =
            false;

        setJourneyTarget(
            nextTarget,
        );

        updateJourney(
            "preparing",
            "Preparing your SSH connection…",
        );

        scheduleJourneyPhase(
            450,
            "opening-channel",
            "Opening a secure channel…",
        );

        scheduleJourneyPhase(
            1_150,
            "verifying-host",
            "Checking the server identity…",
        );

        scheduleJourneyPhase(
            2_000,
            "authenticating",
            "Authenticating securely…",
        );
    }

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
        if (
            !pendingAutoConnectProfileId ||
            pendingAutoConnectProfileId !==
            selectedProfileId ||
            !canConnect ||
            isConnecting ||
            connectionId
        ) {
            return;
        }

        setPendingAutoConnectProfileId(
            null,
        );

        connectionFormRef.current
            ?.requestSubmit();
    }, [
        canConnect,
        connectionId,
        isConnecting,
        pendingAutoConnectProfileId,
        selectedProfileId,
    ]);

    useEffect(() => {
        return () => {
            clearJourneyTimers();
        };
    }, []);

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

                    awaitingHostApprovalRef.current =
                        true;

                    updateJourney(
                        "verifying-host",
                        "Waiting for server identity approval…",
                    );

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

                            awaitingHostApprovalRef.current =
                                false;

                            if (!accepted) {
                                journeyCancelledRef.current =
                                    true;

                                clearJourneyTimers();

                                updateJourney(
                                    "cancelled",
                                    "Server identity verification was cancelled.",
                                );

                                setConnectionState(
                                    "Cancelled",
                                );

                                return;
                            }

                            updateJourney(
                                "authenticating",
                                "Server identity verified. Authenticating…",
                            );

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
                            const message =
                                error instanceof Error
                                    ? error.message
                                    : String(error);

                            awaitingHostApprovalRef.current =
                                false;

                            clearJourneyTimers();

                            updateJourney(
                                "failed",
                                message,
                            );

                            setConnectionState(
                                "Connection failed",
                            );

                            setIsConnecting(false);

                            setErrorMessage(
                                message,
                            );
                        }
                    })();

                    return;
                }

                if (event.type === "connection.connected") {
                    if (
                        journeyPhaseRef.current !==
                        "connected"
                    ) {
                        updateJourney(
                            "authenticating",
                            "Secure channel established. Preparing the workspace…",
                        );
                    }

                    setConnectionState(
                        "Finalizing...",
                    );

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

                    awaitingHostApprovalRef.current =
                        false;

                    updateJourney(
                        "authenticating",
                        "Server identity verified. Authenticating…",
                    );

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

                    clearJourneyTimers();

                    updateJourney(
                        "failed",
                        "The server identity changed, so the connection was blocked.",
                    );

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

                    const failureMessage =
                        securityErrorRef.current ??
                        payload.message ??
                        "Unable to establish the SSH connection.";

                    clearJourneyTimers();

                    if (
                        journeyCancelledRef.current
                    ) {
                        updateJourney(
                            "cancelled",
                            "Connection cancelled",
                        );
                    } else {
                        updateJourney(
                            "failed",
                            failureMessage,
                        );
                    }

                    if (securityErrorRef.current) {
                        setConnectionState(
                            "Host key changed",
                        );
                    } else if (
                        journeyCancelledRef.current
                    ) {
                        setConnectionState(
                            "Cancelled",
                        );
                    } else {
                        setConnectionState(
                            "Connection failed",
                        );
                    }

                    setErrorMessage(
                        journeyCancelledRef.current
                            ? ""
                            : failureMessage,
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

                    if (
                        journeyPhaseRef.current !==
                        "idle"
                    ) {
                        clearJourneyTimers();

                        updateJourney(
                            "disconnected",
                            "The SSH session was closed.",
                        );
                    }

                    return;
                }

                if (event.type === "connection.error") {
                    const payload = event.payload as {
                        message?: string;
                    };

                    const message =
                        payload.message ??
                        "SSH connection error.";

                    setErrorMessage(
                        message,
                    );

                    if (
                        ![
                            "idle",
                            "connected",
                            "failed",
                            "cancelled",
                            "disconnected",
                        ].includes(
                            journeyPhaseRef.current,
                        )
                    ) {
                        clearJourneyTimers();

                        updateJourney(
                            "failed",
                            message,
                        );
                    }
                }
            });

        return () => {
            unsubscribeState();
            unsubscribeEvents();
        };
    }, []);

    async function refreshProfiles(): Promise<void> {
        const savedProfiles =
            await loadConnectionProfiles();

        setProfiles(savedProfiles);
    }

    function cancelSavedPasswordLoad(
        clearPassword:
            boolean = true,
    ): void {
        credentialLoadVersionRef.current +=
            1;

        setSavedPasswordState(
            "idle",
        );

        if (clearPassword) {
            setPassword("");
        }
    }

    function clearAutomaticallyLoadedPassword():
        void {
        if (
            savedPasswordState ===
            "loaded" ||
            savedPasswordState ===
            "loading"
        ) {
            cancelSavedPasswordLoad(
                true,
            );
        }
    }

    async function loadSavedPasswordForProfile(
        profile:
            SavedConnectionProfile,
    ): Promise<void> {
        const requestVersion =
            credentialLoadVersionRef.current +
            1;

        credentialLoadVersionRef.current =
            requestVersion;

        setPassword("");

        if (
            profile.authenticationType !==
            "password"
        ) {
            setSavedPasswordState(
                "idle",
            );

            return;
        }

        setSavedPasswordState(
            "loading",
        );

        try {
            const savedPassword =
                await loadSshPassword(
                    profile.id,
                );

            if (
                credentialLoadVersionRef
                    .current !==
                requestVersion
            ) {
                return;
            }

            if (savedPassword) {
                setPassword(
                    savedPassword,
                );

                setSavedPasswordState(
                    "loaded",
                );
            } else {
                setPassword("");

                setSavedPasswordState(
                    "idle",
                );
            }
        } catch (error) {
            if (
                credentialLoadVersionRef
                    .current !==
                requestVersion
            ) {
                return;
            }

            setPassword("");

            setSavedPasswordState(
                "idle",
            );

            setProfileError(
                error instanceof Error
                    ? error.message
                    : String(error),
            );
        }
    }

    function populateProfile(
        profile:
            SavedConnectionProfile,

        shouldLoadPassword:
            boolean,
    ): void {
        /*
         * Cancel any previous credential lookup.
         */
        credentialLoadVersionRef.current +=
            1;

        setPendingAutoConnectProfileId(
            null,
        );

        setSelectedProfileId(
            profile.id,
        );

        setProfileName(
            profile.name,
        );

        setHost(
            profile.host,
        );

        setPort(
            String(profile.port),
        );

        setUsername(
            profile.username,
        );

        setAuthenticationType(
            profile.authenticationType,
        );

        setPassword("");
        setPrivateKey("");
        setPassphrase("");

        setSavedPasswordState(
            "idle",
        );

        setErrorMessage("");
        setProfileError("");

        if (!isConnecting) {
            resetJourney();
        }

        if (shouldLoadPassword) {
            void loadSavedPasswordForProfile(
                profile,
            );
        }
    }

    function handleSelectProfile(
        profile:
            SavedConnectionProfile,
    ): void {
        populateProfile(
            profile,
            true,
        );
    }

    async function handleOpenProfile(
        profile:
            SavedConnectionProfile,
    ): Promise<void> {
        if (
            isConnecting ||
            connectionId
        ) {
            return;
        }

        /*
         * Populate all visible form fields, but handle
         * password loading here so we know exactly when
         * it has finished.
         */
        populateProfile(
            profile,
            false,
        );

        if (
            profile.authenticationType ===
            "privateKey"
        ) {
            setProfileError(
                "This saved connection uses private-key authentication. Enter the private key, then click Connect.",
            );

            return;
        }

        const requestVersion =
            credentialLoadVersionRef.current +
            1;

        credentialLoadVersionRef.current =
            requestVersion;

        setSavedPasswordState(
            "loading",
        );

        try {
            const savedPassword =
                await loadSshPassword(
                    profile.id,
                );

            if (
                credentialLoadVersionRef
                    .current !==
                requestVersion
            ) {
                return;
            }

            if (!savedPassword) {
                setPassword("");

                setSavedPasswordState(
                    "idle",
                );

                setProfileError(
                    "No saved password was found for this connection. Enter the password once and click Connect.",
                );

                return;
            }

            setPassword(
                savedPassword,
            );

            setSavedPasswordState(
                "loaded",
            );

            /*
             * The effect below submits after React has
             * applied the profile and password state.
             */
            setPendingAutoConnectProfileId(
                profile.id,
            );
        } catch (error) {
            if (
                credentialLoadVersionRef
                    .current !==
                requestVersion
            ) {
                return;
            }

            setPassword("");

            setSavedPasswordState(
                "idle",
            );

            setProfileError(
                error instanceof Error
                    ? error.message
                    : String(error),
            );
        }
    }

    function handleNewProfile(): void {
        resetJourney();

        setPendingAutoConnectProfileId(
            null,
        );

        cancelSavedPasswordLoad(
            true,
        );

        setSelectedProfileId(null);
        setProfileName("");

        setHost("");
        setPort("22");
        setUsername("");

        setAuthenticationType("password");

        setPrivateKey("");
        setPassphrase("");

        setConnectionState(
            "Not connected",
        );

        setErrorMessage("");
        setProfileError("");
    }

    async function handleSaveProfile():
        Promise<
            SavedConnectionProfile |
            null
        > {
        setProfileError("");

        const trimmedName =
            profileName.trim();

        if (!trimmedName) {
            setProfileError(
                "Enter a profile name before saving.",
            );

            return null;
        }

        const parsedPort =
            Number(port);

        if (
            !host.trim() ||
            !username.trim() ||
            !Number.isInteger(
                parsedPort,
            ) ||
            parsedPort < 1 ||
            parsedPort > 65_535
        ) {
            setProfileError(
                "Enter a valid host, port and username.",
            );

            return null;
        }

        const previousProfile =
            selectedProfileId
                ? profiles.find(
                    (profile) =>
                        profile.id ===
                        selectedProfileId,
                )
                : undefined;

        try {
            const savedProfile =
                await saveConnectionProfile({
                    ...(selectedProfileId
                        ? {
                            id:
                                selectedProfileId,
                        }
                        : {}),

                    name:
                        trimmedName,

                    host,
                    port:
                        parsedPort,

                    username,

                    authenticationType,
                });

            setSelectedProfileId(
                savedProfile.id,
            );

            /*
             * Remove the previous saved password when
             * the profile now points to another account,
             * server or authentication mechanism.
             */
            const credentialIdentityChanged =
                Boolean(
                    previousProfile &&
                    (
                        previousProfile.host
                            .trim()
                            .toLowerCase() !==
                        host
                            .trim()
                            .toLowerCase() ||

                        previousProfile.port !==
                        parsedPort ||

                        previousProfile.username
                            .trim() !==
                        username.trim() ||

                        previousProfile
                            .authenticationType !==
                        authenticationType
                    ),
                );

            if (
                credentialIdentityChanged ||
                authenticationType !==
                "password"
            ) {
                try {
                    await deleteSshPassword(
                        savedProfile.id,
                    );

                    cancelSavedPasswordLoad(
                        true,
                    );
                } catch (credentialError) {
                    setProfileError(
                        [
                            "Profile saved, but its previous password could not be removed.",
                            credentialError instanceof
                                Error
                                ? credentialError.message
                                : String(
                                    credentialError,
                                ),
                        ].join(" "),
                    );
                }
            }

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
        profile:
            SavedConnectionProfile,
    ): Promise<void> {
        const confirmed =
            window.confirm(
                `Delete the saved connection "${profile.name}" and its saved password?`,
            );

        if (!confirmed) {
            return;
        }

        try {
            /*
             * Remove the sensitive credential first.
             * If this fails, retain the profile so the
             * user can retry instead of orphaning it.
             */
            await deleteSshPassword(
                profile.id,
            );

            await deleteConnectionProfile(
                profile.id,
            );

            if (
                selectedProfileId ===
                profile.id
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

    function handleConnect(
        event:
            FormEvent<HTMLFormElement>,
    ): void {
        event.preventDefault();

        void performConnection();
    }

    async function performConnection():
        Promise<void> {
        setPendingAutoConnectProfileId(
            null,
        );

        if (!canConnect) {
            return;
        }

        setErrorMessage("");
        setProfileError("");

        setConnectionState(
            "Connecting...",
        );

        setIsConnecting(true);

        securityErrorRef.current =
            null;

        const normalizedHost =
            host.trim();

        const normalizedUsername =
            username.trim();

        const parsedPort =
            Number(port);

        startConnectionJourney({
            profileName:
                profileName.trim(),
            host:
                normalizedHost,
            port:
                parsedPort,
            username:
                normalizedUsername,
        });

        /*
         * Capture the password used for this exact
         * connection attempt. It is persisted only
         * after connectSsh() succeeds.
         */
        const passwordUsed =
            password;

        try {
            if (!backendConnected) {
                await backendClient.start();
            }

            const authentication =
                authenticationType ===
                    "password"
                    ? {
                        type:
                            "password" as const,

                        password:
                            passwordUsed,
                    }
                    : {
                        type:
                            "privateKey" as const,

                        privateKey,

                        ...(passphrase
                            ? {
                                passphrase,
                            }
                            : {}),
                    };

            const rememberedHost =
                await loadKnownHost(
                    normalizedHost,
                    parsedPort,
                );

            const newConnectionId =
                await backendClient
                    .connectSsh({
                        host:
                            normalizedHost,

                        port:
                            parsedPort,

                        username:
                            normalizedUsername,

                        authentication,

                        ...(rememberedHost
                            ? {
                                knownHostFingerprint:
                                    rememberedHost
                                        .fingerprint,
                            }
                            : {}),
                    });

            /*
             * Nothing below this point runs unless
             * SSH authentication succeeded.
             */
            setConnectionId(
                newConnectionId,
            );

            setConnectionState(
                "Connected",
            );

            /*
             * Avoid creating a duplicate when the same
             * host/account already has a saved profile.
             */
            const matchingProfile =
                profiles.find(
                    (profile) =>
                        profile.host
                            .trim()
                            .toLowerCase() ===
                        normalizedHost
                            .toLowerCase() &&

                        profile.port ===
                        parsedPort &&

                        profile.username
                            .trim() ===
                        normalizedUsername &&

                        profile
                            .authenticationType ===
                        authenticationType,
                );

            const profileIdToSave =
                selectedProfileId ??
                matchingProfile?.id;

            const effectiveProfileName =
                profileName.trim() ||
                matchingProfile?.name ||
                `${normalizedUsername}@${normalizedHost}`;

            let savedProfile:
                SavedConnectionProfile |
                null = null;

            try {
                savedProfile =
                    await saveConnectionProfile({
                        ...(profileIdToSave
                            ? {
                                id:
                                    profileIdToSave,
                            }
                            : {}),

                        name:
                            effectiveProfileName,

                        host:
                            normalizedHost,

                        port:
                            parsedPort,

                        username:
                            normalizedUsername,

                        authenticationType,
                    });

                setSelectedProfileId(
                    savedProfile.id,
                );

                setProfileName(
                    savedProfile.name,
                );
            } catch (
            profileSaveError
            ) {
                console.error(
                    "SSH connected, but the profile could not be saved:",
                    profileSaveError,
                );

                setProfileError(
                    [
                        "Connected, but the connection profile could not be saved.",
                        profileSaveError instanceof
                            Error
                            ? profileSaveError.message
                            : String(
                                profileSaveError,
                            ),
                    ].join(" "),
                );
            }

            if (savedProfile) {
                try {
                    if (
                        authenticationType ===
                        "password"
                    ) {
                        await saveSshPassword(
                            savedProfile.id,
                            passwordUsed,
                        );

                        setSavedPasswordState(
                            "loaded",
                        );
                    } else {
                        /*
                         * Switching a profile to
                         * private-key authentication
                         * removes an old password.
                         */
                        await deleteSshPassword(
                            savedProfile.id,
                        );

                        setSavedPasswordState(
                            "idle",
                        );
                    }
                } catch (
                credentialError
                ) {
                    console.error(
                        "SSH connected, but the password could not be saved securely:",
                        credentialError,
                    );

                    setProfileError(
                        [
                            "Connected, but the password could not be saved securely.",
                            credentialError instanceof
                                Error
                                ? credentialError.message
                                : String(
                                    credentialError,
                                ),
                        ].join(" "),
                    );
                }

                try {
                    await markProfileConnected(
                        savedProfile.id,
                    );

                    await refreshProfiles();
                } catch (
                profileUpdateError
                ) {
                    console.error(
                        "Unable to update recent connection:",
                        profileUpdateError,
                    );
                }
            }

            clearJourneyTimers();

            updateJourney(
                "authenticating",
                "Secure channel ready. Finalizing the workspace…",
            );

            const elapsedJourneyMs =
                performance.now() -
                journeyStartedAtRef.current;

            await wait(
                Math.max(
                    0,
                    MIN_CONNECTION_JOURNEY_MS -
                    elapsedJourneyMs,
                ),
            );

            setConnectionState(
                "Connected",
            );

            updateJourney(
                "connected",
                "Connected securely",
            );

            await wait(
                CONNECTION_SUCCESS_HOLD_MS,
            );

            onConnected({
                connectionId:
                    newConnectionId,

                title:
                    savedProfile?.name ??
                    effectiveProfileName,

                host:
                    normalizedHost,

                port:
                    parsedPort,

                username:
                    normalizedUsername,
            });
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : String(error);

            clearJourneyTimers();

            if (
                journeyCancelledRef.current
            ) {
                updateJourney(
                    "cancelled",
                    "Connection cancelled",
                );

                setConnectionState(
                    "Cancelled",
                );

                setErrorMessage("");
            } else {
                updateJourney(
                    "failed",
                    message,
                );

                setConnectionState(
                    "Connection failed",
                );

                setErrorMessage(
                    message,
                );
            }
        } finally {
            setIsConnecting(false);
        }
    }

    function handleBackFromJourney(): void {
        resetJourney();
    }

    function handleRetryJourney(): void {
        if (
            isConnecting ||
            connectionId
        ) {
            return;
        }

        resetJourney();

        /*
         * performConnection() starts the new journey before
         * its first await. React therefore batches the reset
         * and restart without flashing the form in between.
         */
        void performConnection();
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

    if (journeyPhase !== "idle") {
        return (
            <SshConnectionJourney
                page
                phase={journeyPhase}
                profileName={
                    journeyTarget.profileName
                }
                host={
                    journeyTarget.host
                }
                port={
                    journeyTarget.port
                }
                username={
                    journeyTarget.username
                }
                message={
                    journeyMessage
                }
                onBack={
                    handleBackFromJourney
                }
                onRetry={
                    handleRetryJourney
                }
            />
        );
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
                onOpen={(profile) => {
                    void handleOpenProfile(
                        profile,
                    );
                }}
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
                        <h1>SSH Connection</h1>
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
                    ref={connectionFormRef}
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
                                onChange={(event) => {
                                    clearAutomaticallyLoadedPassword();
                                    setHost(event.target.value);
                                }}
                                placeholder="192.168.1.50 or server.example.com"
                                disabled={Boolean(connectionId)}
                                autoComplete="off"
                            />
                        </label>

                        <label>
                            <span>Port</span>
                            <input
                                value={port}
                                onChange={(event) => {
                                    clearAutomaticallyLoadedPassword();
                                    setPort(event.target.value);
                                }}
                                inputMode="numeric"
                                disabled={Boolean(connectionId)}
                            />
                        </label>

                        <label>
                            <span>Username</span>
                            <input
                                value={username}
                                onChange={(event) => {
                                    clearAutomaticallyLoadedPassword();
                                    setUsername(event.target.value);
                                }}
                                placeholder="ubuntu"
                                disabled={Boolean(connectionId)}
                                autoComplete="username"
                            />
                        </label>

                        <label>
                            <span>Authentication</span>

                            <div className="select-wrapper">
                                <select
                                    value={authenticationType}
                                    onChange={(event) => {
                                        const nextAuthenticationType =
                                            event.target
                                                .value as AuthenticationType;

                                        cancelSavedPasswordLoad(
                                            true,
                                        );

                                        setAuthenticationType(
                                            nextAuthenticationType,
                                        );

                                        if (
                                            nextAuthenticationType ===
                                            "password" &&
                                            selectedProfileId
                                        ) {
                                            const selectedProfile =
                                                profiles.find(
                                                    (profile) =>
                                                        profile.id ===
                                                        selectedProfileId,
                                                );

                                            if (selectedProfile) {
                                                void loadSavedPasswordForProfile({
                                                    ...selectedProfile,

                                                    authenticationType:
                                                        "password",
                                                });
                                            }
                                        }
                                    }}
                                    disabled={Boolean(connectionId)}
                                >
                                    <option value="password">
                                        Password
                                    </option>
                                    <option value="privateKey">
                                        Private key
                                    </option>
                                </select>
                            </div>
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
                            <span className="password-label">
                                <span>Password</span>

                                {savedPasswordState ===
                                    "loading" && (
                                        <small className="credential-status">
                                            Loading saved password…
                                        </small>
                                    )}

                                {savedPasswordState ===
                                    "loaded" && (
                                        <small className="credential-status credential-status--saved">
                                            <Check size={12} />

                                            Saved password loaded
                                        </small>
                                    )}
                            </span>

                            <div className="pass-div">
                                <input
                                    type={
                                        isVisible
                                            ? "text"
                                            : "password"
                                    }
                                    value={password}
                                    onChange={(event) => {
                                        /*
                                         * Prevent an in-flight native
                                         * credential lookup from overwriting
                                         * what the user is typing.
                                         */
                                        credentialLoadVersionRef
                                            .current += 1;

                                        setSavedPasswordState(
                                            "idle",
                                        );

                                        setPassword(
                                            event.target.value,
                                        );
                                    }}
                                    disabled={
                                        Boolean(
                                            connectionId,
                                        ) ||
                                        savedPasswordState ===
                                        "loading"
                                    }
                                    autoComplete="current-password"
                                />

                                {isVisible ? (
                                    <EyeOff
                                        onClick={() =>
                                            setIsVisible(
                                                false,
                                            )
                                        }
                                        size={16}
                                    />
                                ) : (
                                    <Eye
                                        onClick={() =>
                                            setIsVisible(
                                                true,
                                            )
                                        }
                                        size={16}
                                    />
                                )}
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
