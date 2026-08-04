import {
    useEffect,
    useState,
    type FormEvent,
} from "react";

import {
    Eye,
    EyeOff,
    KeyRound,
    Server,
    X,
} from "lucide-react";

import type {
    SftpSavedServerOption,
} from "./sftp-types";

export type SftpSavedServerCredentials =
    | {
        type: "password";
        password: string;
        rememberPassword: boolean;
    }
    | {
        type: "privateKey";
        privateKey: string;
        passphrase: string;
    };

interface SftpSavedServerCredentialDialogProps {
    server:
        SftpSavedServerOption | null;

    errorMessage: string;
    isSubmitting: boolean;

    onCancel: () => void;

    onSubmit: (
        credentials:
            SftpSavedServerCredentials,
    ) => void;
}

export function SftpSavedServerCredentialDialog({
    server,
    errorMessage,
    isSubmitting,
    onCancel,
    onSubmit,
}: SftpSavedServerCredentialDialogProps) {
    const [password, setPassword] =
        useState("");

    const [rememberPassword, setRememberPassword] =
        useState(true);

    const [privateKey, setPrivateKey] =
        useState("");

    const [passphrase, setPassphrase] =
        useState("");

    const [passwordVisible, setPasswordVisible] =
        useState(false);

    useEffect(() => {
        setPassword("");
        setRememberPassword(true);
        setPrivateKey("");
        setPassphrase("");
        setPasswordVisible(false);
    }, [server?.id]);

    if (!server) {
        return null;
    }

    const isPassword =
        server.authenticationType ===
        "password";

    const canSubmit =
        !isSubmitting &&
        (
            isPassword
                ? password.length > 0
                : privateKey.trim().length > 0
        );

    function handleSubmit(
        event: FormEvent<HTMLFormElement>,
    ): void {
        event.preventDefault();

        if (!canSubmit) {
            return;
        }

        if (isPassword) {
            onSubmit({
                type: "password",
                password,
                rememberPassword,
            });

            return;
        }

        onSubmit({
            type: "privateKey",
            privateKey,
            passphrase,
        });
    }

    return (
        <div
            className="sftp-saved-server-dialog-backdrop"
            role="presentation"
            onMouseDown={(event) => {
                if (
                    event.target ===
                    event.currentTarget &&
                    !isSubmitting
                ) {
                    onCancel();
                }
            }}
        >
            <section
                className="sftp-saved-server-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="sftp-saved-server-dialog-title"
            >
                <header className="sftp-saved-server-dialog__header">
                    <span className="sftp-saved-server-dialog__icon">
                        {isPassword ? (
                            <Server
                                size={19}
                                aria-hidden="true"
                            />
                        ) : (
                            <KeyRound
                                size={19}
                                aria-hidden="true"
                            />
                        )}
                    </span>

                    <div>
                        <h2 id="sftp-saved-server-dialog-title">
                            Connect to {server.name}
                        </h2>

                        <p>
                            {server.username}@{server.host}
                            {server.port !== 22
                                ? `:${server.port}`
                                : ""}
                        </p>
                    </div>

                    <button
                        type="button"
                        className="sftp-saved-server-dialog__close"
                        onClick={onCancel}
                        disabled={isSubmitting}
                        aria-label="Close connection dialog"
                    >
                        <X
                            size={17}
                            aria-hidden="true"
                        />
                    </button>
                </header>

                <form
                    className="sftp-saved-server-dialog__form"
                    onSubmit={handleSubmit}
                >
                    {isPassword ? (
                        <label>
                            <span>Password</span>

                            <div className="sftp-saved-server-dialog__password-field">
                                <input
                                    autoFocus
                                    type={
                                        passwordVisible
                                            ? "text"
                                            : "password"
                                    }
                                    value={password}
                                    onChange={(event) =>
                                        setPassword(
                                            event.target.value,
                                        )
                                    }
                                    disabled={isSubmitting}
                                    autoComplete="current-password"
                                />

                                <button
                                    type="button"
                                    onClick={() =>
                                        setPasswordVisible(
                                            (current) =>
                                                !current,
                                        )
                                    }
                                    disabled={isSubmitting}
                                    aria-label={
                                        passwordVisible
                                            ? "Hide password"
                                            : "Show password"
                                    }
                                >
                                    {passwordVisible ? (
                                        <EyeOff
                                            size={16}
                                            aria-hidden="true"
                                        />
                                    ) : (
                                        <Eye
                                            size={16}
                                            aria-hidden="true"
                                        />
                                    )}
                                </button>
                            </div>
                        </label>
                    ) : (
                        <>
                            <label>
                                <span>Private key</span>

                                <textarea
                                    autoFocus
                                    value={privateKey}
                                    onChange={(event) =>
                                        setPrivateKey(
                                            event.target.value,
                                        )
                                    }
                                    disabled={isSubmitting}
                                    rows={8}
                                    spellCheck={false}
                                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                                />
                            </label>

                            <label>
                                <span>
                                    Passphrase
                                    <small>Optional</small>
                                </span>

                                <input
                                    type="password"
                                    value={passphrase}
                                    onChange={(event) =>
                                        setPassphrase(
                                            event.target.value,
                                        )
                                    }
                                    disabled={isSubmitting}
                                    autoComplete="off"
                                />
                            </label>
                        </>
                    )}

                    {isPassword && (
                        <label className="sftp-saved-server-dialog__remember">
                            <input
                                type="checkbox"
                                checked={rememberPassword}
                                onChange={(event) =>
                                    setRememberPassword(
                                        event.target.checked,
                                    )
                                }
                                disabled={isSubmitting}
                            />

                            <span>
                                Save password securely for future connections
                            </span>
                        </label>
                    )}

                    {errorMessage && (
                        <div className="sftp-saved-server-dialog__error">
                            {errorMessage}
                        </div>
                    )}

                    <footer className="sftp-saved-server-dialog__actions">
                        <button
                            type="button"
                            onClick={onCancel}
                            disabled={isSubmitting}
                        >
                            Cancel
                        </button>

                        <button
                            type="submit"
                            className="sftp-saved-server-dialog__primary"
                            disabled={!canSubmit}
                        >
                            {isSubmitting
                                ? "Connecting…"
                                : "Connect"}
                        </button>
                    </footer>
                </form>
            </section>
        </div>
    );
}
