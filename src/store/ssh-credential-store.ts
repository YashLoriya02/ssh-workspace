import {
    invoke,
} from "@tauri-apps/api/core";

function requireProfileId(
    profileId: string,
): string {
    const normalizedProfileId =
        profileId.trim();

    if (!normalizedProfileId) {
        throw new Error(
            "Profile ID cannot be empty.",
        );
    }

    return normalizedProfileId;
}

export async function saveSshPassword(
    profileId: string,
    password: string,
): Promise<void> {
    if (!password) {
        throw new Error(
            "SSH password cannot be empty.",
        );
    }

    await invoke<void>(
        "save_ssh_password",
        {
            profileId:
                requireProfileId(
                    profileId,
                ),

            password,
        },
    );
}

export async function loadSshPassword(
    profileId: string,
): Promise<string | null> {
    return invoke<string | null>(
        "get_ssh_password",
        {
            profileId:
                requireProfileId(
                    profileId,
                ),
        },
    );
}

export async function deleteSshPassword(
    profileId: string,
): Promise<void> {
    await invoke<void>(
        "delete_ssh_password",
        {
            profileId:
                requireProfileId(
                    profileId,
                ),
        },
    );
}