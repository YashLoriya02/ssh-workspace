import { LazyStore } from "@tauri-apps/plugin-store";

export interface KnownHostRecord {
    id: string;

    host: string;
    port: number;

    keyType: string;
    fingerprint: string;

    createdAt: string;
    lastVerifiedAt: string;
}

export interface SaveKnownHostInput {
    host: string;
    port: number;
    keyType: string;
    fingerprint: string;
}

const knownHostsStore = new LazyStore(
    "known-hosts.json",
);

const KNOWN_HOSTS_KEY = "known-hosts";

function normalizeHost(host: string): string {
    return host.trim().toLowerCase();
}

function createKnownHostId(
    host: string,
    port: number,
): string {
    return `${normalizeHost(host)}|${port}`;
}

async function loadKnownHosts():
    Promise<KnownHostRecord[]> {
    const storedHosts =
        await knownHostsStore.get<KnownHostRecord[]>(
            KNOWN_HOSTS_KEY,
        );

    return Array.isArray(storedHosts)
        ? storedHosts
        : [];
}

export async function loadKnownHost(
    host: string,
    port: number,
): Promise<KnownHostRecord | null> {
    const id = createKnownHostId(
        host,
        port,
    );

    const knownHosts =
        await loadKnownHosts();

    return (
        knownHosts.find(
            (knownHost) =>
                knownHost.id === id,
        ) ?? null
    );
}

export async function saveKnownHost(
    input: SaveKnownHostInput,
): Promise<KnownHostRecord> {
    const knownHosts =
        await loadKnownHosts();

    const id = createKnownHostId(
        input.host,
        input.port,
    );

    const existingHost =
        knownHosts.find(
            (knownHost) =>
                knownHost.id === id,
        );

    const now = new Date().toISOString();

    const savedHost: KnownHostRecord = {
        id,

        host: normalizeHost(input.host),
        port: input.port,

        keyType: input.keyType,
        fingerprint: input.fingerprint,

        createdAt:
            existingHost?.createdAt ??
            now,

        lastVerifiedAt: now,
    };

    await knownHostsStore.set(
        KNOWN_HOSTS_KEY,
        [
            savedHost,
            ...knownHosts.filter(
                (knownHost) =>
                    knownHost.id !== id,
            ),
        ],
    );

    await knownHostsStore.save();

    return savedHost;
}

export async function markKnownHostVerified(
    host: string,
    port: number,
): Promise<void> {
    const knownHosts =
        await loadKnownHosts();

    const id = createKnownHostId(
        host,
        port,
    );

    const now = new Date().toISOString();

    const updatedHosts =
        knownHosts.map((knownHost) =>
            knownHost.id === id
                ? {
                    ...knownHost,
                    lastVerifiedAt: now,
                }
                : knownHost,
        );

    await knownHostsStore.set(
        KNOWN_HOSTS_KEY,
        updatedHosts,
    );

    await knownHostsStore.save();
}

export async function deleteKnownHost(
    host: string,
    port: number,
): Promise<void> {
    const knownHosts =
        await loadKnownHosts();

    const id = createKnownHostId(
        host,
        port,
    );

    await knownHostsStore.set(
        KNOWN_HOSTS_KEY,
        knownHosts.filter(
            (knownHost) =>
                knownHost.id !== id,
        ),
    );

    await knownHostsStore.save();
}
