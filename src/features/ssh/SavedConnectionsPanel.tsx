import { Plus, X } from "lucide-react";
import type {
    SavedConnectionProfile,
} from "../../store/connection-profile-store";

interface SavedConnectionsPanelProps {
    profiles: SavedConnectionProfile[];
    selectedProfileId: string | null;
    loading: boolean;

    onSelect: (
        profile: SavedConnectionProfile,
    ) => void;

    onNew: () => void;

    onOpen: (
        profile: SavedConnectionProfile,
    ) => void;

    onDelete: (
        profile: SavedConnectionProfile,
    ) => void;
}

function formatLastConnected(
    value: string | null,
): string {
    if (!value) {
        return "Not connected yet";
    }

    return `Last used ${new Date(
        value,
    ).toLocaleString()}`;
}

export function SavedConnectionsPanel({
    profiles,
    selectedProfileId,
    loading,
    onSelect,
    onNew,
    onDelete,
    onOpen,
}: SavedConnectionsPanelProps) {
    return (
        <aside className="saved-connections-panel">
            <header className="saved-connections-header">
                <div>
                    <h2>Connections</h2>

                    <p>
                        Saved SSH profiles
                    </p>
                </div>

                <button
                    type="button"
                    className="new-connection-button"
                    onClick={onNew}
                    title="New connection"
                >
                    <Plus size={16} />
                </button>
            </header>

            <div className="saved-connections-list">
                {loading ? (
                    <div className="saved-connections-empty">
                        Loading connections…
                    </div>
                ) : profiles.length === 0 ? (
                    <div className="saved-connections-empty">
                        <strong>
                            No saved connections
                        </strong>

                        <span>
                            Enter server details and add a
                            profile name to save it.
                        </span>
                    </div>
                ) : (
                    profiles.map((profile) => (
                        <button
                            key={profile.id}
                            type="button"
                            className={
                                selectedProfileId ===
                                    profile.id
                                    ? "saved-connection-item saved-connection-item--selected"
                                    : "saved-connection-item"
                            }
                            onClick={() =>
                                onSelect(profile)
                            }
                            onDoubleClick={() =>
                                onOpen(profile)
                            }
                            title="Double-click to connect"
                        >
                            <span className="saved-connection-icon">
                                {profile.name
                                    .charAt(0)
                                    .toUpperCase()}
                            </span>

                            <span className="saved-connection-content">
                                <strong>
                                    {profile.name}
                                </strong>

                                <span>
                                    {profile.username}@
                                    {profile.host}:
                                    {profile.port}
                                </span>

                                <small>
                                    {formatLastConnected(
                                        profile.lastConnectedAt,
                                    )}
                                </small>
                            </span>

                            <span
                                role="button"
                                tabIndex={0}
                                className="saved-connection-delete"
                                title={`Delete ${profile.name}`}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onDelete(profile);
                                }}
                                onDoubleClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                }}
                                onKeyDown={(event) => {
                                    if (
                                        event.key === "Enter" ||
                                        event.key === " "
                                    ) {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        onDelete(profile);
                                    }
                                }}
                            >
                                <X size={16} />
                            </span>
                        </button>
                    ))
                )}
            </div>
        </aside>
    );
}