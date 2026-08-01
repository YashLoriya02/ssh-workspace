import {
    useRef,
} from "react";

import {
    ArrowLeft,
    Check,
    CircleAlert,
    Laptop,
    RotateCcw,
    Server,
    ShieldCheck,
    Unplug,
    X,
} from "lucide-react";

export type ConnectionJourneyPhase =
    | "idle"
    | "preparing"
    | "opening-channel"
    | "verifying-host"
    | "authenticating"
    | "connected"
    | "failed"
    | "cancelled"
    | "disconnecting"
    | "disconnected";

interface SshConnectionJourneyProps {
    phase: ConnectionJourneyPhase;

    profileName?: string;
    host: string;
    port: number;
    username: string;

    message?: string;
    compact?: boolean;
    page?: boolean;

    onBack?: () => void;
    onRetry?: () => void;
}

const PHASE_PROGRESS: Record<
    ConnectionJourneyPhase,
    number
> = {
    idle: 0,
    preparing: 10,
    "opening-channel": 34,
    "verifying-host": 57,
    authenticating: 80,
    connected: 100,

    /*
     * Failure and cancellation use a sensible minimum,
     * but the rendered progress is never allowed to move
     * backwards from a phase already reached.
     */
    failed: 72,
    cancelled: 50,

    disconnecting: 100,
    disconnected: 0,
};

function getDefaultMessage(
    phase: ConnectionJourneyPhase,
): string {
    switch (phase) {
        case "preparing":
            return "Preparing your SSH connection…";

        case "opening-channel":
            return "Opening a secure channel…";

        case "verifying-host":
            return "Verifying the server identity…";

        case "authenticating":
            return "Authenticating and preparing the workspace…";

        case "connected":
            return "Connected securely";

        case "failed":
            return "The SSH connection could not be established";

        case "cancelled":
            return "Connection cancelled";

        case "disconnecting":
            return "Closing the SSH session safely…";

        case "disconnected":
            return "SSH session closed";

        case "idle":
        default:
            return "";
    }
}

function getPageTitle(
    phase: ConnectionJourneyPhase,
    destinationName: string,
): string {
    switch (phase) {
        case "connected":
            return "Connection established";

        case "failed":
            return "Unable to connect";

        case "cancelled":
            return "Connection cancelled";

        case "disconnecting":
            return "Disconnecting safely";

        case "disconnected":
            return "Session closed";

        default:
            return `Connecting to ${destinationName}`;
    }
}

function getPageSubtitle(
    phase: ConnectionJourneyPhase,
): string {
    switch (phase) {
        case "connected":
            return "The secure SSH channel is ready. Opening your workspace now.";

        case "failed":
            return "The server did not accept or complete the SSH connection. Your details are still available when you go back.";

        case "cancelled":
            return "The connection was stopped before the SSH session was established.";

        case "disconnecting":
            return "Closing the active channel and cleaning up the session.";

        case "disconnected":
            return "The secure channel has been closed.";

        default:
            return "Establishing a verified, encrypted channel to your remote server.";
    }
}

function getStatusIcon(
    phase: ConnectionJourneyPhase,
) {
    switch (phase) {
        case "connected":
            return (
                <Check
                    size={14}
                    aria-hidden="true"
                />
            );

        case "failed":
            return (
                <CircleAlert
                    size={14}
                    aria-hidden="true"
                />
            );

        case "cancelled":
            return (
                <X
                    size={14}
                    aria-hidden="true"
                />
            );

        case "disconnecting":
        case "disconnected":
            return (
                <Unplug
                    size={14}
                    aria-hidden="true"
                />
            );

        case "verifying-host":
            return (
                <ShieldCheck
                    size={14}
                    aria-hidden="true"
                />
            );

        default:
            return (
                <span
                    className="ssh-journey__status-spinner"
                    aria-hidden="true"
                />
            );
    }
}

export function SshConnectionJourney({
    phase,
    profileName,
    host,
    port,
    username,
    message,
    compact = false,
    page = false,
    onBack,
    onRetry,
}: SshConnectionJourneyProps) {
    const maximumConnectionProgressRef =
        useRef(0);

    const previousPhaseRef =
        useRef<ConnectionJourneyPhase>(
            "idle",
        );

    if (phase === "idle") {
        maximumConnectionProgressRef.current =
            0;

        previousPhaseRef.current =
            phase;

        return null;
    }

    const previousPhase =
        previousPhaseRef.current;

    /*
     * A fresh attempt normally passes through idle first.
     * This additional reset makes the component safe even
     * if a future caller starts a new attempt directly from
     * a completed state.
     */
    if (
        phase === "preparing" &&
        [
            "connected",
            "failed",
            "cancelled",
            "disconnected",
        ].includes(previousPhase)
    ) {
        maximumConnectionProgressRef.current =
            0;
    }

    let progress: number;

    if (
        phase === "disconnecting" ||
        phase === "disconnected"
    ) {
        progress =
            PHASE_PROGRESS[phase];
    } else {
        maximumConnectionProgressRef.current =
            Math.max(
                maximumConnectionProgressRef.current,
                PHASE_PROGRESS[phase],
            );

        progress =
            maximumConnectionProgressRef.current;
    }

    previousPhaseRef.current =
        phase;

    const destinationName =
        profileName?.trim() ||
        host ||
        "Remote server";

    const destinationAddress =
        username && host
            ? `${username}@${host}:${port}`
            : host
                ? `${host}:${port}`
                : "Remote SSH endpoint";

    const isTerminalState =
        phase === "connected" ||
        phase === "failed" ||
        phase === "cancelled" ||
        phase === "disconnected";

    const isDisconnecting =
        phase === "disconnecting" ||
        phase === "disconnected";

    const canRecover =
        phase === "failed" ||
        phase === "cancelled" ||
        phase === "disconnected";

    const journeyPanel = (
        <section
            className={[
                "ssh-journey",
                `ssh-journey--${phase}`,
                compact
                    ? "ssh-journey--compact"
                    : "",
                page
                    ? "ssh-journey--page-card"
                    : "",
            ]
                .filter(Boolean)
                .join(" ")}
            aria-live="polite"
            aria-label={
                isDisconnecting
                    ? "SSH disconnection progress"
                    : "SSH connection progress"
            }
        >
            <div className="ssh-journey__endpoints">
                <div className="ssh-journey__endpoint ssh-journey__endpoint--local">
                    <span className="ssh-journey__endpoint-icon">
                        <Laptop
                            size={18}
                            aria-hidden="true"
                        />
                    </span>

                    <span className="ssh-journey__endpoint-copy">
                        <strong>
                            SSH Workspace
                        </strong>

                        <small>
                            This device
                        </small>
                    </span>
                </div>

                <div className="ssh-journey__endpoint ssh-journey__endpoint--remote">
                    <span className="ssh-journey__endpoint-copy">
                        <strong>
                            {destinationName}
                        </strong>

                        <small
                            title={destinationAddress}
                        >
                            {destinationAddress}
                        </small>
                    </span>

                    <span className="ssh-journey__endpoint-icon">
                        <Server
                            size={18}
                            aria-hidden="true"
                        />
                    </span>
                </div>
            </div>

            <div
                className="ssh-journey__route"
                aria-hidden="true"
            >
                <span className="ssh-journey__route-base" />

                <span
                    className="ssh-journey__route-progress"
                    style={{
                        width:
                            `${progress}%`,
                    }}
                />

                {!isTerminalState && (
                    <span
                        className="ssh-journey__packet"
                        style={{
                            left:
                                `${Math.max(
                                    7,
                                    Math.min(
                                        progress,
                                        93,
                                    ),
                                )}%`,
                        }}
                    >
                        <i />
                    </span>
                )}

                <span className="ssh-journey__route-node ssh-journey__route-node--start" />
                <span className="ssh-journey__route-node ssh-journey__route-node--end" />
            </div>

            <div className="ssh-journey__status-row">
                <span className="ssh-journey__status-icon">
                    {getStatusIcon(
                        phase,
                    )}
                </span>

                <div className="ssh-journey__status-copy">
                    <strong>
                        {message ||
                            getDefaultMessage(
                                phase,
                            )}
                    </strong>

                    {!compact && (
                        <small>
                            {isDisconnecting
                                ? "The session will disappear after the secure channel is closed."
                                : "Your terminal opens only after the real SSH connection succeeds."}
                        </small>
                    )}
                </div>
            </div>
        </section>
    );

    if (!page) {
        return journeyPanel;
    }

    return (
        <main
            className={[
                "ssh-journey-page",
                `ssh-journey-page--${phase}`,
            ].join(" ")}
        >
            <section className="ssh-journey-page__content">
                <header className="ssh-journey-page__header">
                    <span className="ssh-journey-page__badge">
                        <ShieldCheck
                            size={16}
                            aria-hidden="true"
                        />

                        Secure SSH session
                    </span>

                    <h1>
                        {getPageTitle(
                            phase,
                            destinationName,
                        )}
                    </h1>

                    <p>
                        {getPageSubtitle(
                            phase,
                        )}
                    </p>
                </header>

                {journeyPanel}

                {canRecover && (
                    <div className="ssh-journey-page__actions">
                        {onRetry && (
                            <button
                                type="button"
                                className="ssh-journey-page__retry"
                                onClick={onRetry}
                            >
                                <RotateCcw
                                    size={15}
                                    aria-hidden="true"
                                />

                                Try again
                            </button>
                        )}

                        {onBack && (
                            <button
                                type="button"
                                className="ssh-journey-page__back"
                                onClick={onBack}
                            >
                                <ArrowLeft
                                    size={15}
                                    aria-hidden="true"
                                />

                                Back to connections
                            </button>
                        )}
                    </div>
                )}

                <footer className="ssh-journey-page__footer">
                    <ShieldCheck
                        size={14}
                        aria-hidden="true"
                    />

                    Host verification and authentication are handled by the real SSH connection.
                </footer>
            </section>
        </main>
    );
}
