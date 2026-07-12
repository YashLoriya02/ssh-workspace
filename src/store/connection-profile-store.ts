import { LazyStore } from "@tauri-apps/plugin-store";

export type SavedAuthenticationType =
  | "password"
  | "privateKey";

export interface SavedConnectionProfile {
  id: string;
  name: string;

  host: string;
  port: number;
  username: string;

  authenticationType: SavedAuthenticationType;

  createdAt: string;
  updatedAt: string;
  lastConnectedAt: string | null;
}

export interface SaveConnectionProfileInput {
  id?: string;

  name: string;
  host: string;
  port: number;
  username: string;

  authenticationType: SavedAuthenticationType;
}

const store = new LazyStore(
  "ssh-connections.json",
);

const PROFILES_KEY = "connection-profiles";

function sortProfiles(
  profiles: SavedConnectionProfile[],
): SavedConnectionProfile[] {
  return [...profiles].sort(
    (first, second) => {
      const firstDate =
        first.lastConnectedAt ??
        first.updatedAt;

      const secondDate =
        second.lastConnectedAt ??
        second.updatedAt;

      return (
        new Date(secondDate).getTime() -
        new Date(firstDate).getTime()
      );
    },
  );
}

export async function loadConnectionProfiles():
Promise<SavedConnectionProfile[]> {
  const profiles =
    await store.get<SavedConnectionProfile[]>(
      PROFILES_KEY,
    );

  return sortProfiles(
    Array.isArray(profiles)
      ? profiles
      : [],
  );
}

export async function saveConnectionProfile(
  input: SaveConnectionProfileInput,
): Promise<SavedConnectionProfile> {
  const profiles =
    await loadConnectionProfiles();

  const existingProfile = input.id
    ? profiles.find(
        (profile) =>
          profile.id === input.id,
      )
    : undefined;

  const now = new Date().toISOString();

  const savedProfile: SavedConnectionProfile = {
    id:
      existingProfile?.id ??
      crypto.randomUUID(),

    name: input.name.trim(),

    host: input.host.trim(),
    port: input.port,
    username: input.username.trim(),

    authenticationType:
      input.authenticationType,

    createdAt:
      existingProfile?.createdAt ??
      now,

    updatedAt: now,

    lastConnectedAt:
      existingProfile?.lastConnectedAt ??
      null,
  };

  const updatedProfiles = [
    savedProfile,
    ...profiles.filter(
      (profile) =>
        profile.id !== savedProfile.id,
    ),
  ];

  await store.set(
    PROFILES_KEY,
    updatedProfiles,
  );

  await store.save();

  return savedProfile;
}

export async function markProfileConnected(
  profileId: string,
): Promise<void> {
  const profiles =
    await loadConnectionProfiles();

  const now = new Date().toISOString();

  const updatedProfiles = profiles.map(
    (profile) =>
      profile.id === profileId
        ? {
            ...profile,
            updatedAt: now,
            lastConnectedAt: now,
          }
        : profile,
  );

  await store.set(
    PROFILES_KEY,
    updatedProfiles,
  );

  await store.save();
}

export async function deleteConnectionProfile(
  profileId: string,
): Promise<void> {
  const profiles =
    await loadConnectionProfiles();

  await store.set(
    PROFILES_KEY,
    profiles.filter(
      (profile) =>
        profile.id !== profileId,
    ),
  );

  await store.save();
}