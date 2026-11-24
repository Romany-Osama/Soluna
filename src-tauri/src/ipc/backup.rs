//! IPC commands: Backup and restore (S5-003; owner `backup` in docs/ipc-commands.md)
#![allow(unused_imports)]

use crate::*;

#[tauri::command]
pub fn backup_create(state: tauri::State<'_, RuntimeState>) -> IpcResult<String> {
    let output_path = FileDialog::new()
        .set_title("Create Soluna backup")
        .add_filter("Soluna backup", &["backup"])
        .save_file()
        .ok_or_else(|| IpcError::cancelled("Backup cancelled"))?;
    let temp_db = output_path.with_extension("sqlite3.part");
    let _ = fs::remove_file(&temp_db);
    let db = state
        .db
        .lock()
        .map_err(|_| "database state poisoned".to_owned())?;
    db.execute(
        "VACUUM INTO ?1",
        params![temp_db.to_string_lossy().to_string()],
    )
    .map_err(|error| format!("database backup failed: {error}"))?;
    let settings: Vec<SettingEntry> = {
        let mut statement = db.prepare("SELECT key, value FROM settings WHERE key NOT IN ('cookie', 'dataSyncId', 'visitorData', 'accountName', 'accountEmail', 'accountChannelHandle', 'accountAvatar', 'spotifySpDc', 'spotifySpKey', 'spotifyAccessToken', 'spotifyTokenExpiry', 'spotifyUsername', 'spotifyUserId') ORDER BY key").map_err(|error| format!("backup settings query failed: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(SettingEntry {
                    key: row.get(0)?,
                    value: row.get(1)?,
                })
            })
            .map_err(|error| format!("backup settings rows failed: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("backup settings decode failed: {error}"))?
    };
    drop(db);
    let settings: Vec<SettingEntry> = settings
        .into_iter()
        .filter(|entry| allowed_setting(&entry.key))
        .collect();
    let result = (|| -> Result<(), String> {
        scrub_backup_copy(&temp_db)?;
        let file = fs::File::create(&output_path)
            .map_err(|error| format!("backup archive create failed: {error}"))?;
        let mut archive = ZipWriter::new(file);
        let options = SimpleFileOptions::default();
        archive
            .start_file("settings.json", options)
            .map_err(|error| format!("backup settings entry failed: {error}"))?;
        archive
            .write_all(
                &serde_json::to_vec_pretty(&settings)
                    .map_err(|error| format!("backup settings encode failed: {error}"))?,
            )
            .map_err(|error| format!("backup settings write failed: {error}"))?;
        archive
            .start_file("song.db", options)
            .map_err(|error| format!("backup database entry failed: {error}"))?;
        let mut database_file = fs::File::open(&temp_db)
            .map_err(|error| format!("backup database open failed: {error}"))?;
        let mut database_bytes = Vec::new();
        database_file
            .read_to_end(&mut database_bytes)
            .map_err(|error| format!("backup database read failed: {error}"))?;
        archive
            .write_all(&database_bytes)
            .map_err(|error| format!("backup database write failed: {error}"))?;
        archive
            .finish()
            .map_err(|error| format!("backup archive finalize failed: {error}"))?;
        Ok(())
    })();
    let _ = fs::remove_file(&temp_db);
    Ok(result.map(|_| output_path.to_string_lossy().to_string())?)
}

/// Crash-safe swap of the staged database into place (M6 / D3-152).
///
/// Order matters; a crash at ANY point must leave either the old live database or the restored
/// database as the live database, and startup recovery (`recover_interrupted_restore`) must be
/// able to finish or roll back from the files left behind:
/// 1. fsync the staged file, so its bytes are on disk before it can become live. A failure here
///    aborts the restore with the live database untouched.
/// 2. Write + fsync the journal, then fsync the directory: from here on, a crash is recoverable.
/// 3. Rename live -> previous. The old live database is preserved as a fallback; it is NOT
///    deleted here (D3-144 / S5-051). If the live file is already gone there is nothing to
///    preserve and the swap continues.
/// 4. Rename staged -> live. A crash between 3 and 4 leaves no live database — exactly the
///    state recovery repairs by promoting the staged file (or, if it is unusable, the previous
///    one). If this rename fails while the process is still alive, roll the first rename back.
/// 5. fsync the directory so both renames are durable, then remove the journal and fsync again.
pub(crate) fn swap_restored_database(db_path: &Path, staged_path: &Path) -> Result<(), String> {
    let previous_path = restore_previous_path(db_path);
    let journal_path = restore_journal_path(db_path);
    sync_file(staged_path)
        .map_err(|error| format!("restore staged database sync failed: {error}"))?;
    fs::write(&journal_path, "soluna restore in progress\n")
        .map_err(|error| format!("restore journal write failed: {error}"))?;
    if let Err(error) = sync_file(&journal_path) {
        let _ = fs::remove_file(&journal_path);
        return Err(format!("restore journal sync failed: {error}"));
    }
    if let Some(parent) = db_path.parent() {
        let _ = sync_dir(parent);
    }
    let moved_old = match fs::rename(db_path, &previous_path) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            let _ = fs::remove_file(&journal_path);
            return Err(format!(
                "restore could not move the live database aside: {error}"
            ));
        }
    };
    if let Err(error) = fs::rename(staged_path, db_path) {
        if moved_old {
            let _ = fs::rename(&previous_path, db_path);
        }
        let _ = fs::remove_file(&journal_path);
        return Err(format!(
            "restore could not move the staged database into place: {error}"
        ));
    }
    if let Some(parent) = db_path.parent() {
        let _ = sync_dir(parent);
    }
    let _ = fs::remove_file(&journal_path);
    if let Some(parent) = db_path.parent() {
        let _ = sync_dir(parent);
    }
    Ok(())
}

#[tauri::command]
pub fn backup_restore(state: tauri::State<'_, RuntimeState>) -> IpcResult<String> {
    let input_path = FileDialog::new()
        .set_title("Restore Soluna backup")
        .add_filter("Soluna backup", &["backup"])
        .pick_file()
        .ok_or_else(|| IpcError::cancelled("Restore cancelled"))?;
    let file =
        fs::File::open(&input_path).map_err(|error| format!("backup open failed: {error}"))?;
    let temp_db = database_path().with_extension("restore.part");
    let _ = fs::remove_file(&temp_db);
    let settings_bytes = match extract_backup(
        file,
        &temp_db,
        MAX_BACKUP_DATABASE_BYTES,
        MAX_BACKUP_SETTINGS_BYTES,
    ) {
        Ok(bytes) => bytes,
        Err(error) => {
            let _ = fs::remove_file(&temp_db);
            return Err(IpcError::from(error));
        }
    };
    let imported_settings: Vec<SettingEntry> = match serde_json::from_slice(&settings_bytes) {
        Ok(value) => value,
        Err(error) => {
            let _ = fs::remove_file(&temp_db);
            return Err(IpcError::from(format!(
                "backup settings are invalid: {error}"
            )));
        }
    };
    let candidate = match Connection::open(&temp_db) {
        Ok(connection) => connection,
        Err(error) => {
            let _ = fs::remove_file(&temp_db);
            return Err(IpcError::from(format!(
                "backup database validation failed: {error}"
            )));
        }
    };
    let integrity: String =
        match candidate.query_row("PRAGMA integrity_check", [], |row| row.get(0)) {
            Ok(value) => value,
            Err(error) => {
                drop(candidate);
                let _ = fs::remove_file(&temp_db);
                return Err(IpcError::from(format!(
                    "backup database integrity check failed: {error}"
                )));
            }
        };
    if integrity != "ok" {
        drop(candidate);
        let _ = fs::remove_file(&temp_db);
        return Err(IpcError::from(format!(
            "backup database integrity check failed: {integrity}"
        )));
    }
    let required_tables: i64 = match candidate.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('songs', 'settings', 'history', 'downloads')", [], |row| row.get(0)) {
        Ok(value) => value,
        Err(error) => { drop(candidate); let _ = fs::remove_file(&temp_db); return Err(IpcError::from(format!("backup database schema validation failed: {error}"))); }
    };
    if required_tables != 4 {
        let _ = fs::remove_file(&temp_db);
        return Err(IpcError::from(
            "backup database is missing required Soluna tables".to_owned(),
        ));
    }
    candidate
        .execute("DELETE FROM settings", [])
        .map_err(|error| format!("restored settings clear failed: {error}"))?;
    for setting in imported_settings {
        if allowed_setting(&setting.key) {
            candidate
                .execute(
                    "INSERT INTO settings (key, value) VALUES (?1, ?2)",
                    params![setting.key, setting.value],
                )
                .map_err(|error| format!("restored setting write failed: {error}"))?;
        }
    }
    candidate.execute("DELETE FROM settings WHERE key IN ('cookie', 'dataSyncId', 'visitorData', 'accountName', 'accountEmail', 'accountChannelHandle', 'accountAvatar', 'spotifySpDc', 'spotifySpKey', 'spotifyAccessToken', 'spotifyTokenExpiry', 'spotifyUsername', 'spotifyUserId')", []).map_err(|error| format!("restored auth clear failed: {error}"))?;
    drop(candidate);

    let db_path = database_path();
    let previous_path = restore_previous_path(&db_path);
    let mut db = state
        .db
        .lock()
        .map_err(|_| "database state poisoned".to_owned())?;
    let replacement = Connection::open_in_memory()
        .map_err(|error| format!("restore temporary connection failed: {error}"))?;
    let old = std::mem::replace(&mut *db, replacement);
    drop(old);
    if let Err(error) = swap_restored_database(&db_path, &temp_db) {
        // The swap rolled itself back where possible; reopen whatever is live now (the old
        // database if the rollback worked). If the live file is gone, the next launch recovers
        // it from the staged or previous file instead of starting empty.
        if let Ok(old_connection) = Connection::open(&db_path) {
            *db = old_connection;
        }
        return Err(IpcError::from(format!(
            "database restore swap failed: {error}"
        )));
    }
    match Connection::open(&db_path) {
        Ok(restored) => {
            *db = restored;
            // The previous database is deliberately kept: it is the fallback until the next
            // successful launch (D3-144 / S5-051), which retires it.
            Ok(input_path.to_string_lossy().to_string())
        }
        Err(error) => {
            let _ = fs::remove_file(&db_path);
            let _ = fs::rename(&previous_path, &db_path);
            if let Ok(old_connection) = Connection::open(&db_path) {
                *db = old_connection;
            }
            Err(IpcError::from(format!(
                "restored database reopen failed: {error}"
            )))
        }
    }
}
