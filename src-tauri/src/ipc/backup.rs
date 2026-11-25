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

/// Reopen the live database after a failed restore swap, shared by both error branches of
/// `backup_restore` (double-fault guard, M6 follow-up).
///
/// `Connection::open` creates an empty file when the path is missing, so the live database
/// must never be opened unconditionally: if it is gone, promote the previous database back
/// to live first. Returns the connection when the live database could be opened, and `None`
/// when there is nothing usable to open — the caller keeps its in-memory replacement, and
/// the next launch recovers from the previous file (or starts fresh when nothing is left).
/// No path here ever creates a file: the only creation is `Connection::open` on a path
/// already proven to exist.
pub(crate) fn reopen_live_after_failed_swap(db_path: &Path) -> Option<Connection> {
    let previous_path = restore_previous_path(db_path);
    if !db_path.exists() {
        let _ = fs::rename(&previous_path, db_path);
    }
    if !db_path.exists() {
        return None;
    }
    Connection::open(db_path).ok()
}

/// Outcome wording for a failed restore, shown to the user as the `IpcError`
/// detail (the frontend renders `"message (detail)"`).
///
/// The accurate claims are whether the requested restore became active and
/// whether the previous library is usable and in use — not whether anything
/// "was saved": the attempt did write files (the staged extraction, the
/// journal, the swap renames, the migration statements), and in most outcomes
/// the existing library data is intact. So there is no blanket "nothing was
/// saved" and no vague "did not land"; every variant says the restore did not
/// become active, states the library's state, and front-loads the restart or
/// retry action where one is needed.
///
/// Length budget: `IpcError::with_detail` runs the text through `sanitize`,
/// which caps it at 200 characters (`MAX_MESSAGE_CHARS`). The wordings below
/// are kept within that cap so they reach the user intact — a longer wording
/// would be cut mid-sentence by sanitize (the review's first drafts, at 250–
/// 335 characters, were trimmed to fit for exactly this reason). Do not
/// lengthen them past 200 characters without checking the cap; the outcome
/// test pins the cap.
///
/// Visible-prefix budget: the settings screen shows the notice as
/// `"Backup could not be restored: {summary} ({detail})"`, and
/// `noticeSummary` truncates the visible text to 177 characters (full text
/// on hover). The longest summary is the migration one (41 chars), and it
/// can pair with ANY outcome — the migration branch's rollback selects the
/// outcome, so V3/V4 occur with the migration summary too, not only with
/// the reopen one (31). The visible detail window is therefore 104
/// characters for every outcome, and the wordings below are written so
/// that, for every outcome, the visible prefix already says (a) whether
/// the restore became active, (b) whether the previous library is usable
/// and in use, and (c) whether a restart or retry is needed — the rest
/// (the nothing-saved warning, the backup-unchanged note, the "if it does
/// not load" condition) lives past the cut, on hover. Do not lengthen the
/// visible part past the window; the frontend visible-prefix test pins it.
///
/// `reconnected` is whether the session is back on the original live
/// database; `had_previous` is whether a previous database existed to roll
/// back to; `renamed_back` is whether that previous database ended up back
/// at the live path. Exposed `pub(crate)` so the wording each combination
/// selects is pinned by a test.
///
/// Callers must only pass `reconnected = true` when the reopened connection
/// is PROVEN to be the original library. A bare successful open proves
/// nothing about provenance: `Connection::open` creates an empty file when
/// the path is missing, and here the live path may still hold the staged
/// database. The rollback branches guarantee this through
/// `rollback_failure_outcome`, which selects the honest unknown outcome
/// when the rollback cannot prove the original; the swap branch guarantees
/// it by construction (the staged file never reached the live path when the
/// swap fails, so any live file that opens there is the original); the
/// temporary-connection arm guarantees it because the swap never ran.
pub(crate) fn failed_restore_outcome(
    reconnected: bool,
    had_previous: bool,
    renamed_back: bool,
) -> &'static str {
    if reconnected {
        "The restore did not become active. Library unchanged and still in use. Retry from the backup; no restart. The backup file was not changed."
    } else if !had_previous {
        "Restart Soluna: restore did not become active; no previous library; library is empty. Retry from backup. Nothing you save now will be kept. The backup file was not changed."
    } else if renamed_back {
        "Restart Soluna: restore did not become active; at the live location; not reconnected. Retry from backup. If it does not load, retry from the backup. The backup file was not changed."
    } else {
        "Restart Soluna: restore did not become active; previous database kept; not put back. Retry from backup. Soluna could not reconnect. If it does not load, retry from the backup."
    }
}

/// A failed restore, split into the parts the UI needs separately.
///
/// `message` is the full error text (context + underlying error), e.g.
/// "restored database schema migration failed: UNIQUE constraint failed:
/// search_history.query". It is fed to `IpcError::from`, which logs the full
/// text (redacted) and shows only the summary — the text before the first
/// `": "` — so the raw SQLite error never reaches the UI. `outcome` is the
/// UI-safe guidance from `failed_restore_outcome` (whether the restore became
/// active, whether the previous library is usable and in use, and what to do
/// next); it is attached as the `IpcError` detail, which the frontend renders
/// as `"message (detail)"`. The outcome is kept separate from the message
/// because appending it to one string would still be truncated by
/// `IpcError::from`'s summary, and the guidance would never reach the user.
#[derive(Debug)]
pub(crate) struct RestoreFailure {
    pub message: String,
    pub outcome: &'static str,
}

impl RestoreFailure {
    /// Convert to the error the command returns, the same way `backup_restore`
    /// does: the summary as the message (the raw underlying error is logged,
    /// never shown) and the outcome as the detail.
    pub(crate) fn into_ipc_error(self) -> IpcError {
        IpcError::from(self.message).with_detail(self.outcome)
    }
}

// Test-only injection for the two file operations inside
// `rollback_failed_restore`: force the remove of the staged content from
// the live path to fail, and/or force the rename-back of the previous
// database to fail. Both flags default to false (no injection).
//
// This stages the Windows-lock fault — antivirus or an indexer holding
// the live file, so the remove fails and the rename-back fails too — which
// the OS cannot be made to produce deterministically in a unit test on any
// platform that runs this suite: this environment runs as root (root
// bypasses directory permission checks, so a read-only directory does not
// block the remove — verified: unlink succeeds in a `chmod 555`
// directory), `chattr +i` is not permitted on this filesystem, and on
// Windows a read-only directory does not block deletion at all (deletion
// is governed by the file, not the directory). Holding the file open does
// not help either: on Linux an open file descriptor does not block unlink,
// and on Windows it would block the reopen as well, so the fault's
// signature (remove fails, rename fails, reopen succeeds) could not be
// staged. The injection stages ONLY the two file-operation results; the
// rollback, the reopen and every assertion execute for real, on real
// files. It is `#[cfg(test)]` throughout and compiled out of non-test
// builds entirely. Thread-local, so parallel tests cannot interfere: each
// test runs on its own thread and the flags are reset by the test right
// after the rollback call.
#[cfg(test)]
thread_local! {
    static INJECT_ROLLBACK_FAILURES: std::cell::Cell<(bool, bool)> =
        const { std::cell::Cell::new((false, false)) };
}

/// Stage the remove / rename failures inside `rollback_failed_restore`
/// (test only; see the comment on `INJECT_ROLLBACK_FAILURES`).
#[cfg(test)]
pub(crate) fn inject_rollback_failures(remove_fails: bool, rename_fails: bool) {
    INJECT_ROLLBACK_FAILURES.with(|flags| flags.set((remove_fails, rename_fails)));
}

/// Remove the staged content from the live path as part of a failed-restore
/// rollback. Returns whether the remove succeeded. In tests, a staged
/// remove failure returns `false` without touching the file.
fn remove_live_for_rollback(db_path: &Path) -> bool {
    #[cfg(test)]
    if INJECT_ROLLBACK_FAILURES.with(|flags| flags.get().0) {
        return false;
    }
    fs::remove_file(db_path).is_ok()
}

/// Rename the previous database back to the live path as part of a
/// failed-restore rollback. Returns whether the rename succeeded. In tests,
/// a staged rename failure returns `false` without touching the files.
fn rename_previous_for_rollback(previous_path: &Path, db_path: &Path) -> bool {
    #[cfg(test)]
    if INJECT_ROLLBACK_FAILURES.with(|flags| flags.get().1) {
        return false;
    }
    fs::rename(previous_path, db_path).is_ok()
}

/// The facts a failed-restore rollback establishes about the live path,
/// derived from the file-operation results — never from the bare fact that
/// a connection happened to open.
///
/// `reconnected` is whether a connection to the live path was opened and
/// installed in the session. On its own it says nothing about WHICH
/// database that connection is to: when the remove failed and the
/// rename-back failed, the live path still holds the staged (restored,
/// un-migrated) database, yet the reopen succeeds — so `reconnected` is
/// true while the library in use is the restored database, not the
/// original. `removed_staged` and `renamed_back` are what pin the
/// provenance down (see `rollback_failure_outcome`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RollbackFacts {
    /// A connection to the live path was opened and installed.
    pub reconnected: bool,
    /// A previous database existed before the rollback.
    pub had_previous: bool,
    /// The previous database ended up back at the live path.
    pub renamed_back: bool,
    /// The staged content was removed from the live path.
    pub removed_staged: bool,
}

/// Select the outcome wording for a failed-restore rollback from the facts
/// `rollback_failed_restore` established.
///
/// The case the four `failed_restore_outcome` variants do not cover: the
/// session reconnected, but the live path still holds the staged (restored,
/// un-migrated) database — the remove failed and the rename-back failed, so
/// nothing replaced it. Reporting "Library unchanged and still in use. No
/// restart." there would be false. That case selects the honest unknown
/// outcome instead: the restore did not become active, the library in use
/// is unconfirmed, restart and retry.
///
/// Every other combination delegates to `failed_restore_outcome`, whose
/// `reconnected` parameter is only ever true there when the reopened
/// connection is proven to be the original library: either the rename-back
/// put the previous database at the live path — on Linux the rename
/// overwrites the destination, on Windows it succeeds only when the
/// destination is absent, so either way the previous database ends up at
/// the live path — or the remove succeeded and the reopen helper's retry
/// rename did, the only way the live path can exist again after a
/// successful remove (the helper only opens a path already proven to
/// exist).
pub(crate) fn rollback_failure_outcome(facts: &RollbackFacts) -> &'static str {
    if facts.reconnected && !facts.removed_staged && !facts.renamed_back {
        "Restart Soluna: restore did not become active; the library in use is unconfirmed. Retry from backup. The backup file was not changed."
    } else {
        failed_restore_outcome(facts.reconnected, facts.had_previous, facts.renamed_back)
    }
}

/// Roll back a failed restore after the swap: remove the staged content now
/// at the live path, rename the previous database back, and reconnect the
/// session to it. Returns the facts the error wording needs (see
/// `RollbackFacts`): whether the session reconnected, whether a previous
/// database existed, whether it ended up back at the live path, and whether
/// the staged content was removed from the live path. The remove's result
/// is recorded, not ignored: when it fails AND the rename-back fails, the
/// live path still holds the staged database, and the outcome must say so
/// (see `rollback_failure_outcome`) instead of claiming the original library
/// is in use.
///
/// Shared by the migration-failure and reopen-failure branches (they are the
/// same rollback; only the error prefix differs), so the reopen branch's file
/// operations are literally the code Case A and Case B execute. Must NOT be
/// used by the swap-failure branch: there `db_path` may hold the original
/// live file, which must never be removed. No path here deletes the previous
/// database or the backup archive: the previous file is only ever renamed,
/// and the only removal is the staged content at the live path.
pub(crate) fn rollback_failed_restore(
    db_path: &Path,
    previous_path: &Path,
    db: &mut Connection,
) -> RollbackFacts {
    // The staged content now at the live path is not an original: it is
    // removed, and the previous database is renamed back. The explicit rename
    // is belt-and-braces — `reopen_live_after_failed_swap` does the same
    // rename when the live file is missing — and its result is recorded, with
    // whether a previous database existed at all, so the error can say whether
    // the original library was kept and whether a restart is required.
    let had_previous = previous_path.exists();
    let removed_staged = remove_live_for_rollback(db_path);
    let renamed_back = rename_previous_for_rollback(previous_path, db_path);
    let reconnected = if let Some(old_connection) = reopen_live_after_failed_swap(db_path) {
        *db = old_connection;
        true
    } else {
        false
    };
    RollbackFacts {
        reconnected,
        had_previous,
        renamed_back,
        removed_staged,
    }
}

/// Swap the staged database into place and migrate it before it is used.
///
/// Extracted from `backup_restore` (M7 follow-up) so the failure paths are
/// unit-testable: the command itself cannot be driven in a test because it opens
/// a native file dialog. The behaviour is identical to the inline code it
/// replaces — the caller keeps the dialog, extraction, validation, and
/// settings rewrite, and this function does the rest: swap the live connection
/// for a bare in-memory placeholder, swap the staged file into place, open the
/// restored database, and run `initialize_database` on it. A migration failure
/// rolls the swap back to the previous database like a reopen failure; when
/// there is no previous database the caller keeps the in-memory placeholder
/// and the next launch recovers. A failed rollback or reopen never deletes or
/// overwrites the backup archive (it is only read) or the previous database
/// (it is renamed back, not deleted).
///
/// On failure the returned `RestoreFailure` carries the message and the
/// outcome separately: `backup_restore` turns them into an `IpcError` whose
/// message is the short summary and whose detail is the outcome guidance, so
/// the user sees both.
pub(crate) fn swap_and_activate_restored_database(
    db_path: &Path,
    temp_db: &Path,
    db: &mut Connection,
) -> Result<(), RestoreFailure> {
    let previous_path = restore_previous_path(db_path);
    let replacement = Connection::open_in_memory().map_err(|error| RestoreFailure {
        // The swap never ran, so the original library is untouched and still
        // in use: the "reconnected" outcome describes this exactly.
        message: format!("restore temporary connection failed: {error}"),
        outcome: failed_restore_outcome(true, true, true),
    })?;
    let old = std::mem::replace(db, replacement);
    drop(old);
    if let Err(error) = swap_restored_database(db_path, temp_db) {
        // The swap rolled itself back where possible; reopen whatever is live now (the old
        // database if the rollback worked). If the live file is gone, the next launch recovers
        // it from the staged or previous file instead of starting empty.
        // The same three facts as the other branches, so the error says whether the original
        // library was kept and whether a restart is required. Do NOT remove db_path here:
        // unlike the migration/reopen branches the swap may have failed before moving
        // anything, so db_path may hold the ORIGINAL live file — deleting it would destroy
        // the original. Only attempt the rename-back when live is missing, and let
        // reopen_live_after_failed_swap retry it. `reconnected` here already means back on
        // the original library — the swap failed, so the staged file never reached the live
        // path and any live file that opens is the original (or the previous database
        // promoted back) — so `failed_restore_outcome` is used directly, and no remove
        // ever runs in this branch.
        let had_previous = previous_path.exists();
        let renamed_back = if !db_path.exists() {
            fs::rename(&previous_path, db_path).is_ok()
        } else {
            false
        };
        let reconnected = if let Some(old_connection) = reopen_live_after_failed_swap(db_path) {
            *db = old_connection;
            true
        } else {
            false
        };
        return Err(RestoreFailure {
            message: format!("database restore swap failed: {error}"),
            outcome: failed_restore_outcome(reconnected, had_previous, renamed_back),
        });
    }
    match Connection::open(db_path) {
        Ok(restored) => {
            // The initializer never ran after a restore (M7): an older backup can
            // lack columns added since it was written, and the app would fail later
            // with `no such column` in this very session. Migrate the restored
            // database in place before it is used; a migration failure rolls the
            // swap back to the previous database like a reopen failure.
            if let Err(error) = initialize_database(&restored, &secrets::KeyringStore) {
                drop(restored);
                let facts = rollback_failed_restore(db_path, &previous_path, db);
                return Err(RestoreFailure {
                    message: format!("restored database schema migration failed: {error}"),
                    outcome: rollback_failure_outcome(&facts),
                });
            }
            *db = restored;
            // The previous database is deliberately kept: it is the fallback until the next
            // successful launch (D3-144 / S5-051), which retires it.
            Ok(())
        }
        Err(error) => {
            // Same rollback as the migration-failure branch, via the shared
            // function — so this branch's file operations are literally the
            // code Case A and Case B execute.
            let facts = rollback_failed_restore(db_path, &previous_path, db);
            Err(RestoreFailure {
                message: format!("restored database reopen failed: {error}"),
                outcome: rollback_failure_outcome(&facts),
            })
        }
    }
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
    // Full restore validation (M7): integrity, schema version, no triggers, and
    // every table with the columns the initializer cannot add. The old inline
    // check here — integrity plus a count of four tables — accepted an old backup
    // missing a table or a column, and a hand-crafted file carrying a trigger.
    if !restored_database_is_valid(&temp_db) {
        let _ = fs::remove_file(&temp_db);
        return Err(IpcError::from(
            "backup database failed validation: integrity, schema, version or triggers".to_owned(),
        ));
    }
    let candidate = match Connection::open(&temp_db) {
        Ok(connection) => connection,
        Err(error) => {
            let _ = fs::remove_file(&temp_db);
            return Err(IpcError::from(format!(
                "backup database validation failed: {error}"
            )));
        }
    };
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
    let mut db = state
        .db
        .lock()
        .map_err(|_| "database state poisoned".to_owned())?;
    swap_and_activate_restored_database(&db_path, &temp_db, &mut db)
        .map_err(RestoreFailure::into_ipc_error)?;
    Ok(input_path.to_string_lossy().to_string())
}
