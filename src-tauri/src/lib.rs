use keyring::{
    Entry,
    Error as KeyringError,
};

const SSH_PASSWORD_SERVICE: &str =
    "com.sshworkspace.ssh-password";

fn create_ssh_password_entry(
    profile_id: &str,
) -> Result<Entry, String> {
    let normalized_profile_id =
        profile_id.trim();

    if normalized_profile_id.is_empty() {
        return Err(
            "Profile ID cannot be empty."
                .to_string(),
        );
    }

    Entry::new(
        SSH_PASSWORD_SERVICE,
        normalized_profile_id,
    )
    .map_err(|error| {
        format!(
            "Unable to access the operating-system credential store: {error}"
        )
    })
}

#[tauri::command]
fn save_ssh_password(
    profile_id: String,
    password: String,
) -> Result<(), String> {
    if password.is_empty() {
        return Err(
            "SSH password cannot be empty."
                .to_string(),
        );
    }

    let entry =
        create_ssh_password_entry(
            &profile_id,
        )?;

    entry
        .set_password(&password)
        .map_err(|error| {
            format!(
                "Unable to save the SSH password securely: {error}"
            )
        })
}

#[tauri::command]
fn get_ssh_password(
    profile_id: String,
) -> Result<Option<String>, String> {
    let entry =
        create_ssh_password_entry(
            &profile_id,
        )?;

    match entry.get_password() {
        Ok(password) => {
            Ok(Some(password))
        }

        Err(KeyringError::NoEntry) => {
            Ok(None)
        }

        Err(error) => {
            Err(format!(
                "Unable to read the saved SSH password: {error}"
            ))
        }
    }
}

#[tauri::command]
fn delete_ssh_password(
    profile_id: String,
) -> Result<(), String> {
    let entry =
        create_ssh_password_entry(
            &profile_id,
        )?;

    match entry.delete_credential() {
        Ok(()) => Ok(()),

        /*
         * Deleting a profile without a stored
         * password should still succeed.
         */
        Err(KeyringError::NoEntry) => {
            Ok(())
        }

        Err(error) => {
            Err(format!(
                "Unable to delete the saved SSH password: {error}"
            ))
        }
    }
}

// Learn more about Tauri commands at:
// https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!(
        "Hello, {}! You've been greeted from Rust!",
        name,
    )
}

#[cfg_attr(
    mobile,
    tauri::mobile_entry_point
)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_store::Builder::new()
                .build(),
        )
        .plugin(
            tauri_plugin_fs::init()
        )
        .plugin(
            tauri_plugin_dialog::init(),
        )
        .plugin(
            tauri_plugin_shell::init(),
        )
        .plugin(
            tauri_plugin_opener::init(),
        )
        .invoke_handler(
            tauri::generate_handler![
                greet,
                save_ssh_password,
                get_ssh_password,
                delete_ssh_password,
            ],
        )
        .run(
            tauri::generate_context!(),
        )
        .expect(
            "error while running tauri application",
        );
}